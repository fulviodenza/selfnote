//! Email/password authentication, JWT issuance, and the `AuthUser` extractor.

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::extract::{FromRef, FromRequestParts, Path, State};
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use selfnote_common::AccessClaims;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::FromRow;
use uuid::Uuid;

use crate::error::{ApiResult, AppError};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct Credentials {
    pub email: String,
    pub password: String,
    #[serde(default)]
    pub display_name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AuthResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub user_id: Uuid,
    pub email: String,
}

/// Authenticated user, extracted from a `Authorization: Bearer <jwt>` header.
pub struct AuthUser {
    pub id: Uuid,
    /// Kept for handlers/logging that key off the caller's email.
    #[allow(dead_code)]
    pub email: String,
}

#[axum::async_trait]
impl<S> FromRequestParts<S> for AuthUser
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let app = AppState::from_ref(state);
        let header = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or(AppError::Unauthorized)?;
        let token = header.strip_prefix("Bearer ").ok_or(AppError::Unauthorized)?;

        // Personal access tokens ("snp_…") authenticate headless integrations
        // (the MCP server, scripts). Look them up by hash and stamp last-used so
        // users can see which tokens are live.
        if token.starts_with("snp_") {
            let hash = sha256_hex(token);
            let row: Option<(Uuid, String)> = sqlx::query_as(
                "update api_tokens set last_used_at = now() from users \
                 where api_tokens.token_hash = $1 and users.id = api_tokens.user_id \
                 returning api_tokens.user_id, users.email",
            )
            .bind(&hash)
            .fetch_optional(&app.pool)
            .await?;
            let (id, email) = row.ok_or(AppError::Unauthorized)?;
            return Ok(AuthUser { id, email });
        }

        let claims: AccessClaims =
            selfnote_common::verify(token, &app.jwt_secret).map_err(|_| AppError::Unauthorized)?;
        let id = Uuid::parse_str(&claims.sub).map_err(|_| AppError::Unauthorized)?;
        Ok(AuthUser {
            id,
            email: claims.email,
        })
    }
}

fn hash_password(password: &str) -> ApiResult<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| AppError::Other(anyhow::anyhow!("hash error: {e}")))
}

fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash)
        .map(|parsed| Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok())
        .unwrap_or(false)
}

fn issue_access_token(state: &AppState, user_id: Uuid, email: &str) -> ApiResult<String> {
    let now = Utc::now().timestamp() as usize;
    let claims = AccessClaims {
        sub: user_id.to_string(),
        email: email.to_string(),
        iat: now,
        exp: now + state.access_ttl,
    };
    selfnote_common::sign(&claims, &state.jwt_secret)
        .map_err(|e| AppError::Other(anyhow::anyhow!("jwt sign: {e}")))
}

fn random_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex::encode(hasher.finalize())
}

async fn mint_refresh_token(state: &AppState, user_id: Uuid) -> ApiResult<String> {
    let token = random_token();
    let hash = sha256_hex(&token);
    let expires = Utc::now() + chrono::Duration::days(30);
    sqlx::query("insert into refresh_tokens (user_id, token_hash, expires_at) values ($1, $2, $3)")
        .bind(user_id)
        .bind(&hash)
        .bind(expires)
        .execute(&state.pool)
        .await?;
    Ok(token)
}

pub async fn register(
    State(state): State<AppState>,
    Json(body): Json<Credentials>,
) -> ApiResult<Json<AuthResponse>> {
    if body.email.trim().is_empty() || body.password.len() < 8 {
        return Err(AppError::BadRequest(
            "email required and password must be at least 8 characters".into(),
        ));
    }
    let hash = hash_password(&body.password)?;
    let display = body.display_name.unwrap_or_default();

    let row: Result<(Uuid,), sqlx::Error> = sqlx::query_as(
        "insert into users (email, password_hash, display_name) values ($1, $2, $3) returning id",
    )
    .bind(body.email.trim())
    .bind(&hash)
    .bind(&display)
    .fetch_one(&state.pool)
    .await;

    let user_id = match row {
        Ok((id,)) => id,
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
            return Err(AppError::Conflict("email already registered".into()))
        }
        Err(e) => return Err(e.into()),
    };

    let access_token = issue_access_token(&state, user_id, body.email.trim())?;
    let refresh_token = mint_refresh_token(&state, user_id).await?;
    Ok(Json(AuthResponse {
        access_token,
        refresh_token,
        user_id,
        email: body.email.trim().to_string(),
    }))
}

pub async fn login(
    State(state): State<AppState>,
    Json(body): Json<Credentials>,
) -> ApiResult<Json<AuthResponse>> {
    let row: Option<(Uuid, String, String)> =
        sqlx::query_as("select id, email, password_hash from users where email = $1")
            .bind(body.email.trim())
            .fetch_optional(&state.pool)
            .await?;

    let (user_id, email, password_hash) = row.ok_or(AppError::Unauthorized)?;
    if !verify_password(&body.password, &password_hash) {
        return Err(AppError::Unauthorized);
    }

    let access_token = issue_access_token(&state, user_id, &email)?;
    let refresh_token = mint_refresh_token(&state, user_id).await?;
    Ok(Json(AuthResponse {
        access_token,
        refresh_token,
        user_id,
        email,
    }))
}

#[derive(Debug, Deserialize)]
pub struct RefreshRequest {
    pub refresh_token: String,
}

pub async fn refresh(
    State(state): State<AppState>,
    Json(body): Json<RefreshRequest>,
) -> ApiResult<Json<AuthResponse>> {
    let hash = sha256_hex(&body.refresh_token);
    let row: Option<(Uuid, Uuid)> = sqlx::query_as(
        "select rt.id, rt.user_id from refresh_tokens rt \
         where rt.token_hash = $1 and rt.expires_at > now()",
    )
    .bind(&hash)
    .fetch_optional(&state.pool)
    .await?;

    let (token_id, user_id) = row.ok_or(AppError::Unauthorized)?;

    // Rotate: delete the used token, mint a fresh pair.
    sqlx::query("delete from refresh_tokens where id = $1")
        .bind(token_id)
        .execute(&state.pool)
        .await?;

    let email: (String,) = sqlx::query_as("select email from users where id = $1")
        .bind(user_id)
        .fetch_one(&state.pool)
        .await?;

    let access_token = issue_access_token(&state, user_id, &email.0)?;
    let refresh_token = mint_refresh_token(&state, user_id).await?;
    Ok(Json(AuthResponse {
        access_token,
        refresh_token,
        user_id,
        email: email.0,
    }))
}

/* --------------------------------------------- personal access tokens --- */

#[derive(Debug, Deserialize)]
pub struct CreateTokenReq {
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct CreatedToken {
    pub id: Uuid,
    pub name: String,
    /// The plaintext token — shown exactly once, never stored.
    pub token: String,
    pub created_at: DateTime<Utc>,
}

/// Mint a personal access token for the caller (used to connect the MCP server
/// or scripts). The plaintext is returned once here and only its hash is kept.
pub async fn create_token(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<CreateTokenReq>,
) -> ApiResult<Json<CreatedToken>> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("token name is required".into()));
    }
    let token = format!("snp_{}", random_token());
    let hash = sha256_hex(&token);
    let row: (Uuid, DateTime<Utc>) = sqlx::query_as(
        "insert into api_tokens (user_id, name, token_hash) values ($1, $2, $3) \
         returning id, created_at",
    )
    .bind(user.id)
    .bind(name)
    .bind(&hash)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(CreatedToken {
        id: row.0,
        name: name.to_string(),
        token,
        created_at: row.1,
    }))
}

#[derive(Debug, Serialize, FromRow)]
pub struct TokenInfo {
    pub id: Uuid,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
}

pub async fn list_tokens(
    State(state): State<AppState>,
    user: AuthUser,
) -> ApiResult<Json<Vec<TokenInfo>>> {
    let rows: Vec<TokenInfo> = sqlx::query_as(
        "select id, name, created_at, last_used_at from api_tokens \
         where user_id = $1 order by created_at desc",
    )
    .bind(user.id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

pub async fn delete_token(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let res = sqlx::query("delete from api_tokens where id = $1 and user_id = $2")
        .bind(id)
        .bind(user.id)
        .execute(&state.pool)
        .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

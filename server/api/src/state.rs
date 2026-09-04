//! Shared application state and configuration.

use sqlx::PgPool;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    /// Secret for user access/refresh JWTs.
    pub jwt_secret: Vec<u8>,
    /// Secret for short-lived room tokens (verified by the sync server).
    pub room_secret: Vec<u8>,
    /// Access token lifetime in seconds.
    pub access_ttl: usize,
    /// Room token lifetime in seconds.
    pub room_ttl: usize,
}

impl AppState {
    pub fn from_env(pool: PgPool) -> anyhow::Result<Self> {
        let jwt_secret = std::env::var("JWT_SECRET")
            .unwrap_or_else(|_| "dev-insecure-jwt-secret".to_string())
            .into_bytes();
        let room_secret = std::env::var("ROOM_SECRET")
            .unwrap_or_else(|_| "dev-insecure-room-secret".to_string())
            .into_bytes();
        // Room tokens are verified at WebSocket connect. The TTL must outlast a
        // normal editing session so automatic reconnects still authenticate.
        let room_ttl = std::env::var("ROOM_TTL")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(8 * 60 * 60); // 8 hours

        Ok(Self {
            pool,
            jwt_secret,
            room_secret,
            access_ttl: 60 * 60, // 1 hour
            room_ttl,
        })
    }
}

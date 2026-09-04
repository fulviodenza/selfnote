//! Types and helpers shared between the API server (which issues tokens) and the
//! sync server (which verifies them). Keeping them in one crate guarantees both
//! sides agree on the claim shape and signing algorithm.

use jsonwebtoken::{
    decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

pub type Result<T> = std::result::Result<T, jsonwebtoken::errors::Error>;

/// Access token proving a user's identity to the API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessClaims {
    pub sub: String,
    pub email: String,
    pub iat: usize,
    pub exp: usize,
}

/// Access mode granted for a document room.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RoomMode {
    #[serde(rename = "rw")]
    ReadWrite,
    #[serde(rename = "ro")]
    ReadOnly,
}

/// Short-lived, single-purpose token admitting one WebSocket into one room.
/// The sync server verifies this before letting a client join a document.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomClaims {
    /// Document id the token is scoped to.
    pub doc: String,
    /// User id (subject).
    pub sub: String,
    pub mode: RoomMode,
    pub exp: usize,
}

pub fn sign<T: Serialize>(claims: &T, secret: &[u8]) -> Result<String> {
    encode(
        &Header::new(Algorithm::HS256),
        claims,
        &EncodingKey::from_secret(secret),
    )
}

pub fn verify<T: DeserializeOwned>(token: &str, secret: &[u8]) -> Result<T> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.validate_exp = true;
    // Room tokens carry no aud/iss; don't require them.
    validation.required_spec_claims.clear();
    validation.required_spec_claims.insert("exp".to_string());
    Ok(decode::<T>(token, &DecodingKey::from_secret(secret), &validation)?.claims)
}

/// Unix timestamp `secs` seconds from `now_unix`.
pub fn expiry_from(now_unix: usize, secs: usize) -> usize {
    now_unix + secs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn room_token_roundtrip() {
        let secret = b"test-secret";
        let claims = RoomClaims {
            doc: "doc-123".into(),
            sub: "user-1".into(),
            mode: RoomMode::ReadWrite,
            exp: 9_999_999_999,
        };
        let token = sign(&claims, secret).unwrap();
        let decoded: RoomClaims = verify(&token, secret).unwrap();
        assert_eq!(decoded.doc, "doc-123");
        assert_eq!(decoded.mode, RoomMode::ReadWrite);
    }

    #[test]
    fn wrong_secret_rejected() {
        let claims = RoomClaims {
            doc: "d".into(),
            sub: "u".into(),
            mode: RoomMode::ReadOnly,
            exp: 9_999_999_999,
        };
        let token = sign(&claims, b"secret-a").unwrap();
        assert!(verify::<RoomClaims>(&token, b"secret-b").is_err());
    }

    #[test]
    fn expired_token_rejected() {
        let claims = RoomClaims {
            doc: "d".into(),
            sub: "u".into(),
            mode: RoomMode::ReadOnly,
            exp: 1, // 1970
        };
        let token = sign(&claims, b"s").unwrap();
        assert!(verify::<RoomClaims>(&token, b"s").is_err());
    }
}

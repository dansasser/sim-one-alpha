//! Id validation and error types.
//!
//! ULID generation lives in the TypeScript shim (it owns time/RNG); the WASM
//! path only validates ids. We implement ULID parsing locally to avoid
//! pulling `getrandom` (which does not build for `wasm32-unknown-unknown`
//! without extra configuration) into the WASM artifact.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum MemoryHelperError {
    #[error("validation: {0}")]
    Validation(String),
    #[error("not_found: {0}")]
    NotFound(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("internal: {0}")]
    Internal(String),
}

impl From<MemoryHelperError> for String {
    fn from(e: MemoryHelperError) -> String {
        e.to_err_string()
    }
}

impl MemoryHelperError {
    /// Map to the `Err(String)` prefix convention used by the WASM exports.
    pub fn to_err_string(&self) -> String {
        self.to_string()
    }

    pub fn kind_str(&self) -> &'static str {
        match self {
            MemoryHelperError::Validation(_) => "validation",
            MemoryHelperError::NotFound(_) => "not_found",
            MemoryHelperError::Conflict(_) => "conflict",
            MemoryHelperError::Internal(_) => "internal",
        }
    }
}

const CROCKFORD: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

fn is_crockford_char(c: char) -> bool {
    if !c.is_ascii() {
        return false;
    }
    let upper = c.to_ascii_uppercase();
    if matches!(upper, 'O' | 'I' | 'L') {
        return false;
    }
    let b = upper as u8;
    CROCKFORD.contains(&b)
}

/// Validate a ULID string. Accepts the 26-char Crockford base32 form. Non-ULID
/// strings are rejected so the engine fails closed on malformed ids.
pub fn parse_ulid(s: &str) -> Result<String, MemoryHelperError> {
    if s.len() != 26 {
        return Err(MemoryHelperError::Validation(format!(
            "invalid ULID length: expected 26, got {}",
            s.len()
        )));
    }
    if !s.chars().all(is_crockford_char) {
        return Err(MemoryHelperError::Validation(format!(
            "invalid ULID encoding: {s}"
        )));
    }
    let first = s.chars().next().unwrap().to_ascii_uppercase();
    if !matches!(first, '0'..='7') {
        return Err(MemoryHelperError::Validation(format!(
            "invalid ULID timestamp overflow: first char must be 0-7, got {first}"
        )));
    }
    Ok(s.to_string())
}

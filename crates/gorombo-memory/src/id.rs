use ulid::Ulid;

use crate::MemoryHelperError;

/// Generate a new ULID as a string.
pub fn new_ulid() -> String {
    Ulid::new().to_string()
}

/// Parse a ULID string, returning a typed error on failure.
pub fn parse_ulid(s: &str) -> Result<Ulid, MemoryHelperError> {
    s.parse()
        .map_err(|_| MemoryHelperError::Validation(format!("invalid ulid: {}", s)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_ulid_is_valid() {
        let id = new_ulid();
        assert!(parse_ulid(&id).is_ok());
    }

    #[test]
    fn parse_ulid_rejects_garbage() {
        assert!(parse_ulid("not-a-ulid").is_err());
    }

    #[test]
    fn parse_ulid_rejects_empty() {
        assert!(parse_ulid("").is_err());
    }
}

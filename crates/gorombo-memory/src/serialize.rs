use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::MemoryHelperError;

pub fn to_json<T: Serialize>(value: &T) -> Result<String, MemoryHelperError> {
    serde_json::to_string(value).map_err(|e| MemoryHelperError::Internal(e.to_string()))
}

pub fn from_json<T: DeserializeOwned>(s: &str) -> Result<T, MemoryHelperError> {
    serde_json::from_str(s).map_err(|e| MemoryHelperError::Validation(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct Example {
        name: String,
    }

    #[test]
    fn round_trip() {
        let ex = Example { name: "test".to_string() };
        let json = to_json(&ex).unwrap();
        let back: Example = from_json(&json).unwrap();
        assert_eq!(ex, back);
    }
}

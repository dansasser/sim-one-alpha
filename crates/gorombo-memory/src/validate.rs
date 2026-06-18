use serde_json::Value;

use crate::MemoryHelperError;

/// Parse and perform basic structural validation on a JSON request.
pub fn validate_input(json: &str) -> Result<Value, MemoryHelperError> {
    let value: Value = serde_json::from_str(json)
        .map_err(|e| MemoryHelperError::Validation(e.to_string()))?;
    if !value.is_object() {
        return Err(MemoryHelperError::Validation("input must be an object".to_string()));
    }
    Ok(value)
}

/// Reject empty required string fields after trimming.
pub fn require_non_empty(value: &str, field_name: &str) -> Result<String, MemoryHelperError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(MemoryHelperError::Validation(format!(
            "{} cannot be empty",
            field_name
        )));
    }
    Ok(trimmed.to_string())
}

/// Read a string field, erroring if it is present but empty.
pub fn read_optional_string(value: &Value, key: &str) -> Result<Option<String>, MemoryHelperError> {
    match value.get(key) {
        Some(Value::String(s)) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                return Err(MemoryHelperError::Validation(format!(
                    "{} cannot be empty",
                    key
                )));
            }
            Ok(Some(trimmed.to_string()))
        }
        Some(Value::Null) => Ok(None),
        Some(_) => Err(MemoryHelperError::Validation(format!(
            "{} must be a string or null",
            key
        ))),
        None => Ok(None),
    }
}

/// Read a required string field.
pub fn read_required_string(value: &Value, key: &str) -> Result<String, MemoryHelperError> {
    match value.get(key) {
        Some(Value::String(s)) => require_non_empty(s, key),
        _ => Err(MemoryHelperError::Validation(format!(
            "{} is required and must be a non-empty string",
            key
        ))),
    }
}

/// Read an optional array of strings.
pub fn read_optional_string_array(
    value: &Value,
    key: &str,
) -> Result<Vec<String>, MemoryHelperError> {
    match value.get(key) {
        Some(Value::Array(arr)) => {
            let mut out = Vec::new();
            for item in arr {
                match item {
                    Value::String(s) => out.push(s.clone()),
                    _ => {
                        return Err(MemoryHelperError::Validation(format!(
                            "{} must be an array of strings",
                            key
                        )))
                    }
                }
            }
            Ok(out)
        }
        Some(Value::Null) | None => Ok(vec![]),
        Some(_) => Err(MemoryHelperError::Validation(format!(
            "{} must be an array of strings",
            key
        ))),
    }
}

/// Read an optional enum string, validating against a fixed allow-list.
pub fn read_optional_enum(
    value: &Value,
    key: &str,
    allowed: &[&str],
) -> Result<Option<String>, MemoryHelperError> {
    match value.get(key) {
        Some(Value::String(s)) => {
            if !allowed.contains(&s.as_str()) {
                return Err(MemoryHelperError::Validation(format!(
                    "{} must be one of {:?}",
                    key, allowed
                )));
            }
            Ok(Some(s.clone()))
        }
        Some(Value::Null) | None => Ok(None),
        Some(_) => Err(MemoryHelperError::Validation(format!(
            "{} must be a string",
            key
        ))),
    }
}

/// Read a required enum string.
pub fn read_required_enum(
    value: &Value,
    key: &str,
    allowed: &[&str],
) -> Result<String, MemoryHelperError> {
    match read_optional_enum(value, key, allowed)? {
        Some(s) => Ok(s),
        None => Err(MemoryHelperError::Validation(format!(
            "{} is required and must be one of {:?}",
            key, allowed
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_input_rejects_non_object() {
        assert!(validate_input("[]").is_err());
        assert!(validate_input("\"hello\"").is_err());
    }

    #[test]
    fn validate_input_accepts_object() {
        assert!(validate_input("{}").is_ok());
    }

    #[test]
    fn require_non_empty_rejects_blank() {
        assert!(require_non_empty("   ", "title").is_err());
    }

    #[test]
    fn read_required_string_works() {
        let v = serde_json::json!({ "title": "hello" });
        assert_eq!(read_required_string(&v, "title").unwrap(), "hello");
    }

    #[test]
    fn read_optional_enum_rejects_unknown() {
        let v = serde_json::json!({ "status": "nope" });
        assert!(read_optional_enum(&v, "status", &["active", "archived"]).is_err());
    }
}

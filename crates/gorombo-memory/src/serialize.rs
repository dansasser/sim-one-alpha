//! JSON (de)serialization helpers with stable alphabetical key order.
//!
//! `serde_json`'s default `Map` (without the `preserve_order` feature) is a
//! `BTreeMap`, so routing through `serde_json::Value` produces alphabetical
//! key order. The TypeScript parity test compares parsed objects structurally,
//! so byte order is not required for correctness, but stable output helps
//! deterministic snapshots and diffs.

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::id::MemoryHelperError;

pub fn to_json<T: Serialize>(value: &T) -> Result<String, MemoryHelperError> {
    serde_json::to_value(value)
        .and_then(|value| serde_json::to_string(&value))
        .map_err(|e| MemoryHelperError::Internal(format!("serialize: {e}")))
}

pub fn from_json<T: DeserializeOwned>(s: &str) -> Result<T, MemoryHelperError> {
    serde_json::from_str(s).map_err(|e| MemoryHelperError::Validation(format!("deserialize: {e}")))
}

/// Strict parse that also rejects non-object roots. Used by the WASM exports
/// to fail closed on malformed request envelopes.
pub fn parse_object(s: &str) -> Result<serde_json::Value, MemoryHelperError> {
    let value: serde_json::Value =
        serde_json::from_str(s).map_err(|e| MemoryHelperError::Validation(format!("deserialize: {e}")))?;
    if !value.is_object() {
        return Err(MemoryHelperError::Validation("request root must be an object".into()));
    }
    Ok(value)
}

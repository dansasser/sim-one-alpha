//! Input validation shared by every WASM export.
//!
//! Full checklist cycle/depth checks run on `add_checklist_item` and
//! `update_checklist_item`; here we only check the `parentId` format
//! (non-empty when present) and the basic shape.

use serde_json::Value;

use crate::id::MemoryHelperError;

/// Strict parse + structural checks. Rejects non-object roots, empty
/// `id`/`slug`/`title` on known kinds, and `parentId` values that are empty
/// strings. Unknown top-level keys are tolerated here (Valibot strips them on
/// the TS side); the engine's typed deserialization enforces field-level
/// shapes.
pub fn validate_request(value: &Value) -> Result<(), MemoryHelperError> {
    let obj = value
        .as_object()
        .ok_or_else(|| MemoryHelperError::Validation("request must be an object".into()))?;

    if let Some(kind) = obj.get("kind").and_then(|v| v.as_str()) {
        // Reject empty required string fields for known record kinds.
        for field in ["id", "title"] {
            if let Some(s) = obj.get(field).and_then(|v| v.as_str()) {
                if s.is_empty() {
                    return Err(MemoryHelperError::Validation(format!(
                        "{kind}.{field} must be non-empty"
                    )));
                }
            }
        }
        if kind == "checklist" {
            if let Some(s) = obj.get("slug").and_then(|v| v.as_str()) {
                if s.is_empty() {
                    return Err(MemoryHelperError::Validation(
                        "checklist.slug must be non-empty".into(),
                    ));
                }
            }
        }
    }

    // Validate scope presence for create-class requests.
    if let Some(scope) = obj.get("scope").and_then(|v| v.as_object()) {
        let has_scope = ["actorId", "conversationId", "projectId", "threadId"]
            .iter()
            .any(|k| scope.get(*k).is_some())
            || scope
                .get("global")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
        if !has_scope {
            return Err(MemoryHelperError::Validation(
                "scope must carry at least one of actorId/conversationId/projectId/threadId/global".into(),
            ));
        }
    }

    // Validate nested checklist items' parentId format (non-empty when present).
    if let Some(items) = obj.get("items").and_then(|v| v.as_array()) {
        for item in items {
            if let Some(parent) = item.get("parentId").and_then(|v| v.as_str()) {
                if parent.is_empty() {
                    return Err(MemoryHelperError::Validation(
                        "checklist item parentId must be non-empty when present".into(),
                    ));
                }
            }
            if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                if id.is_empty() {
                    return Err(MemoryHelperError::Validation(
                        "checklist item id must be non-empty when present".into(),
                    ));
                }
            }
        }
    }

    Ok(())
}

use wasm_bindgen::prelude::*;

pub mod id;
pub mod scope;
pub mod checklist;
pub mod todo;
pub mod note;
pub mod record;
pub mod index;
pub mod query;
pub mod serialize;
pub mod validate;

pub const MEMORY_HELPER_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(thiserror::Error, Debug, Clone, PartialEq)]
pub enum MemoryHelperError {
    #[error("validation:{0}")]
    Validation(String),
    #[error("not_found:{0}")]
    NotFound(String),
    #[error("conflict:{0}")]
    Conflict(String),
    #[error("internal:{0}")]
    Internal(String),
}

#[wasm_bindgen]
pub fn memory_helper_version() -> String {
    MEMORY_HELPER_VERSION.to_string()
}

#[wasm_bindgen]
pub fn create_checklist(_json: &str) -> Result<String, String> {
    Err("internal: not implemented".to_string())
}

#[wasm_bindgen]
pub fn update_checklist(_json: &str) -> Result<String, String> {
    Err("internal: not implemented".to_string())
}

#[wasm_bindgen]
pub fn add_checklist_item(_json: &str) -> Result<String, String> {
    Err("internal: not implemented".to_string())
}

#[wasm_bindgen]
pub fn update_checklist_item(_json: &str) -> Result<String, String> {
    Err("internal: not implemented".to_string())
}

#[wasm_bindgen]
pub fn create_todo(_json: &str) -> Result<String, String> {
    Err("internal: not implemented".to_string())
}

#[wasm_bindgen]
pub fn update_todo(_json: &str) -> Result<String, String> {
    Err("internal: not implemented".to_string())
}

#[wasm_bindgen]
pub fn create_session_note(_json: &str) -> Result<String, String> {
    Err("internal: not implemented".to_string())
}

#[wasm_bindgen]
pub fn update_session_note(_json: &str) -> Result<String, String> {
    Err("internal: not implemented".to_string())
}

#[wasm_bindgen]
pub fn query_records(_json: &str) -> Result<String, String> {
    Err("internal: not implemented".to_string())
}

#[wasm_bindgen]
pub fn delete_record(_json: &str) -> Result<String, String> {
    Err("internal: not implemented".to_string())
}

#[wasm_bindgen]
pub fn reconcile_index(_json: &str) -> Result<String, String> {
    Err("internal: not implemented".to_string())
}

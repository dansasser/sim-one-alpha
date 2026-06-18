use serde::{Deserialize, Serialize};

use crate::scope::Scope;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionNote {
    pub id: String,
    pub title: String,
    pub content: String,
    pub scope: Scope,
    pub tags: Vec<String>,
    pub status: String,
    pub importance: String,
    pub created_at: String,
    pub updated_at: String,
    pub updated_by: String,
    pub run_id: Option<String>,
}

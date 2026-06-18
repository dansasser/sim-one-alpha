use serde::{Deserialize, Serialize};

use crate::scope::Scope;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub scope: Scope,
    pub priority: String,
    pub status: String,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub updated_by: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

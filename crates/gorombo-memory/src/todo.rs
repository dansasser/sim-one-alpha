use serde::{Deserialize, Serialize};

use crate::scope::Scope;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub id: String,
    pub title: String,
    pub slug: Option<String>,
    pub description: Option<String>,
    pub scope: Scope,
    pub priority: String,
    pub status: String,
    pub tags: Vec<String>,
    pub due_at: Option<String>,
    pub completed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub updated_by: String,
    pub run_id: Option<String>,
}

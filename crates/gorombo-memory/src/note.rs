//! Pinned session-note records.

use serde::{Deserialize, Serialize};

use crate::scope::Scope;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionNoteStatus {
    Active,
    Archived,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionNoteImportance {
    Normal,
    High,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionNote {
    pub id: String,
    pub kind: SessionNoteKind,
    pub title: String,
    pub content: String,
    pub scope: Scope,
    #[serde(default)]
    pub tags: Vec<String>,
    pub status: SessionNoteStatus,
    pub importance: SessionNoteImportance,
    pub created_at: String,
    pub updated_at: String,
    pub updated_by: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionNoteKind {
    SessionNote,
}

impl SessionNoteKind {
    pub fn as_str(&self) -> &'static str {
        "session_note"
    }
}

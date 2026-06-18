use serde::{Deserialize, Serialize};

use crate::checklist::ChecklistItem;
use crate::scope::Scope;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Audit {
    pub updated_by: String,
    pub run_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecklistItemInput {
    pub id: Option<String>,
    pub parent_id: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub status: Option<String>,
    pub ordinal: Option<f64>,
    pub tags: Option<Vec<String>>,
    pub due_at: Option<String>,
    pub completed_at: Option<String>,
}

impl ChecklistItemInput {
    pub fn into_checklist_item(self, defaults: ChecklistItemDefaults) -> ChecklistItem {
        ChecklistItem {
            id: self.id.unwrap_or(defaults.id),
            parent_id: self.parent_id,
            title: self.title,
            description: self.description,
            status: self.status.unwrap_or_else(|| defaults.status),
            ordinal: self.ordinal.unwrap_or(defaults.ordinal),
            tags: self.tags.unwrap_or(defaults.tags),
            due_at: self.due_at,
            completed_at: self.completed_at,
            children: vec![],
        }
    }
}

pub struct ChecklistItemDefaults {
    pub id: String,
    pub status: String,
    pub ordinal: f64,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateChecklistInput {
    pub title: String,
    pub slug: String,
    pub description: Option<String>,
    pub scope: Scope,
    pub tags: Option<Vec<String>>,
    pub items: Option<Vec<ChecklistItemInput>>,
    pub audit: Audit,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateChecklistInput {
    pub id: String,
    pub title: Option<String>,
    pub slug: Option<String>,
    pub description: Option<String>,
    pub tags: Option<Vec<String>>,
    pub status: Option<String>,
    pub scope: Scope,
    pub audit: Audit,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddChecklistItemInput {
    pub checklist_id: String,
    pub item: ChecklistItemInput,
    pub scope: Scope,
    pub audit: Audit,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateChecklistItemInput {
    pub checklist_id: String,
    pub item_id: String,
    pub patch: ChecklistItemPatch,
    pub scope: Scope,
    pub audit: Audit,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecklistItemPatch {
    pub title: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
    pub ordinal: Option<f64>,
    pub tags: Option<Vec<String>>,
    pub due_at: Option<String>,
    pub completed_at: Option<String>,
    pub parent_id: Option<Option<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTodoInput {
    pub title: String,
    pub slug: Option<String>,
    pub description: Option<String>,
    pub scope: Scope,
    pub priority: Option<String>,
    pub status: Option<String>,
    pub tags: Option<Vec<String>>,
    pub due_at: Option<String>,
    pub audit: Audit,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTodoInput {
    pub id: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub tags: Option<Vec<String>>,
    pub due_at: Option<String>,
    pub completed_at: Option<String>,
    pub scope: Scope,
    pub audit: Audit,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionNoteInput {
    pub title: String,
    pub content: String,
    pub scope: Scope,
    pub tags: Option<Vec<String>>,
    pub importance: Option<String>,
    pub audit: Audit,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSessionNoteInput {
    pub id: String,
    pub title: Option<String>,
    pub content: Option<String>,
    pub tags: Option<Vec<String>>,
    pub status: Option<String>,
    pub importance: Option<String>,
    pub scope: Scope,
    pub audit: Audit,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryInputWire {
    pub text: Option<String>,
    pub tags: Option<Vec<String>>,
    pub kinds: Option<Vec<String>>,
    pub statuses: Option<Vec<String>>,
    pub scope: Scope,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteInput {
    pub id: String,
    pub kind: String,
    pub scope: Scope,
    pub audit: Audit,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileInput {
    pub records: Vec<crate::record::Record>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryOutput {
    pub records: Vec<crate::record::Record>,
    pub total_scanned: usize,
}

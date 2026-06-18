//! Checklist and flat checklist-item records.
//!
//! Items are stored flat with `parent_id`; tree rendering is the TS layer's
//! job (plan.md §Rust Crate Design / §1.5).

use serde::{Deserialize, Serialize};

use crate::scope::Scope;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChecklistItem {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub status: ChecklistItemStatus,
    pub ordinal: i64,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChecklistItemStatus {
    Pending,
    InProgress,
    Completed,
    Blocked,
    Skipped,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChecklistStatus {
    Active,
    Archived,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Checklist {
    pub id: String,
    pub kind: ChecklistKind,
    pub title: String,
    pub slug: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub scope: Scope,
    #[serde(default)]
    pub tags: Vec<String>,
    pub status: ChecklistStatus,
    pub items: Vec<ChecklistItem>,
    pub created_at: String,
    pub updated_at: String,
    pub updated_by: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChecklistKind {
    Checklist,
}

impl ChecklistKind {
    pub fn as_str(&self) -> &'static str {
        "checklist"
    }
}

impl Checklist {
    /// Find an item by id.
    pub fn item(&self, id: &str) -> Option<&ChecklistItem> {
        self.items.iter().find(|item| item.id == id)
    }

    /// Depth of an item (top-level = 1). Returns 0 if the item is not found.
    pub fn item_depth(&self, item_id: &str) -> usize {
        let mut depth = 0usize;
        let mut current = Some(item_id.to_string());
        while let Some(ref id) = current {
            let item = match self.item(id) {
                Some(item) => item,
                None => return 0,
            };
            depth += 1;
            if depth > self.items.len() {
                // Defensive: cycle in persisted data. Treat as not-found.
                return 0;
            }
            current = item.parent_id.clone();
        }
        depth
    }

    /// Detect whether adding `new_parent_id` as the parent of `item_id`
    /// would create a cycle (i.e. `new_parent_id` is `item_id` or one of its
    /// descendants).
    pub fn creates_cycle(&self, item_id: &str, new_parent_id: Option<&str>) -> bool {
        match new_parent_id {
            None => false,
            Some(parent) => {
                if parent == item_id {
                    return true;
                }
                // Walk up from `parent`; if we reach `item_id`, it's a cycle.
                let mut current = Some(parent.to_string());
                while let Some(ref id) = current {
                    if id == item_id {
                        return true;
                    }
                    current = self.item(id).and_then(|i| i.parent_id.clone());
                }
                false
            }
        }
    }
}

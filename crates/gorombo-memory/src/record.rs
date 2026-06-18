use serde::{Deserialize, Serialize};

use crate::checklist::Checklist;
use crate::note::SessionNote;
use crate::scope::Scope;
use crate::todo::Todo;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Record {
    #[serde(rename = "checklist")]
    Checklist(Checklist),
    #[serde(rename = "todo")]
    Todo(Todo),
    #[serde(rename = "session_note")]
    SessionNote(SessionNote),
}

impl Record {
    pub fn kind(&self) -> &'static str {
        match self {
            Record::Checklist(_) => "checklist",
            Record::Todo(_) => "todo",
            Record::SessionNote(_) => "session_note",
        }
    }

    pub fn id(&self) -> &str {
        match self {
            Record::Checklist(c) => &c.id,
            Record::Todo(t) => &t.id,
            Record::SessionNote(n) => &n.id,
        }
    }

    pub fn updated_at(&self) -> &str {
        match self {
            Record::Checklist(c) => &c.updated_at,
            Record::Todo(t) => &t.updated_at,
            Record::SessionNote(n) => &n.updated_at,
        }
    }

    pub fn scope(&self) -> &Scope {
        match self {
            Record::Checklist(c) => &c.scope,
            Record::Todo(t) => &t.scope,
            Record::SessionNote(n) => &n.scope,
        }
    }

    pub fn title(&self) -> &str {
        match self {
            Record::Checklist(c) => &c.title,
            Record::Todo(t) => &t.title,
            Record::SessionNote(n) => &n.title,
        }
    }

    pub fn description(&self) -> Option<&str> {
        match self {
            Record::Checklist(c) => c.description.as_deref(),
            Record::Todo(t) => t.description.as_deref(),
            Record::SessionNote(n) => Some(&n.content),
        }
    }

    pub fn tags(&self) -> &Vec<String> {
        match self {
            Record::Checklist(c) => &c.tags,
            Record::Todo(t) => &t.tags,
            Record::SessionNote(n) => &n.tags,
        }
    }

    /// All searchable text tokens for this record, including item titles.
    pub fn searchable_text(&self) -> Vec<String> {
        let mut tokens: Vec<String> = Vec::new();
        tokens.push(self.title().to_lowercase());
        if let Some(desc) = self.description() {
            tokens.push(desc.to_lowercase());
        }
        tokens.extend(self.tags().iter().map(|t| t.to_lowercase()));

        if let Record::Checklist(c) = self {
            for item in &c.items {
                tokens.extend(item_search_tokens(item));
            }
        }

        tokens
    }

    pub fn status(&self) -> &str {
        match self {
            Record::Checklist(c) => &c.status,
            Record::Todo(t) => &t.status,
            Record::SessionNote(n) => &n.status,
        }
    }
}

fn item_search_tokens(item: &crate::checklist::ChecklistItem) -> Vec<String> {
    let mut tokens = vec![item.title.to_lowercase()];
    if let Some(desc) = &item.description {
        tokens.push(desc.to_lowercase());
    }
    tokens.extend(item.tags.iter().map(|t| t.to_lowercase()));
    for child in &item.children {
        tokens.extend(item_search_tokens(child));
    }
    tokens
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::serialize::to_json;

    #[test]
    fn checklist_record_includes_kind() {
        let checklist = Checklist {
            id: "01ABCDEF".to_string(),
            title: "Phase 0".to_string(),
            slug: "phase-0".to_string(),
            description: None,
            scope: Scope::default(),
            tags: vec![],
            status: "active".to_string(),
            items: vec![],
            created_at: "2026-06-18T00:00:00Z".to_string(),
            updated_at: "2026-06-18T00:00:00Z".to_string(),
            updated_by: "test".to_string(),
            run_id: None,
        };
        let record = Record::Checklist(checklist);
        let json = to_json(&record).unwrap();
        assert!(json.contains("\"kind\":\"checklist\""));
    }
}

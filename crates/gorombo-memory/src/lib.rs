use std::sync::Mutex;

use wasm_bindgen::prelude::*;

pub mod checklist;
pub mod id;
pub mod index;
pub mod input;
pub mod note;
pub mod query;
pub mod record;
pub mod scope;
pub mod serialize;
pub mod todo;
pub mod validate;

use checklist::{build_item_tree, Checklist, ChecklistItem};
use id::new_ulid;
use index::InMemoryIndex;
use input::*;
use note::SessionNote;
use query::{query_records as engine_query, QueryInput};
use record::Record;
use serialize::{from_json, to_json};
use todo::Todo;
use validate::require_non_empty;

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

impl From<MemoryHelperError> for String {
    fn from(value: MemoryHelperError) -> Self {
        value.to_string()
    }
}

static INDEX: Mutex<Option<InMemoryIndex>> = Mutex::new(None);

fn with_index<F, T>(f: F) -> Result<T, String>
where
    F: FnOnce(&mut InMemoryIndex) -> Result<T, MemoryHelperError>,
{
    let mut guard = INDEX.lock().map_err(|e| format!("internal:{}", e))?;
    let index = guard.as_mut().ok_or_else(|| {
        "validation:index has not been reconciled; call reconcile_index first".to_string()
    })?;
    f(index).map_err(|e| e.to_string())
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[wasm_bindgen]
pub fn memory_helper_version() -> String {
    MEMORY_HELPER_VERSION.to_string()
}

#[wasm_bindgen]
pub fn reconcile_index(json: &str) -> Result<String, String> {
    let input: ReconcileInput = from_json(json)
        .map_err(|e| MemoryHelperError::Validation(e.to_string()).to_string())?;
    let mut guard = INDEX.lock().map_err(|e| format!("internal:{}", e))?;
    let mut index = InMemoryIndex::new();
    index.rebuild(&input.records);
    *guard = Some(index);
    to_json(&serde_json::json!({ "ok": true })).map_err(|e| e.to_string())
}

#[wasm_bindgen]
pub fn create_checklist(json: &str) -> Result<String, String> {
    let input: CreateChecklistInput = from_json(json)
        .map_err(|e| MemoryHelperError::Validation(e.to_string()).to_string())?;

    let created_at = now_iso();
    let items = build_items_from_input(input.items.unwrap_or_default())?;

    let checklist = Checklist {
        id: new_ulid(),
        title: require_non_empty(&input.title, "title")?,
        slug: require_non_empty(&input.slug, "slug")?,
        description: input.description,
        scope: input.scope,
        tags: input.tags.unwrap_or_default(),
        status: "active".to_string(),
        items,
        created_at: created_at.clone(),
        updated_at: created_at.clone(),
        updated_by: input.audit.updated_by,
        run_id: input.audit.run_id,
    };

    with_index(|index| {
        index.insert(&Record::Checklist(checklist.clone()));
        Ok(())
    })?;

    to_json(&Record::Checklist(checklist)).map_err(|e| e.to_string())
}

#[wasm_bindgen]
pub fn update_checklist(json: &str) -> Result<String, String> {
    let input: UpdateChecklistInput = from_json(json)
        .map_err(|e| MemoryHelperError::Validation(e.to_string()).to_string())?;

    with_index(|index| {
        let record = index
            .get(&input.id)
            .ok_or_else(|| MemoryHelperError::NotFound(format!("checklist {}", input.id)))?
            .clone();
        let Record::Checklist(mut checklist) = record else {
            return Err(MemoryHelperError::Validation(format!(
                "record {} is not a checklist",
                input.id
            )));
        };

        if let Some(title) = input.title {
            checklist.title = require_non_empty(&title, "title")?;
        }
        if input.description.is_some() {
            checklist.description = input.description;
        }
        if let Some(slug) = input.slug {
            checklist.slug = require_non_empty(&slug, "slug")?;
        }
        if let Some(tags) = input.tags {
            checklist.tags = tags;
        }
        if let Some(status) = input.status {
            checklist.status = status;
        }
        checklist.updated_at = now_iso();
        checklist.updated_by = input.audit.updated_by;
        checklist.run_id = input.audit.run_id;

        index.insert(&Record::Checklist(checklist.clone()));
        Ok(to_json(&Record::Checklist(checklist))?)
    })
}

#[wasm_bindgen]
pub fn add_checklist_item(json: &str) -> Result<String, String> {
    let input: AddChecklistItemInput = from_json(json)
        .map_err(|e| MemoryHelperError::Validation(e.to_string()).to_string())?;

    with_index(|index| {
        let record = index
            .get(&input.checklist_id)
            .ok_or_else(|| {
                MemoryHelperError::NotFound(format!("checklist {}", input.checklist_id))
            })?
            .clone();
        let Record::Checklist(mut checklist) = record else {
            return Err(MemoryHelperError::Validation(format!(
                "record {} is not a checklist",
                input.checklist_id
            )));
        };

        let parent_id_for_ordinal = input.item.parent_id.clone();
        let new_item = input.item.into_checklist_item(input::ChecklistItemDefaults {
            id: new_ulid(),
            status: "pending".to_string(),
            ordinal: next_ordinal(&checklist.items,
                parent_id_for_ordinal.as_deref(),
            ),
            tags: vec![],
        });

        let mut flat: Vec<ChecklistItem> = checklist.items.iter().flat_map(|i| i.flatten(None)).collect();
        flat.push(new_item);
        checklist.items = build_item_tree(flat);
        checklist.updated_at = now_iso();
        checklist.updated_by = input.audit.updated_by.clone();
        checklist.run_id = input.audit.run_id.clone();

        index.insert(&Record::Checklist(checklist.clone()));
        Ok(to_json(&Record::Checklist(checklist))?)
    })
}

#[wasm_bindgen]
pub fn update_checklist_item(json: &str) -> Result<String, String> {
    let input: UpdateChecklistItemInput = from_json(json)
        .map_err(|e| MemoryHelperError::Validation(e.to_string()).to_string())?;

    with_index(|index| {
        let record = index
            .get(&input.checklist_id)
            .ok_or_else(|| {
                MemoryHelperError::NotFound(format!("checklist {}", input.checklist_id))
            })?
            .clone();
        let Record::Checklist(mut checklist) = record else {
            return Err(MemoryHelperError::Validation(format!(
                "record {} is not a checklist",
                input.checklist_id
            )));
        };

        let mut flat: Vec<ChecklistItem> = checklist.items.iter().flat_map(|i| i.flatten(None)).collect();
        let item = flat
            .iter_mut()
            .find(|i| i.id == input.item_id)
            .ok_or_else(|| {
                MemoryHelperError::NotFound(format!(
                    "item {} in checklist {}",
                    input.item_id, input.checklist_id
                ))
            })?;

        if let Some(title) = input.patch.title {
            item.title = require_non_empty(&title, "title")?;
        }
        if input.patch.description.is_some() {
            item.description = input.patch.description;
        }
        if let Some(status) = input.patch.status {
            item.status = status;
        }
        if let Some(ordinal) = input.patch.ordinal {
            item.ordinal = ordinal;
        }
        if let Some(tags) = input.patch.tags {
            item.tags = tags;
        }
        if input.patch.due_at.is_some() {
            item.due_at = input.patch.due_at;
        }
        if input.patch.completed_at.is_some() {
            item.completed_at = input.patch.completed_at;
        }
        if let Some(parent_id) = input.patch.parent_id {
            item.parent_id = parent_id;
        }

        checklist.items = build_item_tree(flat);
        checklist.updated_at = now_iso();
        checklist.updated_by = input.audit.updated_by.clone();
        checklist.run_id = input.audit.run_id.clone();

        index.insert(&Record::Checklist(checklist.clone()));
        Ok(to_json(&Record::Checklist(checklist))?)
    })
}

#[wasm_bindgen]
pub fn create_todo(json: &str) -> Result<String, String> {
    let input: CreateTodoInput = from_json(json)
        .map_err(|e| MemoryHelperError::Validation(e.to_string()).to_string())?;

    let created_at = now_iso();
    let todo = Todo {
        id: new_ulid(),
        title: require_non_empty(&input.title, "title")?,
        slug: input.slug,
        description: input.description,
        scope: input.scope,
        priority: input.priority.unwrap_or_else(|| "normal".to_string()),
        status: input.status.unwrap_or_else(|| "pending".to_string()),
        tags: input.tags.unwrap_or_default(),
        due_at: input.due_at,
        completed_at: None,
        created_at: created_at.clone(),
        updated_at: created_at.clone(),
        updated_by: input.audit.updated_by,
        run_id: input.audit.run_id,
    };

    with_index(|index| {
        index.insert(&Record::Todo(todo.clone()));
        Ok(())
    })?;

    to_json(&Record::Todo(todo)).map_err(|e| e.to_string())
}

#[wasm_bindgen]
pub fn update_todo(json: &str) -> Result<String, String> {
    let input: UpdateTodoInput = from_json(json)
        .map_err(|e| MemoryHelperError::Validation(e.to_string()).to_string())?;

    with_index(|index| {
        let record = index
            .get(&input.id)
            .ok_or_else(|| MemoryHelperError::NotFound(format!("todo {}", input.id)))?
            .clone();
        let Record::Todo(mut todo) = record else {
            return Err(MemoryHelperError::Validation(format!(
                "record {} is not a todo",
                input.id
            )));
        };

        if let Some(title) = input.title {
            todo.title = require_non_empty(&title, "title")?;
        }
        if input.description.is_some() {
            todo.description = input.description;
        }
        if let Some(status) = input.status {
            todo.status = status;
        }
        if let Some(priority) = input.priority {
            todo.priority = priority;
        }
        if let Some(tags) = input.tags {
            todo.tags = tags;
        }
        if input.due_at.is_some() {
            todo.due_at = input.due_at;
        }
        if input.completed_at.is_some() {
            todo.completed_at = input.completed_at;
        }
        todo.updated_at = now_iso();
        todo.updated_by = input.audit.updated_by;
        todo.run_id = input.audit.run_id;

        index.insert(&Record::Todo(todo.clone()));
        Ok(to_json(&Record::Todo(todo))?)
    })
}

#[wasm_bindgen]
pub fn create_session_note(json: &str) -> Result<String, String> {
    let input: CreateSessionNoteInput = from_json(json)
        .map_err(|e| MemoryHelperError::Validation(e.to_string()).to_string())?;

    let created_at = now_iso();
    let note = SessionNote {
        id: new_ulid(),
        title: require_non_empty(&input.title, "title")?,
        content: require_non_empty(&input.content, "content")?,
        scope: input.scope,
        tags: input.tags.unwrap_or_default(),
        status: "active".to_string(),
        importance: input.importance.unwrap_or_else(|| "normal".to_string()),
        created_at: created_at.clone(),
        updated_at: created_at.clone(),
        updated_by: input.audit.updated_by,
        run_id: input.audit.run_id,
    };

    with_index(|index| {
        index.insert(&Record::SessionNote(note.clone()));
        Ok(())
    })?;

    to_json(&Record::SessionNote(note)).map_err(|e| e.to_string())
}

#[wasm_bindgen]
pub fn update_session_note(json: &str) -> Result<String, String> {
    let input: UpdateSessionNoteInput = from_json(json)
        .map_err(|e| MemoryHelperError::Validation(e.to_string()).to_string())?;

    with_index(|index| {
        let record = index
            .get(&input.id)
            .ok_or_else(|| MemoryHelperError::NotFound(format!("session_note {}", input.id)))?
            .clone();
        let Record::SessionNote(mut note) = record else {
            return Err(MemoryHelperError::Validation(format!(
                "record {} is not a session_note",
                input.id
            )));
        };

        if let Some(title) = input.title {
            note.title = require_non_empty(&title, "title")?;
        }
        if let Some(content) = input.content {
            note.content = require_non_empty(&content, "content")?;
        }
        if let Some(tags) = input.tags {
            note.tags = tags;
        }
        if let Some(status) = input.status {
            note.status = status;
        }
        if let Some(importance) = input.importance {
            note.importance = importance;
        }
        note.updated_at = now_iso();
        note.updated_by = input.audit.updated_by;
        note.run_id = input.audit.run_id;

        index.insert(&Record::SessionNote(note.clone()));
        Ok(to_json(&Record::SessionNote(note))?)
    })
}

#[wasm_bindgen]
pub fn query_records(json: &str) -> Result<String, String> {
    let wire: QueryInputWire = from_json(json)
        .map_err(|e| MemoryHelperError::Validation(e.to_string()).to_string())?;

    with_index(|index| {
        let result = engine_query(
            index,
            QueryInput {
                text: wire.text,
                tags: wire.tags.unwrap_or_default(),
                kinds: wire.kinds,
                statuses: wire.statuses,
                scope: wire.scope,
                limit: wire.limit.unwrap_or(20),
            },
        )?;
        Ok(to_json(
            &QueryOutput {
                records: result.records,
                total_scanned: result.total_scanned,
            })?)
    })
}

#[wasm_bindgen]
pub fn delete_record(json: &str) -> Result<String, String> {
    let input: DeleteInput = from_json(json)
        .map_err(|e| MemoryHelperError::Validation(e.to_string()).to_string())?;

    with_index(|index| {
        let record = index
            .get(&input.id)
            .ok_or_else(|| MemoryHelperError::NotFound(format!("{} {}", input.kind, input.id)))?;
        if record.kind() != input.kind {
            return Err(MemoryHelperError::Validation(format!(
                "record {} is not a {}",
                input.id, input.kind
            )));
        }
        index.remove(&input.id);
        Ok(to_json(
            &serde_json::json!({ "deleted": true }))?)
    })
}

fn build_items_from_input(
    inputs: Vec<ChecklistItemInput>,
) -> Result<Vec<ChecklistItem>, MemoryHelperError> {
    let mut flat: Vec<ChecklistItem> = Vec::new();
    for (idx, item_input) in inputs.into_iter().enumerate() {
        let item = item_input.into_checklist_item(input::ChecklistItemDefaults {
            id: new_ulid(),
            status: "pending".to_string(),
            ordinal: idx as f64,
            tags: vec![],
        });
        flat.push(item);
    }
    Ok(build_item_tree(flat))
}

fn next_ordinal(items: &[ChecklistItem], parent_id: Option<&str>) -> f64 {
    let max = items
        .iter()
        .flat_map(|i| i.flatten(None))
        .filter(|i| i.parent_id.as_deref() == parent_id)
        .map(|i| i.ordinal)
        .fold(0.0, f64::max);
    max + 1.0
}

#[cfg(test)]
mod export_tests {
    use super::*;

    fn reconcile_empty() {
        reconcile_index(r#"{"records": []}"#).unwrap();
    }

    #[test]
    fn full_crud_flow() {
        reconcile_empty();

        let checklist = create_checklist(r#"
            {
                "title": "Phase 0 prep",
                "slug": "phase-0-prep",
                "scope": { "projectId": "gorombo" },
                "items": [
                    { "title": "Define schemas" },
                    { "title": "Write types" }
                ],
                "audit": { "updatedBy": "test" }
            }
        "#).unwrap();
        assert!(checklist.contains("\"kind\":\"checklist\""));

        let todo = create_todo(r#"
            {
                "title": "Run smoke test",
                "scope": { "projectId": "gorombo" },
                "audit": { "updatedBy": "test" }
            }
        "#).unwrap();
        assert!(todo.contains("\"kind\":\"todo\""));

        let note = create_session_note(r#"
            {
                "title": "Architecture decision",
                "content": "Use Rust/WASM for the memory engine.",
                "scope": { "projectId": "gorombo" },
                "audit": { "updatedBy": "test" }
            }
        "#).unwrap();
        assert!(note.contains("\"kind\":\"session_note\""));

        let query = query_records(r#"
            {
                "text": "smoke",
                "scope": { "projectId": "gorombo" },
                "limit": 10
            }
        "#).unwrap();
        assert!(query.contains("\"totalScanned\""));
        assert!(query.contains("Run smoke test"));

        let query_cross_project = query_records(r#"
            {
                "text": "smoke",
                "scope": { "projectId": "other" },
                "limit": 10
            }
        "#).unwrap();
        assert!(!query_cross_project.contains("Run smoke test"));

        // Extract todo id and delete it.
        let parsed: serde_json::Value = serde_json::from_str(&todo).unwrap();
        let id = parsed["id"].as_str().unwrap();
        let deleted = delete_record(
            &format!(
                r#"{{"id":"{}","kind":"todo","scope":{{"projectId":"gorombo"}},"audit":{{"updatedBy":"test"}}}}"#,
                id
            ),
        )
        .unwrap();
        assert!(deleted.contains("\"deleted\":true"));
    }
}

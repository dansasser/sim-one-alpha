//! gorombo-memory — Rust engine for the GOROMBO Agent structured-memory
//! subsystem.
//!
//! Compiled to WebAssembly via `wasm-pack --target nodejs` and loaded by
//! `src/memory/rust-memory-engine.ts`. See /opt/ai/plans/rust-memory-helper/plan.md.
//!
//! Layering contract:
//! - The TypeScript shim generates ids (ULID), timestamps, and audit fields
//!   (`updatedBy`, `runId`) and passes fully-formed records to the create/update
//!   exports. Rust never needs a clock or RNG in the WASM target.
//! - Rust owns validation (scope non-empty, slug uniqueness within scope,
//!   checklist cycle/depth), the in-memory store + inverted index, and the
//!   query planner. It returns JSON records.
//! - The WASM module keeps a `thread_local` store for the lifetime of the
//!   loaded instance. The shim hydrates it from the durable SQLite store on
//!   cold start via `reconcile_index`; mutating exports keep it in sync. This
//!   is the only design that lets `query_records` (which receives no records)
//!   answer without a per-call resync; the durable store remains the source
//!   of truth across process restarts.

use std::cell::RefCell;

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use crate::checklist::{Checklist, ChecklistItem};
use crate::id::MemoryHelperError;
use crate::index::InMemoryIndex;
use crate::note::SessionNote;
use crate::query::{run_query, QueryInput, QueryResult};
use crate::record::Record;
use crate::scope::Scope;
use crate::serialize::{from_json, parse_object, to_json};
use crate::todo::Todo;
use crate::validate::validate_request;

mod checklist;
mod id;
mod index;
mod note;
mod query;
mod record;
mod scope;
mod serialize;
mod todo;
mod validate;

pub const MEMORY_HELPER_VERSION: &str = env!("CARGO_PKG_VERSION");

const DEFAULT_MAX_CHECKLIST_DEPTH: usize = 5;

#[derive(Debug, Default)]
struct EngineState {
    index: InMemoryIndex,
    max_checklist_depth: usize,
}

impl EngineState {
    fn new() -> Self {
        EngineState {
            index: InMemoryIndex::default(),
            max_checklist_depth: DEFAULT_MAX_CHECKLIST_DEPTH,
        }
    }
}

thread_local! {
    static STATE: RefCell<EngineState> = RefCell::new(EngineState::new());
}

/// Run a closure with borrowed engine state; convert errors to `Err(String)`.
fn with_state<R>(f: impl FnOnce(&mut EngineState) -> Result<R, MemoryHelperError>) -> Result<R, String> {
    STATE.with(|cell| {
        let mut state = cell.borrow_mut();
        f(&mut state).map_err(|e| e.to_err_string())
    })
}

fn ok_json<T: Serialize>(value: &T) -> Result<String, String> {
    to_json(value).map_err(|e| e.to_err_string())
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteInput {
    id: String,
    #[serde(default)]
    kind: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReconcileRequest {
    records: Vec<Record>,
    #[serde(default)]
    max_checklist_depth: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteResult {
    deleted: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddChecklistItemRequest {
    checklist_id: String,
    item: ChecklistItem,
    /// New `updated_at` for the checklist (provided by the TS shim).
    updated_at: String,
}

/// Module version. The TS shim asserts this matches its expected build before
/// issuing any other call.
#[wasm_bindgen]
pub fn memory_helper_version() -> String {
    MEMORY_HELPER_VERSION.to_string()
}

#[wasm_bindgen]
pub fn create_checklist(json: &str) -> Result<String, String> {
    let value = parse_object(json)?;
    validate_request(&value)?;
    let checklist: Checklist = from_json(json)?;
    with_state(|state| {
        validate_checklist_invariants(state, &checklist)?;
        state.index.insert(checklist.clone().into());
        Ok(checklist)
    })
    .and_then(|c| ok_json(&c))
}

#[wasm_bindgen]
pub fn update_checklist(json: &str) -> Result<String, String> {
    let value = parse_object(json)?;
    validate_request(&value)?;
    let checklist: Checklist = from_json(json)?;
    with_state(|state| {
        if state.index.get(&checklist.id).is_none() {
            return Err(MemoryHelperError::NotFound(format!(
                "checklist {} not found",
                checklist.id
            )));
        }
        validate_checklist_invariants(state, &checklist)?;
        state.index.insert(checklist.clone().into());
        Ok(checklist)
    })
    .and_then(|c| ok_json(&c))
}

#[wasm_bindgen]
pub fn add_checklist_item(json: &str) -> Result<String, String> {
    let value = parse_object(json)?;
    validate_request(&value)?;
    let request: AddChecklistItemRequest = from_json(json)?;
    with_state(|state| {
        let record = state
            .index
            .get(&request.checklist_id)
            .ok_or_else(|| MemoryHelperError::NotFound(format!("checklist {} not found", request.checklist_id)))?
            .clone();
        let mut checklist = match record {
            Record::Checklist(c) => c,
            _ => return Err(MemoryHelperError::Validation("id is not a checklist".into())),
        };
        validate_item_invariants(state, &checklist, &request.item)?;
        // Replace existing item by id or append.
        if let Some(existing) = checklist.items.iter_mut().find(|i| i.id == request.item.id) {
            *existing = request.item.clone();
        } else {
            checklist.items.push(request.item.clone());
        }
        checklist.updated_at = request.updated_at;
        state.index.insert(checklist.clone().into());
        Ok(checklist)
    })
    .and_then(|c| ok_json(&c))
}

#[wasm_bindgen]
pub fn update_checklist_item(json: &str) -> Result<String, String> {
    // Same shape as add_checklist_item; replace by item id.
    add_checklist_item(json)
}

#[wasm_bindgen]
pub fn create_todo(json: &str) -> Result<String, String> {
    let value = parse_object(json)?;
    validate_request(&value)?;
    let todo: Todo = from_json(json)?;
    with_state(|state| {
        state.index.insert(todo.clone().into());
        Ok(todo)
    })
    .and_then(|t| ok_json(&t))
}

#[wasm_bindgen]
pub fn update_todo(json: &str) -> Result<String, String> {
    let value = parse_object(json)?;
    validate_request(&value)?;
    let todo: Todo = from_json(json)?;
    with_state(|state| {
        if state.index.get(&todo.id).is_none() {
            return Err(MemoryHelperError::NotFound(format!("todo {} not found", todo.id)));
        }
        state.index.insert(todo.clone().into());
        Ok(todo)
    })
    .and_then(|t| ok_json(&t))
}

#[wasm_bindgen]
pub fn create_session_note(json: &str) -> Result<String, String> {
    let value = parse_object(json)?;
    validate_request(&value)?;
    let note: SessionNote = from_json(json)?;
    with_state(|state| {
        state.index.insert(note.clone().into());
        Ok(note)
    })
    .and_then(|n| ok_json(&n))
}

#[wasm_bindgen]
pub fn update_session_note(json: &str) -> Result<String, String> {
    let value = parse_object(json)?;
    validate_request(&value)?;
    let note: SessionNote = from_json(json)?;
    with_state(|state| {
        if state.index.get(&note.id).is_none() {
            return Err(MemoryHelperError::NotFound(format!("session_note {} not found", note.id)));
        }
        state.index.insert(note.clone().into());
        Ok(note)
    })
    .and_then(|n| ok_json(&n))
}

#[wasm_bindgen]
pub fn query_records(json: &str) -> Result<String, String> {
    let value = parse_object(json)?;
    validate_request(&value)?;
    let input: QueryInput = from_json(json)?;
    with_state(|state| {
        let result: QueryResult = run_query(&state.index, &input);
        Ok(result)
    })
    .and_then(|r| ok_json(&r))
}

#[wasm_bindgen]
pub fn delete_record(json: &str) -> Result<String, String> {
    let value = parse_object(json)?;
    validate_request(&value)?;
    let input: DeleteInput = from_json(json)?;
    with_state(|state| {
        let removed = state.index.remove(&input.id);
        Ok(DeleteResult { deleted: removed.is_some() })
    })
    .and_then(|d| ok_json(&d))
}

#[wasm_bindgen]
pub fn reconcile_index(json: &str) -> Result<String, String> {
    let value = parse_object(json)?;
    validate_request(&value)?;
    let request: ReconcileRequest = from_json(json)?;
    with_state(|state| {
        if let Some(depth) = request.max_checklist_depth {
            state.max_checklist_depth = depth.max(1);
        }
        state.index.rebuild(request.records);
        Ok(())
    })?;
    ok_json(&serde_json::Value::Null)
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

fn validate_checklist_invariants(state: &EngineState, checklist: &Checklist) -> Result<(), MemoryHelperError> {
    if checklist.scope.is_empty() {
        return Err(MemoryHelperError::Validation("checklist scope must be non-empty".into()));
    }
    if checklist.slug.is_empty() {
        return Err(MemoryHelperError::Validation("checklist slug must be non-empty".into()));
    }
    if checklist.title.is_empty() {
        return Err(MemoryHelperError::Validation("checklist title must be non-empty".into()));
    }
    // Slug uniqueness within an overlapping scope.
    for record in state.index.records() {
        if let Record::Checklist(existing) = record {
            if existing.id == checklist.id {
                continue;
            }
            if existing.slug == checklist.slug
                && (Scope::matches(&existing.scope, &checklist.scope)
                    || Scope::matches(&checklist.scope, &existing.scope))
            {
                return Err(MemoryHelperError::Conflict(format!(
                    "checklist slug '{}' already exists in this scope",
                    checklist.slug
                )));
            }
        }
    }
    // Item id uniqueness within the checklist.
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for item in &checklist.items {
        if !seen.insert(item.id.as_str()) {
            return Err(MemoryHelperError::Validation(format!(
                "duplicate checklist item id {}",
                item.id
            )));
        }
        // parentId must reference an item in the same checklist.
        if let Some(ref parent) = item.parent_id {
            if !checklist.items.iter().any(|i| i.id == *parent) {
                return Err(MemoryHelperError::Validation(format!(
                    "checklist item {} references unknown parentId {}",
                    item.id, parent
                )));
            }
            if checklist.creates_cycle(&item.id, Some(parent)) {
                return Err(MemoryHelperError::Validation(format!(
                    "checklist item {} would form a cycle under {}",
                    item.id, parent
                )));
            }
        }
        let depth = checklist.item_depth(&item.id);
        if depth > state.max_checklist_depth {
            return Err(MemoryHelperError::Validation(format!(
                "checklist item {} exceeds max depth {}",
                item.id, state.max_checklist_depth
            )));
        }
    }
    Ok(())
}

fn validate_item_invariants(
    state: &EngineState,
    checklist: &Checklist,
    item: &ChecklistItem,
) -> Result<(), MemoryHelperError> {
    if item.title.is_empty() {
        return Err(MemoryHelperError::Validation("checklist item title must be non-empty".into()));
    }
    // Build the prospective checklist (with the new/updated item) and re-run
    // the structural checks (cycle, depth, parentId presence).
    let mut prospective = checklist.clone();
    if let Some(existing) = prospective.items.iter_mut().find(|i| i.id == item.id) {
        *existing = item.clone();
    } else {
        prospective.items.push(item.clone());
    }
    validate_checklist_invariants(state, &prospective)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::checklist::{Checklist, ChecklistItem, ChecklistItemStatus, ChecklistKind, ChecklistStatus};
    use crate::scope::Scope;
    use crate::todo::{Todo, TodoKind, TodoPriority, TodoStatus};

    fn ulid(n: u8) -> String {
        format!("01H50000000000000000000{n:02X}")
    }

    fn sample_checklist(id: &str, slug: &str) -> Checklist {
        Checklist {
            id: id.to_string(),
            kind: ChecklistKind::Checklist,
            title: "Phase 0 prep".into(),
            slug: slug.to_string(),
            description: None,
            scope: Scope {
                project_id: Some("proj-1".into()),
                ..Default::default()
            },
            tags: vec![],
            status: ChecklistStatus::Active,
            items: vec![],
            created_at: "2026-06-18T00:00:00Z".into(),
            updated_at: "2026-06-18T00:00:00Z".into(),
            updated_by: "test".into(),
            run_id: None,
        }
    }

    #[test]
    fn version_is_set() {
        assert!(!MEMORY_HELPER_VERSION.is_empty());
    }

    #[test]
    fn create_and_query_checklist_round_trip() {
        STATE.with(|c| c.replace(EngineState::new()));
        let checklist = sample_checklist(&ulid(1), "phase-0");
        let json = to_json(&checklist).unwrap();
        let out = create_checklist(&json).unwrap();
        assert!(out.contains("phase-0"));

        let query = to_json(&serde_json::json!({
            "scope": { "projectId": "proj-1" },
            "text": "phase"
        }))
        .unwrap();
        let result = query_records(&query).unwrap();
        assert!(result.contains("phase-0"));
    }

    #[test]
    fn slug_conflict_is_rejected() {
        STATE.with(|c| c.replace(EngineState::new()));
        let a = sample_checklist(&ulid(1), "dup");
        let b = sample_checklist(&ulid(2), "dup");
        create_checklist(&to_json(&a).unwrap()).unwrap();
        let err = create_checklist(&to_json(&b).unwrap()).unwrap_err();
        assert!(err.starts_with("conflict:"), "got: {err}");
    }

    #[test]
    fn cross_project_isolation_in_query() {
        STATE.with(|c| c.replace(EngineState::new()));
        let mut a = sample_checklist(&ulid(1), "alpha");
        a.scope = Scope { project_id: Some("a".into()), ..Default::default() };
        let mut b = sample_checklist(&ulid(2), "beta");
        b.scope = Scope { project_id: Some("b".into()), ..Default::default() };
        b.title = "beta-title".into();
        b.slug = "beta".into();
        create_checklist(&to_json(&a).unwrap()).unwrap();
        create_checklist(&to_json(&b).unwrap()).unwrap();

        let query = to_json(&serde_json::json!({
            "scope": { "projectId": "a" },
            "text": "beta"
        }))
        .unwrap();
        let result = query_records(&query).unwrap();
        assert!(!result.contains("beta-title"), "cross-scope leak: {result}");
    }

    #[test]
    fn checklist_cycle_prevented() {
        STATE.with(|c| c.replace(EngineState::new()));
        let mut checklist = sample_checklist(&ulid(1), "tree");
        checklist.items = vec![
            ChecklistItem {
                id: ulid(0xA).to_string(),
                parent_id: Some(ulid(0xB).to_string()),
                title: "a".into(),
                description: None,
                status: ChecklistItemStatus::Pending,
                ordinal: 0,
                tags: vec![],
                due_at: None,
                completed_at: None,
            },
            ChecklistItem {
                id: ulid(0xB).to_string(),
                parent_id: Some(ulid(0xA).to_string()),
                title: "b".into(),
                description: None,
                status: ChecklistItemStatus::Pending,
                ordinal: 0,
                tags: vec![],
                due_at: None,
                completed_at: None,
            },
        ];
        let err = create_checklist(&to_json(&checklist).unwrap()).unwrap_err();
        assert!(err.starts_with("validation:"), "got: {err}");
    }

    #[test]
    fn todo_create_and_delete() {
        STATE.with(|c| c.replace(EngineState::new()));
        let todo = Todo {
            id: ulid(3),
            kind: TodoKind::Todo,
            title: "Run smoke".into(),
            slug: None,
            description: None,
            scope: Scope {
                project_id: Some("proj-1".into()),
                ..Default::default()
            },
            priority: TodoPriority::High,
            status: TodoStatus::Pending,
            tags: vec![],
            due_at: None,
            completed_at: None,
            created_at: "2026-06-18T00:00:00Z".into(),
            updated_at: "2026-06-18T00:00:00Z".into(),
            updated_by: "test".into(),
            run_id: None,
        };
        create_todo(&to_json(&todo).unwrap()).unwrap();
        let del = to_json(&DeleteInput { id: ulid(3), kind: None }).unwrap();
        let out = delete_record(&del).unwrap();
        assert!(out.contains("\"deleted\":true"));
    }
}

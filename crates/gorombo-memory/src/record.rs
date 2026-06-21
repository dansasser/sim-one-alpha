//! The union `Record` kind and common accessors.

use serde::{Deserialize, Serialize};

use crate::checklist::{Checklist, ChecklistKind};
use crate::note::{SessionNote, SessionNoteKind};
use crate::scope::Scope;
use crate::todo::{Todo, TodoKind};

/// Union of the three record kinds. `#[serde(untagged)]` plus the per-struct
/// `kind` literal field acts as the discriminator (each inner `Kind` enum only
/// deserializes from one value, so the wrong variant fails and serde tries
/// the next). This keeps the `kind` field in the JSON output for TS parity
/// with the Valibot `v.variant('kind', [...])` discriminated union.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum Record {
    Checklist(Checklist),
    Todo(Todo),
    SessionNote(SessionNote),
}

impl Record {
    pub fn kind_str(&self) -> &'static str {
        match self {
            Record::Checklist(_) => ChecklistKind::Checklist.as_str(),
            Record::Todo(_) => TodoKind::Todo.as_str(),
            Record::SessionNote(_) => SessionNoteKind::SessionNote.as_str(),
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

    pub fn tags(&self) -> &[String] {
        match self {
            Record::Checklist(c) => &c.tags,
            Record::Todo(t) => &t.tags,
            Record::SessionNote(n) => &n.tags,
        }
    }

    pub fn is_archived(&self) -> bool {
        match self {
            Record::Checklist(c) => {
                c.status == crate::checklist::ChecklistStatus::Archived || c.archived_at.is_some()
            }
            Record::Todo(t) => t.archived_at.is_some(),
            Record::SessionNote(n) => {
                n.status == crate::note::SessionNoteStatus::Archived || n.archived_at.is_some()
            }
        }
    }

    pub fn archived_at(&self) -> Option<&str> {
        match self {
            Record::Checklist(c) => c.archived_at.as_deref(),
            Record::Todo(t) => t.archived_at.as_deref(),
            Record::SessionNote(n) => n.archived_at.as_deref(),
        }
    }
}

impl From<Checklist> for Record {
    fn from(c: Checklist) -> Self {
        Record::Checklist(c)
    }
}
impl From<Todo> for Record {
    fn from(t: Todo) -> Self {
        Record::Todo(t)
    }
}
impl From<SessionNote> for Record {
    fn from(n: SessionNote) -> Self {
        Record::SessionNote(n)
    }
}

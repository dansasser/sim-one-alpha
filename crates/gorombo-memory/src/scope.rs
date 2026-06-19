//! Scope matching and precedence for structured-memory records.
//!
//! Every record is keyed by scope. Scope precedence (most specific wins):
//!   1. projectId + conversationId
//!   2. projectId
//!   3. conversationId
//!   4. actorId
//!   5. global
//!
//! `matches(record_scope, query_scope)` returns true when the query carries
//! every key the record carries at the same or higher precedence. It never
//! crosses to a different `actorId` or `projectId`; that is the Rust trust
//! boundary.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub global: Option<bool>,
}

impl Scope {
    pub fn is_empty(&self) -> bool {
        self.actor_id.is_none()
            && self.conversation_id.is_none()
            && self.project_id.is_none()
            && self.thread_id.is_none()
            && !self.global.unwrap_or(false)
    }

    /// 1 = most specific (projectId + conversationId), 5 = global, 0 = empty.
    pub fn precedence(&self) -> u8 {
        if self.project_id.is_some() && self.conversation_id.is_some() {
            1
        } else if self.project_id.is_some() {
            2
        } else if self.conversation_id.is_some() {
            3
        } else if self.actor_id.is_some() {
            4
        } else if self.global.unwrap_or(false) {
            5
        } else {
            0
        }
    }

    /// A query `q` matches a record `r` when every key the record carries is
    /// also present on the query with an equal value, AND the record is not
    /// scoped more specifically than the query can see. Global records are
    /// visible to every query.
    ///
    /// This is the trust boundary in Rust: a record scoped to projectId=A is
    /// never returned to a query whose projectId is B (or absent).
    pub fn matches(record: &Scope, query: &Scope) -> bool {
        if record.is_empty() {
            return false;
        }
        if record.global.unwrap_or(false) && only_global(record) {
            return true;
        }
        if let Some(ref r) = record.project_id {
            if query.project_id.as_deref() != Some(r.as_str()) {
                return false;
            }
        }
        if let Some(ref r) = record.conversation_id {
            if query.conversation_id.as_deref() != Some(r.as_str()) {
                return false;
            }
        }
        if let Some(ref r) = record.actor_id {
            if query.actor_id.as_deref() != Some(r.as_str()) {
                return false;
            }
        }
        if let Some(ref r) = record.thread_id {
            if query.thread_id.as_deref() != Some(r.as_str()) {
                return false;
            }
        }
        true
    }
}

fn only_global(scope: &Scope) -> bool {
    scope.actor_id.is_none()
        && scope.conversation_id.is_none()
        && scope.project_id.is_none()
        && scope.thread_id.is_none()
        && scope.global.unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s_project(p: &str) -> Scope {
        Scope {
            project_id: Some(p.to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn precedence_orders_by_specificity() {
        assert_eq!(
            Scope {
                project_id: Some("a".into()),
                conversation_id: Some("c".into()),
                ..Default::default()
            }
            .precedence(),
            1
        );
        assert_eq!(s_project("a").precedence(), 2);
        assert_eq!(
            Scope {
                conversation_id: Some("c".into()),
                ..Default::default()
            }
            .precedence(),
            3
        );
        assert_eq!(
            Scope {
                actor_id: Some("u".into()),
                ..Default::default()
            }
            .precedence(),
            4
        );
        assert_eq!(
            Scope {
                global: Some(true),
                ..Default::default()
            }
            .precedence(),
            5
        );
    }

    #[test]
    fn matches_isolates_projects() {
        let record = s_project("a");
        assert!(Scope::matches(&record, &s_project("a")));
        assert!(!Scope::matches(&record, &s_project("b")));
        // Absent query projectId cannot see a project-scoped record.
        assert!(!Scope::matches(&record, &Scope::default()));
    }

    #[test]
    fn matches_global_visible_to_all() {
        let global = Scope {
            global: Some(true),
            ..Default::default()
        };
        assert!(Scope::matches(&global, &s_project("a")));
        assert!(Scope::matches(&global, &Scope::default()));
    }
}

use serde::{Deserialize, Serialize};

/// Scope keys a memory record to a trusted identity/context.
/// All fields are optional; the most-specific present keys determine
/// precedence and isolation.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub global: Option<bool>,
}

impl Scope {
    /// Returns true when this scope explicitly requests global records.
    pub fn is_global(&self) -> bool {
        self.global == Some(true)
    }

    /// Precedence (lower number = more specific).
    ///
    /// 1. projectId + conversationId
    /// 2. projectId
    /// 3. conversationId
    /// 4. actorId
    /// 5. global
    pub fn precedence(&self) -> u8 {
        match (&self.project_id, &self.conversation_id) {
            (Some(_), Some(_)) => 1,
            (Some(_), None) => 2,
            (None, Some(_)) => 3,
            (None, None) => {
                if self.actor_id.is_some() {
                    4
                } else {
                    5
                }
            }
        }
    }
}

/// Determine whether `record_scope` is visible to `query_scope`.
///
/// Rules:
/// * If the query explicitly requests global records, only global records match.
/// * If the query carries actorId/conversationId/projectId/threadId, the record's
///   corresponding key must match exactly when both are present.
/// * The record must be at least as specific as the query (lower or equal precedence).
/// * Cross-actor and cross-project reads are always denied.
pub fn matches(record_scope: &Scope, query_scope: &Scope) -> bool {
    if query_scope.is_global() {
        return record_scope.is_global();
    }

    if let (Some(q), Some(r)) = (&query_scope.actor_id, &record_scope.actor_id) {
        if q != r {
            return false;
        }
    }
    if let (Some(q), Some(r)) = (
        &query_scope.conversation_id,
        &record_scope.conversation_id,
    ) {
        if q != r {
            return false;
        }
    }
    if let (Some(q), Some(r)) = (
        &query_scope.project_id,
        &record_scope.project_id,
    ) {
        if q != r {
            return false;
        }
    }
    if let (Some(q), Some(r)) = (
        &query_scope.thread_id,
        &record_scope.thread_id,
    ) {
        if q != r {
            return false;
        }
    }

    record_scope.precedence() <= query_scope.precedence()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(
        actor_id: Option<&str>,
        conversation_id: Option<&str>,
        project_id: Option<&str>,
    ) -> Scope {
        Scope {
            actor_id: actor_id.map(|s| s.to_string()),
            conversation_id: conversation_id.map(|s| s.to_string()),
            project_id: project_id.map(|s| s.to_string()),
            thread_id: None,
            global: None,
        }
    }

    #[test]
    fn precedence_project_conversation_is_most_specific() {
        let s = scope(None, Some("c"), Some("p"));
        assert_eq!(s.precedence(), 1);
    }

    #[test]
    fn precedence_project_only_is_second() {
        let s = scope(None, None, Some("p"));
        assert_eq!(s.precedence(), 2);
    }

    #[test]
    fn precedence_conversation_only_is_third() {
        let s = scope(None, Some("c"), None);
        assert_eq!(s.precedence(), 3);
    }

    #[test]
    fn precedence_actor_is_fourth() {
        let s = scope(Some("a"), None, None);
        assert_eq!(s.precedence(), 4);
    }

    #[test]
    fn precedence_global_is_fifth() {
        let s = Scope { global: Some(true), ..Default::default() };
        assert_eq!(s.precedence(), 5);
    }

    #[test]
    fn same_project_matches() {
        let record = scope(None, None, Some("p"));
        let query = scope(None, None, Some("p"));
        assert!(matches(&record, &query));
    }

    #[test]
    fn cross_project_denied() {
        let record = scope(None, None, Some("p1"));
        let query = scope(None, None, Some("p2"));
        assert!(!matches(&record, &query));
    }

    #[test]
    fn cross_actor_denied() {
        let record = scope(Some("a1"), None, None);
        let query = scope(Some("a2"), None, None);
        assert!(!matches(&record, &query));
    }

    #[test]
    fn more_specific_record_visible_to_broader_query() {
        let record = scope(None, Some("c"), Some("p"));
        let query = scope(None, None, Some("p"));
        assert!(matches(&record, &query));
    }

    #[test]
    fn broader_record_not_visible_to_specific_query() {
        let record = scope(None, None, Some("p"));
        let query = scope(None, Some("c"), Some("p"));
        assert!(!matches(&record, &query));
    }

    #[test]
    fn global_only_visible_to_global_query() {
        let record = Scope { global: Some(true), ..Default::default() };
        let query = Scope { global: Some(true), ..Default::default() };
        assert!(matches(&record, &query));

        let project_query = scope(None, None, Some("p"));
        assert!(!matches(&record, &project_query));
    }
}

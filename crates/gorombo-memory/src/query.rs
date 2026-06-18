use std::collections::{HashMap, HashSet};

use crate::index::InMemoryIndex;
use crate::record::Record;
use crate::scope::{matches, Scope};
use crate::MemoryHelperError;

pub struct QueryInput {
    pub text: Option<String>,
    pub tags: Vec<String>,
    pub kinds: Option<Vec<String>>,
    pub statuses: Option<Vec<String>>,
    pub scope: Scope,
    pub limit: usize,
}

pub struct QueryResult {
    pub records: Vec<Record>,
    pub total_scanned: usize,
}

/// Run a keyword and/or tag query over the in-memory index and merge results
/// with reciprocal rank fusion (k = 60).
pub fn query_records(index: &InMemoryIndex, input: QueryInput) -> Result<QueryResult, MemoryHelperError> {
    let limit = input.limit.clamp(1, 100);

    let words: Vec<String> = input
        .text
        .as_ref()
        .map(|t| {
            t.split_whitespace()
                .map(|w| w.to_lowercase())
                .filter(|w| !w.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let kinds: Option<HashSet<&str>> = input.kinds.as_ref().map(|list| {
        list.iter()
            .map(|s| s.as_str())
            .filter(|s| matches!(*s, "checklist" | "todo" | "session_note"))
            .collect()
    });
    let kinds_ref = kinds.as_ref();

    let statuses: Option<HashSet<&str>> =
        input.statuses.as_ref().map(|list| list.iter().map(|s| s.as_str()).collect());
    let statuses_ref = statuses.as_ref();

    let keyword_hits = index.query_keywords(
        &words, &input.scope, kinds_ref, statuses_ref, limit,
    );
    let tag_hits = index.query_tags(
        &input.tags, &input.scope, kinds_ref, statuses_ref, limit,
    );

    let merged = reciprocal_rank_fusion(
        &keyword_hits,
        &tag_hits,
        limit,
        &input.scope,
    );

    let total_scanned = keyword_hits.len() + tag_hits.len();

    Ok(QueryResult {
        records: merged,
        total_scanned,
    })
}

fn reciprocal_rank_fusion(
    keyword_hits: &[(Record, f64)],
    tag_hits: &[(Record, f64)],
    limit: usize,
    query_scope: &Scope,
) -> Vec<Record> {
    const K: f64 = 60.0;
    let mut scores: HashMap<String, (Record, f64)> = HashMap::new();

    for (rank, (record, _)) in keyword_hits.iter().enumerate() {
        let rrf = 1.0 / (K + rank as f64 + 1.0);
        let entry = scores
            .entry(record.id().to_string())
            .or_insert_with(|| (record.clone(), 0.0));
        entry.1 += rrf;
    }

    for (rank, (record, _)) in tag_hits.iter().enumerate() {
        let rrf = 1.0 / (K + rank as f64 + 1.0);
        let entry = scores
            .entry(record.id().to_string())
            .or_insert_with(|| (record.clone(), 0.0));
        entry.1 += rrf;
    }

    let mut ranked: Vec<(Record, f64)> = scores.into_values().collect();
    ranked.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.0.updated_at().cmp(a.0.updated_at()))
    });

    ranked
        .into_iter()
        .filter(|(record, _)| matches(record.scope(), query_scope))
        .map(|(record, _)| record)
        .take(limit)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::InMemoryIndex;
    use crate::scope::Scope;
    use crate::todo::Todo;

    fn make_todo(id: &str, title: &str, tags: &[&str], updated_at: &str) -> Record {
        Record::Todo(Todo {
            id: id.to_string(),
            title: title.to_string(),
            slug: None,
            description: None,
            scope: Scope::default(),
            priority: "normal".to_string(),
            status: "pending".to_string(),
            tags: tags.iter().map(|t| t.to_string()).collect(),
            due_at: None,
            completed_at: None,
            created_at: updated_at.to_string(),
            updated_at: updated_at.to_string(),
            updated_by: "test".to_string(),
            run_id: None,
        })
    }

    #[test]
    fn query_records_limits_results() {
        let mut index = InMemoryIndex::new();
        let records: Vec<Record> = (0..5)
            .map(|i| make_todo(&format!("{:02X}", i), "task", &[], "2026-06-18T00:00:00Z"))
            .collect();
        index.rebuild(&records);

        let result = query_records(
            &index,
            QueryInput {
                text: Some("task".to_string()),
                tags: vec![],
                kinds: None,
                statuses: None,
                scope: Scope::default(),
                limit: 2,
            },
        )
        .unwrap();

        assert_eq!(result.records.len(), 2);
        assert!(result.total_scanned >= 2);
    }

    #[test]
    fn query_records_respects_scope() {
        let mut index = InMemoryIndex::new();
        let scoped = make_todo("01A", "scoped task", &[], "2026-06-18T00:00:00Z");
        index.rebuild(&[scoped]);

        let result = query_records(
            &index,
            QueryInput {
                text: Some("task".to_string()),
                tags: vec![],
                kinds: None,
                statuses: None,
                scope: Scope {
                    project_id: Some("other".to_string()),
                    ..Default::default()
                },
                limit: 10,
            },
        )
        .unwrap();

        assert!(result.records.is_empty());
    }
}

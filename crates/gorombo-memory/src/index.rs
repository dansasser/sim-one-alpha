//! In-memory inverted index over structured-memory records.
//!
//! The WASM module keeps a `thread_local` store + index for the lifetime of
//! the loaded instance. The TS shim hydrates it from the durable store on
//! cold start via `reconcile_index`. Mutating exports keep the index in sync.
//! This is the only design that lets `query_records` (which receives no
//! records) answer without a per-call resync; the durable SQLite store
//! remains the source of truth across process restarts.

use std::collections::{HashMap, HashSet};

use crate::record::Record;

#[derive(Debug, Default)]
pub struct InMemoryIndex {
    by_id: HashMap<String, Record>,
    tag_index: HashMap<String, HashSet<String>>,
    title_index: HashMap<String, HashSet<String>>,
}

impl InMemoryIndex {
    pub fn insert(&mut self, record: Record) {
        let id = record.id().to_string();
        // Remove existing entry first so tag/title indexes stay clean.
        if self.by_id.contains_key(&id) {
            self.remove(&id);
        }
        let title_key = normalize(record.title());
        self.title_index
            .entry(title_key)
            .or_default()
            .insert(id.clone());
        for tag in record.tags() {
            self.tag_index
                .entry(normalize(tag))
                .or_default()
                .insert(id.clone());
        }
        self.by_id.insert(id, record);
    }

    pub fn remove(&mut self, id: &str) -> Option<Record> {
        let record = self.by_id.remove(id)?;
        let title_key = normalize(record.title());
        if let Some(set) = self.title_index.get_mut(&title_key) {
            set.remove(id);
            if set.is_empty() {
                self.title_index.remove(&title_key);
            }
        }
        for tag in record.tags() {
            let key = normalize(tag);
            if let Some(set) = self.tag_index.get_mut(&key) {
                set.remove(id);
                if set.is_empty() {
                    self.tag_index.remove(&key);
                }
            }
        }
        Some(record)
    }

    pub fn get(&self, id: &str) -> Option<&Record> {
        self.by_id.get(id)
    }

    pub fn len(&self) -> usize {
        self.by_id.len()
    }

    pub fn records(&self) -> impl Iterator<Item = &Record> {
        self.by_id.values()
    }

    /// Replace the whole index with a snapshot (cold-start hydration).
    pub fn rebuild(&mut self, records: Vec<Record>) {
        self.by_id.clear();
        self.tag_index.clear();
        self.title_index.clear();
        for record in records {
            self.insert(record);
        }
    }

    /// Keyword search across titles and tags. Returns `(record, score)` with
    /// score in 0..=1: exact-title match = 1.0, tag overlap = Jaccard, else
    /// keyword frequency in title (TF, normalized).
    pub fn query_keywords(&self, words: &[String], limit: usize) -> Vec<(Record, f64)> {
        if words.is_empty() {
            return self.by_id.values().cloned().map(|r| (r, 0.0)).take(limit).collect();
        }
        let mut scored: Vec<(Record, f64)> = self
            .by_id
            .values()
            .map(|record| (record.clone(), score_record(record, words)))
            .filter(|(_, score)| *score > 0.0)
            .collect();
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(limit);
        scored
    }

    /// Tag intersection search. Score = fraction of query tags present.
    ///
    /// Uses the `tag_index` inverted index to collect only candidate record IDs
    /// that carry at least one matching tag, then scores those candidates. This
    /// is O(K) over matching records rather than O(N) over the full index.
    pub fn query_tags(&self, tags: &[String], limit: usize) -> Vec<(Record, f64)> {
        if tags.is_empty() {
            return Vec::new();
        }
        let norm_tags: Vec<String> = tags.iter().map(|t| normalize(t)).collect();
        // Collect candidate record IDs from the tag inverted index (union of
        // all IDs that carry at least one of the query tags).
        let mut candidate_ids: HashSet<String> = HashSet::new();
        for tag in &norm_tags {
            if let Some(ids) = self.tag_index.get(tag) {
                for id in ids {
                    candidate_ids.insert(id.clone());
                }
            }
        }
        let mut scored: Vec<(Record, f64)> = candidate_ids
            .iter()
            .filter_map(|id| self.by_id.get(id))
            .map(|record| {
                let record_tags: HashSet<String> =
                    record.tags().iter().map(|t| normalize(t)).collect();
                let hit = norm_tags.iter().filter(|t| record_tags.contains(*t)).count();
                (record.clone(), hit as f64 / norm_tags.len() as f64)
            })
            .filter(|(_, score)| *score > 0.0)
            .collect();
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(limit);
        scored
    }
}

fn normalize(s: &str) -> String {
    s.to_lowercase()
}

fn score_record(record: &Record, words: &[String]) -> f64 {
    let title = normalize(record.title());
    // Exact title match against the single-word query.
    if words.len() == 1 && title == normalize(&words[0]) {
        return 1.0;
    }
    let lower_words: Vec<String> = words.iter().map(|w| normalize(w)).collect();
    let mut hits = 0usize;
    for w in &lower_words {
        if title.contains(w) {
            hits += 1;
        }
    }
    // TF normalized by query length, capped below the exact-title score.
    (hits as f64 / lower_words.len() as f64) * 0.7
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_record(id: &str, title: &str, tags: &[&str]) -> Record {
        use crate::checklist::{Checklist, ChecklistKind, ChecklistStatus};
        use crate::scope::Scope;
        Checklist {
            id: id.into(),
            kind: ChecklistKind::Checklist,
            title: title.into(),
            slug: id.into(),
            description: None,
            scope: Scope {
                project_id: Some("p".into()),
                ..Default::default()
            },
            tags: tags.iter().map(|s| s.to_string()).collect(),
            status: ChecklistStatus::Active,
            items: Vec::new(),
            created_at: "2026-06-18T00:00:00Z".into(),
            updated_at: "2026-06-18T00:00:00Z".into(),
            updated_by: "test".into(),
            run_id: None,
            archived_at: None,
        }
        .into()
    }

    #[test]
    fn rebuild_insert_remove_roundtrip() {
        let mut index = InMemoryIndex::default();
        index.rebuild(vec![mk_record("1", "Phase 0", &["setup"])]);
        assert_eq!(index.len(), 1);
        index.insert(mk_record("2", "Phase 1", &["build"]));
        assert_eq!(index.len(), 2);
        assert!(index.remove("1").is_some());
        assert_eq!(index.len(), 1);
    }

    #[test]
    fn query_keywords_ranks_exact_title_first() {
        let mut index = InMemoryIndex::default();
        index.rebuild(vec![
            mk_record("1", "Phase 0 prep", &[]),
            mk_record("2", "phase", &[]),
            mk_record("3", "unrelated", &[]),
        ]);
        let res = index.query_keywords(&["phase".to_string()], 10);
        assert_eq!(res[0].0.id(), "2");
        assert!(res[0].1 >= 1.0);
    }

    #[test]
    fn query_tags_intersection_scores() {
        let mut index = InMemoryIndex::default();
        index.rebuild(vec![
            mk_record("1", "a", &["setup", "phase0"]),
            mk_record("2", "b", &["setup"]),
        ]);
        let res = index.query_tags(&["setup".to_string(), "phase0".to_string()], 10);
        assert_eq!(res[0].0.id(), "1");
        assert!((res[0].1 - 1.0).abs() < f64::EPSILON);
    }
}

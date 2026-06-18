use std::collections::{HashMap, HashSet};

use crate::record::Record;
use crate::scope::{matches, Scope};

/// Lightweight inverted index for tag and keyword search over memory records.
///
/// The index is rebuilt from a snapshot on every cold start and mutated
/// incrementally by CRUD operations. It does not hold durable state.
pub struct InMemoryIndex {
    by_id: HashMap<String, Record>,
    by_kind: HashMap<&'static str, HashSet<String>>,
    tag_index: HashMap<String, HashSet<String>>,
    title_index: HashMap<String, HashSet<String>>,
    word_index: HashMap<String, HashSet<String>>,
}

impl InMemoryIndex {
    pub fn new() -> Self {
        Self {
            by_id: HashMap::new(),
            by_kind: HashMap::from([
                ("checklist", HashSet::new()),
                ("todo", HashSet::new()),
                ("session_note", HashSet::new()),
            ]),
            tag_index: HashMap::new(),
            title_index: HashMap::new(),
            word_index: HashMap::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.by_id.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_id.is_empty()
    }

    pub fn rebuild(&mut self, records: &[Record]) {
        self.clear();
        for record in records {
            self.insert(record);
        }
    }

    pub fn insert(&mut self, record: &Record) {
        self.remove(record.id());

        self.by_id.insert(record.id().to_string(), record.clone());
        self.by_kind
            .entry(record.kind())
            .or_default()
            .insert(record.id().to_string());

        for tag in record.tags() {
            self.tag_index
                .entry(tag.to_lowercase())
                .or_default()
                .insert(record.id().to_string());
        }

        let title_key = record.title().to_lowercase();
        self.title_index
            .entry(title_key)
            .or_default()
            .insert(record.id().to_string());

        let slug = match record {
            Record::Checklist(c) => Some(c.slug.clone()),
            Record::Todo(t) => t.slug.clone(),
            Record::SessionNote(_) => None,
        };
        if let Some(slug) = slug {
            self.title_index
                .entry(slug.to_lowercase())
                .or_default()
                .insert(record.id().to_string());
        }

        for word in unique_words(
            &record
                .searchable_text()
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>(),
        ) {
            self.word_index
                .entry(word)
                .or_default()
                .insert(record.id().to_string());
        }
    }

    pub fn remove(&mut self, id: &str) {
        let Some(record) = self.by_id.remove(id) else {
            return;
        };

        if let Some(set) = self.by_kind.get_mut(record.kind()) {
            set.remove(id);
        }

        for tag in record.tags() {
            if let Some(set) = self.tag_index.get_mut(&tag.to_lowercase()) {
                set.remove(id);
            }
        }

        let title_key = record.title().to_lowercase();
        if let Some(set) = self.title_index.get_mut(&title_key) {
            set.remove(id);
        }

        let slug = match record {
            Record::Checklist(ref c) => Some(c.slug.clone()),
            Record::Todo(ref t) => t.slug.clone(),
            Record::SessionNote(_) => None,
        };
        if let Some(slug) = slug {
            if let Some(set) = self.title_index.get_mut(&slug.to_lowercase()) {
                set.remove(id);
            }
        }

        for word in unique_words(
            &record
                .searchable_text()
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>(),
        ) {
            if let Some(set) = self.word_index.get_mut(&word) {
                set.remove(id);
            }
        }
    }

    pub fn get(&self, id: &str) -> Option<&Record> {
        self.by_id.get(id)
    }

    /// Keyword search. Returns records with a score in [0, 1].
    pub fn query_keywords(
        &self,
        words: &[String],
        scope: &Scope,
        kinds: Option<&HashSet<&str>>,
        status: Option<&HashSet<&str>>,
        limit: usize,
    ) -> Vec<(Record, f64)> {
        if words.is_empty() {
            return vec![];
        }

        let lowered: Vec<String> = words.iter().map(|w| w.to_lowercase()).collect();
        let candidates = self.candidate_ids(scope, kinds, status);
        let mut scored: Vec<(Record, f64)> = candidates
            .iter()
            .filter_map(|id| self.by_id.get(id))
            .map(|record| {
                let score = score_keywords(record, &lowered);
                (record.clone(), score)
            })
            .filter(|(_, score)| *score > 0.0)
            .collect();

        scored.sort_by(|a, b| {
            b.1
                .partial_cmp(&a.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.0.updated_at().cmp(a.0.updated_at()))
        });
        scored.into_iter().take(limit).collect()
    }

    /// Tag search. Returns records whose tags overlap with `tags`.
    pub fn query_tags(
        &self,
        tags: &[String],
        scope: &Scope,
        kinds: Option<&HashSet<&str>>,
        status: Option<&HashSet<&str>>,
        limit: usize,
    ) -> Vec<(Record, f64)> {
        if tags.is_empty() {
            return vec![];
        }

        let lowered: Vec<String> = tags.iter().map(|t| t.to_lowercase()).collect();
        let candidates = self.candidate_ids(scope, kinds, status);

        let mut scored: Vec<(Record, f64)> = candidates
            .iter()
            .filter_map(|id| self.by_id.get(id))
            .map(|record| {
                let score = score_tags(record, &lowered);
                (record.clone(), score)
            })
            .filter(|(_, score)| *score > 0.0)
            .collect();

        scored.sort_by(|a, b| {
            b.1
                .partial_cmp(&a.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.0.updated_at().cmp(a.0.updated_at()))
        });
        scored.into_iter().take(limit).collect()
    }

    /// All record ids that match scope/kind/status filters.
    fn candidate_ids(
        &self,
        scope: &Scope,
        kinds: Option<&HashSet<&str>>,
        status: Option<&HashSet<&str>>,
    ) -> HashSet<String> {
        let mut ids: HashSet<String> = HashSet::new();

        let kind_keys: Vec<&str> = match kinds {
            Some(set) => set.iter().copied().collect(),
            None => self.by_kind.keys().copied().collect(),
        };

        for kind in kind_keys {
            if let Some(set) = self.by_kind.get(kind) {
                for id in set {
                    if let Some(record) = self.by_id.get(id) {
                        if matches(record.scope(), scope) {
                            if let Some(status) = status {
                                if !status.contains(record.status()) {
                                    continue;
                                }
                            }
                            ids.insert(id.clone());
                        }
                    }
                }
            }
        }

        ids
    }

    fn clear(&mut self) {
        self.by_id.clear();
        self.by_kind.values_mut().for_each(|s| s.clear());
        self.tag_index.clear();
        self.title_index.clear();
        self.word_index.clear();
    }
}

fn unique_words(texts: &[&str]) -> HashSet<String> {
    let mut words = HashSet::new();
    for text in texts {
        for word in text.split_whitespace() {
            let clean = word
                .to_lowercase()
                .chars()
                .filter(|c| c.is_alphanumeric())
                .collect::<String>();
            if !clean.is_empty() {
                words.insert(clean);
            }
        }
    }
    words
}

fn score_keywords(record: &Record, words: &[String]) -> f64 {
    let title_lower = record.title().to_lowercase();
    let query_lower = words.join(" ");

    // Exact title or slug match is the strongest signal.
    if title_lower == query_lower {
        return 1.0;
    }
    if let Record::Todo(t) = record {
        if let Some(slug) = &t.slug {
            if slug.to_lowercase() == query_lower {
                return 1.0;
            }
        }
    }
    if let Record::Checklist(c) = record {
        if c.slug.to_lowercase() == query_lower {
            return 1.0;
        }
    }

    // Score by word overlap in the title.
    let title_words = unique_words(&[record.title()]);
    let query_words: HashSet<String> = words.iter().cloned().collect();
    let title_overlap = title_words.intersection(&query_words).count();
    let title_denom = title_words.len().max(query_words.len()).max(1);
    let title_score = title_overlap as f64 / title_denom as f64;

    // Small bonus for matches in description, tags, and (for checklists) item titles.
    let searchable = record.searchable_text();
    let mut extra_hits = 0usize;
    for word in words {
        for token in &searchable {
            if token.contains(word) {
                extra_hits += 1;
            }
        }
    }
    let extra_denom = searchable.len().max(words.len()).max(1);
    let extra_score = extra_hits as f64 / extra_denom as f64;

    let score = title_score * 0.9 + extra_score * 0.1;
    if score > 0.0 { score } else { 0.0 }
}

fn score_tags(record: &Record, tags: &[String]) -> f64 {
    let record_tags: HashSet<String> = record.tags().iter().map(|t| t.to_lowercase()).collect();
    if record_tags.is_empty() || tags.is_empty() {
        return 0.0;
    }

    let query_set: HashSet<String> = tags.iter().cloned().collect();
    let intersection: HashSet<String> = record_tags.intersection(&query_set).cloned().collect();
    let union_size = record_tags.union(&query_set).count();

    if union_size == 0 {
        return 0.0;
    }

    intersection.len() as f64 / union_size as f64
}

#[cfg(test)]
mod tests {
    use super::*;
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
    fn rebuild_populates_index() {
        let mut index = InMemoryIndex::new();
        let record = make_todo("01ABCDEF", "buy milk", &["errands"], "2026-06-18T00:00:00Z");
        index.rebuild(&[record]);
        assert_eq!(index.len(), 1);
    }

    #[test]
    fn exact_title_ranks_highest() {
        let mut index = InMemoryIndex::new();
        let exact = make_todo("01A", "review pull request", &[], "2026-06-18T00:00:00Z");
        let partial = make_todo("01B", "pull request review checklist", &[], "2026-06-18T00:00:00Z");
        index.rebuild(&[exact, partial]);

        let results = index.query_keywords(
            &["review".to_string(), "pull".to_string(), "request".to_string()],
            &Scope::default(),
            None,
            None,
            10,
        );
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].0.id(), "01A");
        assert!(results[0].1 > results[1].1);
    }

    #[test]
    fn tag_overlap_scores() {
        let mut index = InMemoryIndex::new();
        let a = make_todo("01A", "a", &["rust", "wasm"], "2026-06-18T00:00:00Z");
        let b = make_todo("01B", "b", &["rust"], "2026-06-18T00:00:00Z");
        index.rebuild(&[a, b]);

        let results = index.query_tags(
            &["wasm".to_string()],
            &Scope::default(),
            None,
            None,
            10,
        );
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0.id(), "01A");
    }
}

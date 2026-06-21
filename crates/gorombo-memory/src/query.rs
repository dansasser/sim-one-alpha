//! Query planner: scope filter, ranking, truncation.

use serde::{Deserialize, Serialize};

use crate::index::InMemoryIndex;
use crate::record::Record;
use crate::scope::Scope;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryInput {
    pub scope: Scope,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kinds: Option<Vec<String>>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub include_archived: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct QueryResult {
    pub records: Vec<Record>,
    pub total_scanned: usize,
}

const DEFAULT_LIMIT: usize = 20;
const HARD_CAP: usize = 100;

pub fn run_query(index: &InMemoryIndex, input: &QueryInput) -> QueryResult {
    let limit = input.limit.unwrap_or(DEFAULT_LIMIT).min(HARD_CAP);
    let include_archived = input.include_archived.unwrap_or(false);
    let kinds = input.kinds.clone().unwrap_or_default();

    // Scope + kind + archive filter pass.
    let mut candidates: Vec<Record> = index
        .records()
        .filter(|record| {
            if !include_archived && record.is_archived() {
                return false;
            }
            if !kinds.is_empty() && !kinds.iter().any(|k| k == record.kind_str()) {
                return false;
            }
            Scope::matches(record.scope(), &input.scope)
        })
        .cloned()
        .collect();

    let total_scanned = candidates.len();

    let text = input.text.as_deref().unwrap_or("").trim();
    let tags = input.tags.clone().unwrap_or_default();
    let words: Vec<String> = text
        .split_whitespace()
        .map(|s| s.to_lowercase())
        .collect();

    if !words.is_empty() || !tags.is_empty() {
        // Score each candidate by max of keyword and tag scores.
        let mut scored: Vec<(Record, f64)> = candidates
            .into_iter()
            .map(|record| {
                let kw = keyword_score(&record, &words);
                let tag = tag_score(&record, &tags);
                let base = kw.max(tag);
                (record, base)
            })
            .filter(|(_, score)| *score > 0.0)
            .collect();
        scored.sort_by(|a, b| {
            b.1.partial_cmp(&a.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.0.updated_at().cmp(a.0.updated_at()))
                .then_with(|| a.0.id().cmp(b.0.id()))
        });
        scored.truncate(limit);
        QueryResult {
            records: scored.into_iter().map(|(r, _)| r).collect(),
            total_scanned,
        }
    } else {
        candidates.sort_by(|a, b| {
            b.updated_at()
                .cmp(a.updated_at())
                .then_with(|| a.id().cmp(b.id()))
        });
        candidates.truncate(limit);
        QueryResult {
            records: candidates,
            total_scanned,
        }
    }
}

fn keyword_score(record: &Record, words: &[String]) -> f64 {
    if words.is_empty() {
        return 0.0;
    }
    let title = record.title().to_lowercase();
    if words.len() == 1 && title == words[0] {
        return 1.0;
    }
    let hits = words.iter().filter(|w| title.contains(*w)).count();
    (hits as f64 / words.len() as f64) * 0.7
}

fn tag_score(record: &Record, tags: &[String]) -> f64 {
    if tags.is_empty() {
        return 0.0;
    }
    let norm_tags: Vec<String> = tags.iter().map(|t| t.to_lowercase()).collect();
    let record_tags: Vec<String> = record.tags().iter().map(|t| t.to_lowercase()).collect();
    let hit = norm_tags.iter().filter(|t| record_tags.contains(t)).count();
    hit as f64 / norm_tags.len() as f64
}

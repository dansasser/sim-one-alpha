use serde::{Deserialize, Serialize};

use crate::scope::Scope;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checklist {
    pub id: String,
    pub title: String,
    pub slug: String,
    pub description: Option<String>,
    pub scope: Scope,
    pub tags: Vec<String>,
    pub status: String,
    pub items: Vec<ChecklistItem>,
    pub created_at: String,
    pub updated_at: String,
    pub updated_by: String,
    pub run_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecklistItem {
    pub id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub status: String,
    pub ordinal: f64,
    pub tags: Vec<String>,
    pub due_at: Option<String>,
    pub completed_at: Option<String>,
    pub children: Vec<ChecklistItem>,
}

impl ChecklistItem {
    /// Collect this item and all descendants into a flat vector,
    /// preserving parent_id links. Useful for indexing and mutation.
    pub fn flatten(&self, parent_id: Option<String>) -> Vec<ChecklistItem> {
        let mut flat = vec![ChecklistItem {
            id: self.id.clone(),
            parent_id,
            title: self.title.clone(),
            description: self.description.clone(),
            status: self.status.clone(),
            ordinal: self.ordinal,
            tags: self.tags.clone(),
            due_at: self.due_at.clone(),
            completed_at: self.completed_at.clone(),
            children: vec![],
        }];
        for child in &self.children {
            flat.extend(child.flatten(Some(self.id.clone())));
        }
        flat
    }
}

/// Rebuild a tree of `ChecklistItem`s from a flat list keyed by `parent_id`.
/// Items are sorted by ordinal within each parent.
pub fn build_item_tree(mut flat: Vec<ChecklistItem>) -> Vec<ChecklistItem> {
    flat.sort_by(|a, b| a.ordinal.partial_cmp(&b.ordinal).unwrap_or(std::cmp::Ordering::Equal));

    let mut by_id: std::collections::HashMap<String, ChecklistItem> =
        std::collections::HashMap::with_capacity(flat.len());
    let mut children_by_parent: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    let mut roots: Vec<String> = Vec::new();

    for item in flat {
        let id = item.id.clone();
        if let Some(parent_id) = &item.parent_id {
            children_by_parent
                .entry(parent_id.clone())
                .or_default()
                .push(id.clone());
        } else {
            roots.push(id.clone());
        }
        by_id.insert(id, item);
    }

    fn build(
        id: &str,
        by_id: &mut std::collections::HashMap<String, ChecklistItem>,
        children_by_parent: &std::collections::HashMap<String, Vec<String>>,
    ) -> Option<ChecklistItem> {
        let mut item = by_id.remove(id)?;
        if let Some(child_ids) = children_by_parent.get(id) {
            for child_id in child_ids {
                if let Some(child) = build(child_id, by_id, children_by_parent) {
                    item.children.push(child);
                }
            }
        }
        Some(item)
    }

    let mut tree: Vec<ChecklistItem> = Vec::new();
    for root_id in roots {
        if let Some(item) = build(&root_id, &mut by_id, &children_by_parent) {
            tree.push(item);
        }
    }

    // Any remaining items had a missing parent; surface them as roots rather
    // than silently dropping data.
    let orphans: Vec<ChecklistItem> = by_id.into_values().collect();
    tree.extend(orphans);

    tree
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, parent_id: Option<&str>, ordinal: f64) -> ChecklistItem {
        ChecklistItem {
            id: id.to_string(),
            parent_id: parent_id.map(|s| s.to_string()),
            title: format!("item {}", id),
            description: None,
            status: "pending".to_string(),
            ordinal,
            tags: vec![],
            due_at: None,
            completed_at: None,
            children: vec![],
        }
    }

    #[test]
    fn flatten_and_rebuild_are_inverses() {
        let child = item("child", Some("root"), 1.0);
        let root = ChecklistItem {
            id: "root".to_string(),
            parent_id: None,
            title: "root".to_string(),
            description: None,
            status: "pending".to_string(),
            ordinal: 0.0,
            tags: vec![],
            due_at: None,
            completed_at: None,
            children: vec![child],
        };

        let flat = root.flatten(None);
        assert_eq!(flat.len(), 2);
        assert_eq!(flat[1].parent_id, Some("root".to_string()));

        let rebuilt = build_item_tree(flat);
        assert_eq!(rebuilt.len(), 1);
        assert_eq!(rebuilt[0].children.len(), 1);
        assert_eq!(rebuilt[0].children[0].id, "child");
    }
}

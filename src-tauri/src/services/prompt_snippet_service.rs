//! 快捷片段 CRUD 服务

use crate::error::{AppError, Result};
use crate::models::prompt_snippet::{
    CreateSnippetParams, PromptSnippet, SnippetStore, UpdateSnippetParams,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub struct PromptSnippetService {
    store_path: PathBuf,
    cache: Arc<Mutex<Option<SnippetStore>>>,
}

impl PromptSnippetService {
    pub fn new(config_dir: &Path) -> Self {
        let store_path = config_dir.join("prompt-snippets.json");
        Self {
            store_path,
            cache: Arc::new(Mutex::new(None)),
        }
    }

    fn load_store(&self) -> Result<SnippetStore> {
        if let Some(ref cache) = *self.cache.lock().unwrap() {
            return Ok(cache.clone());
        }
        let store = if self.store_path.exists() {
            let content = fs::read_to_string(&self.store_path)?;
            serde_json::from_str(&content).unwrap_or_else(|_| SnippetStore::default())
        } else {
            SnippetStore::default()
        };
        *self.cache.lock().unwrap() = Some(store.clone());
        Ok(store)
    }

    fn save_store(&self, store: &SnippetStore) -> Result<()> {
        if let Some(parent) = self.store_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let content = serde_json::to_string_pretty(store)?;
        fs::write(&self.store_path, content)?;
        *self.cache.lock().unwrap() = Some(store.clone());
        Ok(())
    }

    pub fn list_all_snippets(&self) -> Result<Vec<PromptSnippet>> {
        let store = self.load_store()?;
        Ok(store.snippets)
    }

    pub fn get_snippet(&self, id: &str) -> Result<Option<PromptSnippet>> {
        let store = self.load_store()?;
        Ok(store.snippets.into_iter().find(|s| s.id == id))
    }

    pub fn create_snippet(&self, params: CreateSnippetParams) -> Result<PromptSnippet> {
        let mut store = self.load_store()?;
        let now = chrono::Utc::now().timestamp_millis();

        // 检查名称重复
        if store.snippets.iter().any(|s| s.name == params.name) {
            return Err(AppError::ValidationError(format!(
                "片段名称 '{}' 已存在",
                params.name
            )));
        }

        let snippet = PromptSnippet {
            id: format!("snippet-{}", uuid::Uuid::new_v4()),
            name: params.name,
            description: params.description,
            content: params.content,
            variables: params.variables,
            enabled: params.enabled.unwrap_or(true),
            created_at: now,
            updated_at: now,
        };

        store.snippets.push(snippet.clone());
        store.version = "1.0.0".to_string();
        self.save_store(&store)?;
        Ok(snippet)
    }

    pub fn update_snippet(
        &self,
        id: &str,
        params: UpdateSnippetParams,
    ) -> Result<Option<PromptSnippet>> {
        let mut store = self.load_store()?;

        let idx = store.snippets.iter().position(|s| s.id == id);
        let Some(idx) = idx else {
            return Ok(None);
        };

        // 如果改名，先检查新名称是否重复
        if let Some(ref new_name) = params.name {
            if new_name != &store.snippets[idx].name {
                let duplicate = store
                    .snippets
                    .iter()
                    .enumerate()
                    .any(|(i, s)| i != idx && s.name == *new_name);
                if duplicate {
                    return Err(AppError::ValidationError(format!(
                        "片段名称 '{}' 已存在",
                        new_name
                    )));
                }
            }
        }

        let snippet = &mut store.snippets[idx];

        if let Some(ref new_name) = params.name {
            snippet.name = new_name.clone();
        }
        if let Some(desc) = params.description {
            snippet.description = Some(desc);
        }
        if let Some(content) = params.content {
            snippet.content = content;
        }
        if let Some(variables) = params.variables {
            snippet.variables = variables;
        }
        if let Some(enabled) = params.enabled {
            snippet.enabled = enabled;
        }
        snippet.updated_at = chrono::Utc::now().timestamp_millis();

        let updated = snippet.clone();
        self.save_store(&store)?;
        Ok(Some(updated))
    }

    pub fn delete_snippet(&self, id: &str) -> Result<bool> {
        let mut store = self.load_store()?;
        let before = store.snippets.len();
        store.snippets.retain(|s| s.id != id);
        let deleted = store.snippets.len() < before;
        if deleted {
            self.save_store(&store)?;
        }
        Ok(deleted)
    }

    pub fn clear_cache(&self) {
        *self.cache.lock().unwrap() = None;
    }
}

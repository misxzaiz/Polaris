use std::fs;
use std::path::PathBuf;

use crate::error::Result;
use crate::models::plugin_state::PluginStateMap;

pub struct PluginStateService {
    config_dir: PathBuf,
}

impl PluginStateService {
    pub fn new(config_dir: PathBuf) -> Self {
        Self { config_dir }
    }

    fn state_path(&self) -> PathBuf {
        self.config_dir.join("plugins").join("state.json")
    }

    pub fn load(&self) -> Result<PluginStateMap> {
        let path = self.state_path();
        if !path.exists() {
            return Ok(PluginStateMap::new());
        }

        let content = fs::read_to_string(path)?;
        if content.trim().is_empty() {
            return Ok(PluginStateMap::new());
        }

        Ok(serde_json::from_str(&content)?)
    }

    pub fn save(&self, states: &PluginStateMap) -> Result<()> {
        let path = self.state_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        let tmp_path = path.with_extension("json.tmp");
        let content = serde_json::to_string_pretty(states)?;
        fs::write(&tmp_path, content)?;
        fs::rename(tmp_path, path)?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::plugin_state::PluginState;

    #[test]
    fn load_missing_file_returns_empty_state() {
        let temp_dir = tempfile::tempdir().unwrap();
        let service = PluginStateService::new(temp_dir.path().to_path_buf());

        let states = service.load().unwrap();

        assert!(states.is_empty());
    }

    #[test]
    fn save_then_load_roundtrips_plugin_state() {
        let temp_dir = tempfile::tempdir().unwrap();
        let service = PluginStateService::new(temp_dir.path().to_path_buf());

        let mut states = PluginStateMap::new();
        states.insert(
            "polaris.todo".to_string(),
            PluginState {
                enabled: true,
                ui_enabled: false,
                mcp_enabled: true,
            },
        );

        service.save(&states).unwrap();
        let loaded = service.load().unwrap();

        assert_eq!(loaded, states);
    }
}

/*! LSP 服务器配置持久化
 *
 * 存储路径: config_dir/lsp/servers.json
 * 模式: serde_json + atomic write（与 Todo/Scheduler 一致）
 */

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::Result;

/// 单个语言服务器配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerEntry {
    pub id: String,
    pub name: String,
    pub languages: Vec<String>,
    pub command: String,
    pub args: Vec<String>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// 运行模式："lsp"（启动语言服务器进程）或 "index"（轻量索引，无常驻进程）。
    /// 老配置缺省时按 "lsp" 处理，保证向后兼容。
    #[serde(default = "default_mode")]
    pub mode: String,
}

fn default_enabled() -> bool {
    true
}

fn default_mode() -> String {
    "lsp".to_string()
}

/// 持久化存储结构
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspConfigFile {
    pub version: u32,
    pub servers: Vec<LspServerEntry>,
}

impl Default for LspConfigFile {
    fn default() -> Self {
        Self {
            version: 1,
            servers: vec![LspServerEntry {
                id: "typescript-language-server".into(),
                name: "TypeScript Language Server".into(),
                languages: vec![
                    "typescript".into(),
                    "javascript".into(),
                    "typescriptreact".into(),
                    "javascriptreact".into(),
                ],
                command: "typescript-language-server".into(),
                args: vec!["--stdio".into()],
                enabled: true,
                mode: "lsp".into(),
            }],
        }
    }
}

/// LSP 配置仓库
pub struct LspConfigRepository {
    path: PathBuf,
    cache: LspConfigFile,
}

impl LspConfigRepository {
    pub fn new(config_dir: &Path) -> Self {
        let dir = config_dir.join("lsp");
        let path = dir.join("servers.json");
        let cache = Self::load_from_disk(&path).unwrap_or_default();
        Self { path, cache }
    }

    /// 读取全部服务器配置
    pub fn list(&self) -> &[LspServerEntry] {
        &self.cache.servers
    }

    /// 添加或更新服务器配置
    pub fn upsert(&mut self, entry: LspServerEntry) -> Result<()> {
        let idx = self.cache.servers.iter().position(|s| s.id == entry.id);
        if let Some(i) = idx {
            self.cache.servers[i] = entry;
        } else {
            self.cache.servers.push(entry);
        }
        self.save()
    }

    /// 删除服务器配置
    pub fn remove(&mut self, id: &str) -> Result<()> {
        self.cache.servers.retain(|s| s.id != id);
        self.save()
    }

    /// 更新 enabled 状态
    pub fn set_enabled(&mut self, id: &str, enabled: bool) -> Result<()> {
        let server = self.cache.servers.iter_mut().find(|s| s.id == id);
        if let Some(s) = server {
            s.enabled = enabled;
            self.save()?;
            Ok(())
        } else {
            Err(crate::error::AppError::SessionNotFound(id.to_string()))
        }
    }

    fn load_from_disk(path: &Path) -> std::result::Result<LspConfigFile, std::io::Error> {
        if !path.exists() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "config not found",
            ));
        }
        let data = std::fs::read_to_string(path)?;
        Ok(serde_json::from_str(&data)?)
    }

    fn save(&self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temp = self.path.with_extension("json.tmp");
        let content = serde_json::to_string_pretty(&self.cache)?;
        std::fs::write(&temp, format!("{}\n", content))?;
        std::fs::rename(&temp, &self.path)?;
        Ok(())
    }
}

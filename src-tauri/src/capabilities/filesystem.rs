/*! FileSystem Capability Seam
 *
 * 定义文件系统操作的核心接口，不依赖具体实现（本地/远程/加密）。
 *
 * 参考设计：deepseek-harness `dsh-fs` + `dsh-fs-local` + `dsh-tool-fs`。
 *
 * 默认 Provider：`DefaultFileSystemProvider`（从 SimpleAI fs 工具迁移）。
 * 插件可通过 toolProvider 覆盖（capability: "filesystem"）。
 */

use std::path::Path;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::error::Result;

/// 取消令牌（简化版，目前用 bool 标志位）
pub type CancellationToken = bool;

/// 文件系统能力抽象 trait
#[async_trait]
pub trait FileSystemCapability: Send + Sync {
    /// 读文件文本
    async fn read_text(&self, path: &Path, signal: CancellationToken) -> Result<String>;

    /// 写文件（原子写入）
    async fn write_text(&self, path: &Path, content: &str, signal: CancellationToken) -> Result<()>;

    /// 编辑文件（文字替换）
    async fn edit_text(
        &self,
        path: &Path,
        old_text: &str,
        new_text: &str,
        signal: CancellationToken,
    ) -> Result<()>;

    /// 列目录
    async fn list_directory(&self, path: &Path) -> Result<Vec<FsEntry>>;

    /// 文件内容搜索
    async fn search_files(
        &self,
        root: &Path,
        pattern: &str,
        signal: CancellationToken,
    ) -> Result<Vec<SearchMatch>>;

    /// 文件 glob 匹配
    async fn glob(
        &self,
        root: &Path,
        pattern: &str,
        signal: CancellationToken,
    ) -> Result<Vec<std::path::PathBuf>>;

    /// 应用补丁
    async fn apply_patch(&self, path: &Path, patch: &str, signal: CancellationToken) -> Result<()>;
}

/// 目录条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsEntry {
    pub name: String,
    pub path: std::path::PathBuf,
    pub kind: FsEntryKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

/// 目录条目类型
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FsEntryKind {
    File,
    Directory,
    Symlink,
    Other,
}

/// 搜索匹配
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchMatch {
    pub path: std::path::PathBuf,
    pub line: usize,
    pub column: usize,
    pub content: String,
}

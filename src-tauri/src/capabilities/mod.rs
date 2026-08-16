/*! Capability Seam 模块
 *
 * Phase 2：把硬编码在 SimpleAI 中的核心能力（shell/fs/compaction/subagent）
 * 抽象为可替换的 Rust trait seam，插件可通过 MCP server 声明覆盖。
 *
 * 设计参考 deepseek-harness 的 capability seam 三层分离：
 * - Service Definition（trait）：定义能力接口
 * - Service Provider（默认实现 + 插件覆盖）：实现 trait
 * - Consumer（工具/UI）：通过 seam 调用，不依赖具体 Provider
 *
 * 当前阶段（P2-T1~T4）只定义 trait + 默认 Provider，
 * Consumer 适配（让 SimpleAI 工具通过 seam 调用）在后续任务完成。
 */

pub mod shell;
pub mod filesystem;
pub mod compaction;
pub mod subagent;
pub mod registry;

pub use shell::{ShellCapability, ShellResult, ShellType};
pub use filesystem::{FileSystemCapability, FsEntry, FsEntryKind, SearchMatch};
pub use compaction::{CompactionCapability, CompactionContext, CompactionResult};
pub use subagent::{SubAgentCapability, SubAgentTask, SubAgentResult, SubAgentStatus};
pub use registry::{CapabilityRegistry, ProviderSource};

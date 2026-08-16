/*! Capability Registry
 *
 * 管理每个 capability 的 Provider 链。默认 Provider = 当前硬编码实现。
 * 插件可声明覆盖 Provider，注册表按优先级选择。
 *
 * 参考设计：deepseek-harness `ctx.agents` 的 Provider 注册表。
 *
 * 当前阶段（P2-T5）：定义注册表结构 + Provider 查询/注册/卸载。
 * Provider 覆盖通过 MCP server 通信（插件声明 mcpServerId），
 * 实际的 MCP 桥接在 Consumer 适配阶段完成。
 */

use std::collections::HashMap;
use std::sync::Arc;

use crate::capabilities::{
    CompactionCapability, FileSystemCapability, ShellCapability, SubAgentCapability,
};

/// Provider 来源
#[derive(Debug, Clone)]
pub enum ProviderSource {
    /// 默认内置实现
    Builtin,
    /// 插件声明覆盖
    Plugin {
        plugin_id: String,
        manifest_version: String,
    },
}

/// Provider 优先级（数值越大优先级越高）
fn source_priority(source: &ProviderSource) -> u8 {
    match source {
        ProviderSource::Builtin => 0,
        ProviderSource::Plugin { .. } => 100,
    }
}

/// 能力提供者注册表
///
/// 管理四个核心能力的 Provider 链。
/// 默认 Provider 在构造时注入，插件 Provider 通过 `register_*` 方法添加。
/// 查询时按优先级返回最高优先级的 Provider。
pub struct CapabilityRegistry {
    shell: Vec<(Arc<dyn ShellCapability>, ProviderSource)>,
    filesystem: Vec<(Arc<dyn FileSystemCapability>, ProviderSource)>,
    compaction: Vec<(Arc<dyn CompactionCapability>, ProviderSource)>,
    subagent: Vec<(Arc<dyn SubAgentCapability>, ProviderSource)>,
}

impl CapabilityRegistry {
    /// 创建空注册表
    pub fn new() -> Self {
        Self {
            shell: Vec::new(),
            filesystem: Vec::new(),
            compaction: Vec::new(),
            subagent: Vec::new(),
        }
    }

    /// 注册 shell Provider
    pub fn register_shell(&mut self, provider: Arc<dyn ShellCapability>, source: ProviderSource) {
        self.shell.push((provider, source));
    }

    /// 注册 filesystem Provider
    pub fn register_filesystem(
        &mut self,
        provider: Arc<dyn FileSystemCapability>,
        source: ProviderSource,
    ) {
        self.filesystem.push((provider, source));
    }

    /// 注册 compaction Provider
    pub fn register_compaction(
        &mut self,
        provider: Arc<dyn CompactionCapability>,
        source: ProviderSource,
    ) {
        self.compaction.push((provider, source));
    }

    /// 注册 subagent Provider
    pub fn register_subagent(
        &mut self,
        provider: Arc<dyn SubAgentCapability>,
        source: ProviderSource,
    ) {
        self.subagent.push((provider, source));
    }

    /// 查询 shell Provider（按优先级返回最高的）
    pub fn shell(&self) -> Option<Arc<dyn ShellCapability>> {
        self.shell
            .iter()
            .max_by_key(|(_, src)| source_priority(src))
            .map(|(p, _)| Arc::clone(p))
    }

    /// 查询 filesystem Provider
    pub fn filesystem(&self) -> Option<Arc<dyn FileSystemCapability>> {
        self.filesystem
            .iter()
            .max_by_key(|(_, src)| source_priority(src))
            .map(|(p, _)| Arc::clone(p))
    }

    /// 查询 compaction Provider
    pub fn compaction(&self) -> Option<Arc<dyn CompactionCapability>> {
        self.compaction
            .iter()
            .max_by_key(|(_, src)| source_priority(src))
            .map(|(p, _)| Arc::clone(p))
    }

    /// 查询 subagent Provider
    pub fn subagent(&self) -> Option<Arc<dyn SubAgentCapability>> {
        self.subagent
            .iter()
            .max_by_key(|(_, src)| source_priority(src))
            .map(|(p, _)| Arc::clone(p))
    }

    /// 卸载某插件的所有 Provider（插件禁用/卸载时调用）
    pub fn unregister_plugin(&mut self, plugin_id: &str) {
        let is_plugin = |src: &ProviderSource| match src {
            ProviderSource::Plugin { plugin_id: pid, .. } => pid == plugin_id,
            _ => false,
        };
        self.shell.retain(|(_, src)| !is_plugin(src));
        self.filesystem.retain(|(_, src)| !is_plugin(src));
        self.compaction.retain(|(_, src)| !is_plugin(src));
        self.subagent.retain(|(_, src)| !is_plugin(src));
    }

    /// 查询某 capability 是否被插件覆盖
    pub fn is_overridden(&self, capability: &str) -> bool {
        match capability {
            "shell" => self
                .shell
                .iter()
                .any(|(_, src)| matches!(src, ProviderSource::Plugin { .. })),
            "filesystem" => self
                .filesystem
                .iter()
                .any(|(_, src)| matches!(src, ProviderSource::Plugin { .. })),
            "compaction" => self
                .compaction
                .iter()
                .any(|(_, src)| matches!(src, ProviderSource::Plugin { .. })),
            "subagent" => self
                .subagent
                .iter()
                .any(|(_, src)| matches!(src, ProviderSource::Plugin { .. })),
            _ => false,
        }
    }
}

impl Default for CapabilityRegistry {
    fn default() -> Self {
        Self::new()
    }
}

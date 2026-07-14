/*! 引擎注册表
 *
 * 管理所有注册的 AI 引擎，提供统一的访问接口。
 */

use super::traits::{AIEngine, EngineId, SessionOptions};
use super::types::EngineStatus;
use crate::error::{AppError, Result};
use crate::models::config::Config;
use std::collections::HashMap;

/// 引擎注册表
pub struct EngineRegistry {
    /// 注册的引擎
    engines: HashMap<EngineId, Box<dyn AIEngine>>,
    /// 默认引擎
    default_engine: EngineId,
}

impl EngineRegistry {
    /// 创建新的引擎注册表
    pub fn new() -> Self {
        Self {
            engines: HashMap::new(),
            default_engine: EngineId::ClaudeCode,
        }
    }

    /// 注册引擎
    pub fn register<E: AIEngine + 'static>(&mut self, engine: E) {
        let id = engine.id();
        self.engines.insert(id, Box::new(engine));
    }

    /// 注册引擎（Box 版本）
    pub fn register_boxed(&mut self, engine: Box<dyn AIEngine>) {
        let id = engine.id();
        self.engines.insert(id, engine);
    }

    /// 设置默认引擎
    pub fn set_default(&mut self, id: EngineId) -> Result<()> {
        if self.engines.contains_key(&id) {
            self.default_engine = id;
            Ok(())
        } else {
            Err(AppError::ValidationError(format!("引擎 {} 未注册", id)))
        }
    }

    /// 获取默认引擎 ID
    pub fn default_engine_id(&self) -> EngineId {
        self.default_engine.clone()
    }

    /// 获取引擎
    pub fn get(&self, id: &EngineId) -> Option<&(dyn AIEngine + '_)> {
        self.engines.get(id).map(|e| e.as_ref())
    }

    /// 获取可变引擎
    pub fn get_mut(&mut self, id: &EngineId) -> Option<&mut (dyn AIEngine + '_)> {
        let engine = self.engines.get_mut(id)?;
        Some(engine.as_mut())
    }

    /// 检查引擎是否存在
    pub fn contains(&self, id: &EngineId) -> bool {
        self.engines.contains_key(id)
    }

    /// 检查引擎是否可用
    pub fn is_available(&self, id: &EngineId) -> bool {
        self.get(id).map(|e| e.is_available()).unwrap_or(false)
    }

    /// 列出所有可用引擎
    pub fn list_available(&self) -> Vec<EngineId> {
        self.engines
            .iter()
            .filter(|(_, e)| e.is_available())
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// 获取所有引擎状态
    pub fn get_all_status(&self) -> Vec<EngineStatus> {
        self.engines
            .values()
            .map(|e| EngineStatus::from_engine(e.as_ref()))
            .collect()
    }

    /// 启动会话
    pub fn start_session(
        &mut self,
        engine_id: Option<EngineId>,
        message: &str,
        options: SessionOptions,
    ) -> Result<String> {
        let id = engine_id.unwrap_or_else(|| self.default_engine.clone());

        let engine = self
            .get_mut(&id)
            .ok_or_else(|| AppError::ValidationError(format!("引擎 {} 未注册", id)))?;

        if !engine.is_available() {
            let reason = engine
                .unavailable_reason()
                .unwrap_or_else(|| "引擎不可用".to_string());
            return Err(AppError::ValidationError(reason));
        }

        engine.start_session(message, options)
    }

    /// 继续会话
    pub fn continue_session(
        &mut self,
        engine_id: EngineId,
        session_id: &str,
        message: &str,
        options: SessionOptions,
    ) -> Result<()> {
        let engine = self
            .get_mut(&engine_id)
            .ok_or_else(|| AppError::ValidationError(format!("引擎 {} 未注册", engine_id)))?;

        engine.continue_session(session_id, message, options)
    }

    pub fn compact_session(
        &mut self,
        engine_id: EngineId,
        session_id: &str,
        options: SessionOptions,
    ) -> Result<()> {
        let engine = self
            .get_mut(&engine_id)
            .ok_or_else(|| AppError::ValidationError(format!("引擎 {} 未注册", engine_id)))?;
        engine.compact_session(session_id, options)
    }

    pub fn restore_compaction(
        &mut self,
        engine_id: EngineId,
        session_id: &str,
        options: SessionOptions,
    ) -> Result<()> {
        let engine = self
            .get_mut(&engine_id)
            .ok_or_else(|| AppError::ValidationError(format!("引擎 {} 未注册", engine_id)))?;
        engine.restore_compaction(session_id, options)
    }

    /// 中断会话
    pub fn interrupt(&mut self, engine_id: &EngineId, session_id: &str) -> Result<()> {
        let engine = self
            .get_mut(engine_id)
            .ok_or_else(|| AppError::ValidationError(format!("引擎 {} 未注册", engine_id)))?;

        engine.interrupt(session_id)
    }

    /// 遍历所有引擎尝试中断会话
    pub fn try_interrupt_all(&mut self, session_id: &str) -> bool {
        for (id, engine) in &mut self.engines {
            if let Ok(()) = engine.interrupt(session_id) {
                tracing::info!("[EngineRegistry] 在引擎 {} 中成功中断会话", id);
                return true;
            }
        }
        false
    }

    /// 检查会话是否仍在任一引擎中运行
    ///
    /// Web 端断线重连后查询会话存活状态，用于恢复前端 isStreaming。
    pub fn is_session_active(&self, session_id: &str) -> bool {
        self.engines
            .values()
            .any(|engine| engine.has_active_session(session_id))
    }

    /// 向会话发送输入
    ///
    /// 尝试在所有引擎中找到对应的会话并发送输入
    pub fn send_input(&mut self, session_id: &str, input: &str) -> Result<bool> {
        for (id, engine) in &mut self.engines {
            match engine.send_input(session_id, input) {
                Ok(true) => {
                    tracing::info!("[EngineRegistry] 在引擎 {} 中成功发送输入", id);
                    return Ok(true);
                }
                Ok(false) => {
                    // 继续尝试其他引擎
                    continue;
                }
                Err(e) => {
                    tracing::debug!("[EngineRegistry] 引擎 {} 发送输入失败: {}", id, e);
                    continue;
                }
            }
        }
        tracing::warn!("[EngineRegistry] 未找到会话 {}", session_id);
        Ok(false)
    }

    /// 同步最新配置到所有已注册引擎(并失效内部缓存).
    ///
    /// 适用场景:用户在设置页面修改 CLI 路径或其他配置后,
    /// 需要让正在运行的引擎实例感知到变更,而不必重启应用.
    pub fn refresh_all_configs(&mut self, new_config: Config) {
        for (id, engine) in &mut self.engines {
            tracing::info!("[EngineRegistry] 刷新引擎 {} 的配置", id);
            engine.update_config(new_config.clone());
        }
    }
}

impl Default for EngineRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppError;
    use std::collections::HashSet;

    /// 测试用的轻量级 mock 引擎
    ///
    /// 维护一个内存中的 session 集合,只支持 interrupt 操作.
    /// 用于验证 EngineRegistry.interrupt / try_interrupt_all 的路由行为.
    struct MockEngine {
        id: EngineId,
        sessions: HashSet<String>,
    }

    impl MockEngine {
        fn new(id: EngineId, sessions: &[&str]) -> Self {
            Self {
                id,
                sessions: sessions.iter().map(|s| s.to_string()).collect(),
            }
        }
    }

    impl AIEngine for MockEngine {
        fn id(&self) -> EngineId {
            self.id.clone()
        }

        fn name(&self) -> &'static str {
            match self.id {
                EngineId::ClaudeCode => "MockClaude",
                EngineId::Codex => "MockCodex",
                EngineId::SimpleAI => "MockSimpleAI",
                EngineId::MimoCode => "MockMimo",
            }
        }

        fn is_available(&self) -> bool {
            true
        }

        fn start_session(&mut self, _message: &str, _options: SessionOptions) -> Result<String> {
            Err(AppError::Unknown("not implemented in mock".to_string()))
        }

        fn continue_session(
            &mut self,
            _session_id: &str,
            _message: &str,
            _options: SessionOptions,
        ) -> Result<()> {
            Err(AppError::Unknown("not implemented in mock".to_string()))
        }

        fn interrupt(&mut self, session_id: &str) -> Result<()> {
            if self.sessions.remove(session_id) {
                Ok(())
            } else {
                Err(AppError::ProcessError(format!(
                    "会话不存在: {}",
                    session_id
                )))
            }
        }
    }

    fn build_registry() -> EngineRegistry {
        let mut registry = EngineRegistry::new();
        // Claude 引擎持有 "claude-sess"
        registry.register(MockEngine::new(EngineId::ClaudeCode, &["claude-sess"]));
        // Codex 引擎持有 "codex-sess"
        registry.register(MockEngine::new(EngineId::Codex, &["codex-sess"]));
        registry
    }

    /// 基线: 按正确 engineId 中断对应 session 应该成功.
    #[test]
    fn interrupt_with_correct_engine_succeeds() {
        let mut registry = build_registry();
        assert!(registry
            .interrupt(&EngineId::ClaudeCode, "claude-sess")
            .is_ok());
        assert!(registry.interrupt(&EngineId::Codex, "codex-sess").is_ok());
    }

    /// 路由错配场景: 用 Claude 引擎中断 Codex session 必须失败.
    ///
    /// 这是 per-session 多引擎改造后的核心风险点:前端 metadata.engineId 与后端
    /// 实际引擎错配时,直接路由会找不到 session.
    #[test]
    fn interrupt_with_wrong_engine_fails() {
        let mut registry = build_registry();
        let err = registry
            .interrupt(&EngineId::ClaudeCode, "codex-sess")
            .unwrap_err();
        assert!(
            matches!(err, AppError::ProcessError(_)),
            "应返回 ProcessError,实际: {:?}",
            err
        );
    }

    /// 兜底场景: try_interrupt_all 应在遍历到正确引擎时返回 true.
    ///
    /// 这覆盖了 interrupt_chat_inner 的修复:当指定 engineId 路由失败时,
    /// 后端回退到 try_interrupt_all,本应能在另一个引擎中找到 session.
    #[test]
    fn try_interrupt_all_finds_session_in_any_engine() {
        let mut registry = build_registry();
        assert!(
            registry.try_interrupt_all("codex-sess"),
            "try_interrupt_all 应能在 Codex 引擎中找到 codex-sess"
        );
        assert!(
            registry.try_interrupt_all("claude-sess"),
            "try_interrupt_all 应能在 Claude 引擎中找到 claude-sess"
        );
    }

    /// 边界场景: session 在所有引擎中都不存在时,try_interrupt_all 返回 false.
    #[test]
    fn try_interrupt_all_returns_false_when_session_missing() {
        let mut registry = build_registry();
        assert!(!registry.try_interrupt_all("ghost-session"));
    }

    /// 兜底语义: interrupt 路由失败后,session 应当还在另一个引擎里能找到.
    ///
    /// 模拟 interrupt_chat_inner 修复后的完整逻辑:
    ///   1. 按 engineId 路由 -> 报错
    ///   2. 回退到 try_interrupt_all -> 命中真实引擎
    #[test]
    fn fallback_flow_recovers_misrouted_interrupt() {
        let mut registry = build_registry();

        // 步骤 1: 误把 codex-sess 当作 claude-code 的 session 中断
        let primary = registry.interrupt(&EngineId::ClaudeCode, "codex-sess");
        assert!(primary.is_err(), "误路由应失败");

        // 步骤 2: 兜底应能找到并中断
        assert!(
            registry.try_interrupt_all("codex-sess"),
            "兜底应在 Codex 引擎中找到并中断"
        );

        // 步骤 3: session 已被消费,再次兜底应返回 false
        assert!(
            !registry.try_interrupt_all("codex-sess"),
            "已中断过的 session 再次兜底应返回 false"
        );
    }
}

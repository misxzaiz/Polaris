//! P3 工具注入 per-tool 门（全局，P1 HookSystem 同构）
//!
//! 设计（plans/plugin-cap-inject-render-v1.md §2.3）：`cap.mcp set_plugin_tools` 把
//! 插件 MCP 工具的注入开关写进 `state.json`（`mcpToolGates`），本模块提供进程内
//! 全局镜像供 **SimpleAI 引擎层**（`McpClientPool::from_servers`）在 tools/list 后
//! 按 `(plugin_id, tool_name)` 过滤——引擎层拿不到 config_dir，只能走全局。
//!
//! 同步语义（v1「下一轮生效」）：
//! - 装配时（create_app_state）从 state.json 加载一次填全局；
//! - `set_plugin_tools` 写 state.json 后**重读再 put**（全局 = 文件实时镜像）；
//! - 下一轮 `prepare_mcp_config → from_servers` 读到最新值 → 生效。
//!
//! 缺省全放行（spec §6 向后兼容）：map 无该插件 / 无该工具 / 值为 true 均不挡。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// plugin_id → tool_name → enabled（true = 注入，false = 挡）。
static MCP_TOOL_GATES: OnceLock<Mutex<HashMap<String, HashMap<String, bool>>>> = OnceLock::new();

fn gates_mutex() -> &'static Mutex<HashMap<String, HashMap<String, bool>>> {
    MCP_TOOL_GATES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 装配时注入完整镜像（幂等：首次 put 生效，后续覆盖）。
pub fn put_mcp_tool_gates(map: HashMap<String, HashMap<String, bool>>) {
    match gates_mutex().lock() {
        Ok(mut g) => {
            *g = map;
        }
        Err(e) => {
            tracing::warn!("[mcpToolGates] put 加锁失败（毒锁）: {}", e);
        }
    }
}

/// 读取某插件的 per-tool 门快照（空 = 未配置，全放行）。
pub fn plugin_tool_gates(plugin_id: &str) -> HashMap<String, bool> {
    match gates_mutex().lock() {
        Ok(g) => g.get(plugin_id).cloned().unwrap_or_default(),
        Err(e) => {
            tracing::warn!("[mcpToolGates] 读加锁失败（毒锁）: {}", e);
            HashMap::new()
        }
    }
}

/// 某插件某工具是否被挡（true = 不注入）。缺省全放行。
pub fn is_tool_blocked(plugin_id: &str, tool_name: &str) -> bool {
    match plugin_tool_gates(plugin_id).get(tool_name) {
        Some(false) => true, // 显式关闭
        _ => false,          // 缺省 / true → 放行
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 直接构造缺省镜像（避免污染全局静态）。
    fn fresh_gates() -> &'static Mutex<HashMap<String, HashMap<String, bool>>> {
        MCP_TOOL_GATES.get_or_init(|| Mutex::new(HashMap::new()))
    }

    #[test]
    fn default_all_open() {
        // 空全局：任何插件工具都不挡（持锁至断言结束，防止编译器立即释放该同步锁）
        let _guard = fresh_gates().lock();
        assert!(!is_tool_blocked("mimo-tts", "mimo_tts_synthesize"));
        drop(_guard.unwrap());
    }

    #[test]
    fn explicit_false_blocks() {
        {
            let mut g = gates_mutex().lock().unwrap();
            g.clear();
            let mut tools = HashMap::new();
            tools.insert("mimo_tts_synthesize".to_string(), false);
            g.insert("mimo-tts".to_string(), tools);
        }
        assert!(is_tool_blocked("mimo-tts", "mimo_tts_synthesize"));
        // 同插件未配置工具仍放行
        assert!(!is_tool_blocked("mimo-tts", "other_tool"));
        // 其它插件不受影响
        assert!(!is_tool_blocked("polaris.ask", "ask_user_question"));
        // 清理，避免影响后续测试
        {
            let mut g = gates_mutex().lock().unwrap();
            g.clear();
        }
    }

    #[test]
    fn true_or_absent_is_open() {
        {
            let mut g = gates_mutex().lock().unwrap();
            g.clear();
            let mut tools = HashMap::new();
            tools.insert("keep".to_string(), true);
            g.insert("p".to_string(), tools);
        }
        assert!(!is_tool_blocked("p", "keep"));
        assert!(!is_tool_blocked("p", "absent"));
        {
            let mut g = gates_mutex().lock().unwrap();
            g.clear();
        }
    }
}

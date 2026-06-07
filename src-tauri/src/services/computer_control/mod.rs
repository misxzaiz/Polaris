//! 电脑操作核心（截图 / 鼠标键盘 / Windows 控件树）。
//!
//! 供两处共用，避免逻辑重复：
//! - `polaris-computer-mcp` 独立 MCP server（Claude Code / codex 引擎通过 MCP 调用）
//! - SimpleAI 引擎的 `computer` 原生工具（主进程内直接调用）
//!
//! 安全模型（首期 = 默认开启 + failsafe）：
//! - `enabled`：默认 `true`，可经 `POLARIS_COMPUTER_MCP_ENABLED=0` 关闭。
//! - `failsafe`：默认 `true`，鼠标移动到屏幕任一角落即中断所有副作用动作（紧急停止），
//!   参考微软 Windows 365 Agents 的 cursor failsafe 设计。
//! - 每个副作用动作执行前记 `tracing` 审计日志（target = "computer"）。

mod capture;
mod input;
mod inspect;

use enigo::{Enigo, Mouse, Settings};

use crate::error::{AppError, Result};

pub use capture::ScreenshotResult;

/// failsafe 角落判定的边距（像素）。光标落入任一屏幕角的该范围即触发急停。
const FAILSAFE_MARGIN_PX: i32 = 2;
/// 控件树遍历每层的兄弟节点上限，避免超大窗口导致输出爆炸。
const INSPECT_SIBLING_CAP: usize = 200;

/// 电脑操作配置。
#[derive(Debug, Clone)]
pub struct ComputerConfig {
    /// 总开关。关闭时所有工具返回错误。
    pub enabled: bool,
    /// failsafe 急停开关。
    pub failsafe: bool,
}

impl Default for ComputerConfig {
    /// 首期默认：开启 + failsafe（用户选定）。
    fn default() -> Self {
        Self {
            enabled: true,
            failsafe: true,
        }
    }
}

impl ComputerConfig {
    /// 从环境变量读取配置：
    /// - `POLARIS_COMPUTER_MCP_ENABLED`（默认 true；`0/false/no/off` 关闭）
    /// - `POLARIS_COMPUTER_FAILSAFE`（默认 true；同上语义）
    pub fn from_env() -> Self {
        Self {
            enabled: read_bool_env("POLARIS_COMPUTER_MCP_ENABLED", true),
            failsafe: read_bool_env("POLARIS_COMPUTER_FAILSAFE", true),
        }
    }
}

fn read_bool_env(name: &str, default: bool) -> bool {
    match std::env::var(name) {
        Ok(value) => {
            let normalized = value.trim().to_ascii_lowercase();
            if normalized.is_empty() {
                default
            } else {
                !matches!(normalized.as_str(), "0" | "false" | "no" | "off")
            }
        }
        Err(_) => default,
    }
}

/// 电脑操作控制器：持有一个 `Enigo` 实例（输入模拟有状态，需可变借用）。
pub struct ComputerController {
    config: ComputerConfig,
    enigo: Enigo,
}

impl ComputerController {
    /// 创建控制器。无桌面会话（headless）时 `Enigo::new` 会失败。
    pub fn new(config: ComputerConfig) -> Result<Self> {
        let enigo = Enigo::new(&Settings::default())
            .map_err(|e| AppError::ProcessError(format!("初始化输入控制器失败: {e}")))?;
        Ok(Self { config, enigo })
    }

    pub fn config(&self) -> &ComputerConfig {
        &self.config
    }

    fn ensure_enabled(&self) -> Result<()> {
        if self.config.enabled {
            Ok(())
        } else {
            Err(AppError::ValidationError(
                "电脑操作已被禁用（设置环境变量 POLARIS_COMPUTER_MCP_ENABLED=1 启用）".to_string(),
            ))
        }
    }

    /// failsafe：光标处于屏幕任一角落则中断（紧急停止逃生阀）。
    fn check_failsafe(&self) -> Result<()> {
        if !self.config.failsafe {
            return Ok(());
        }
        let (width, height) = self
            .enigo
            .main_display()
            .map_err(|e| AppError::ProcessError(format!("读取屏幕尺寸失败: {e}")))?;
        let (x, y) = self
            .enigo
            .location()
            .map_err(|e| AppError::ProcessError(format!("读取光标位置失败: {e}")))?;
        let m = FAILSAFE_MARGIN_PX;
        let near_x_edge = x <= m || x >= width - 1 - m;
        let near_y_edge = y <= m || y >= height - 1 - m;
        if near_x_edge && near_y_edge {
            return Err(AppError::ProcessError(
                "failsafe 触发：光标位于屏幕角落，已中断电脑操作".to_string(),
            ));
        }
        Ok(())
    }

    /// 所有产生副作用的动作执行前调用：校验开关 + failsafe + 审计日志。
    fn guard_action(&self, action: &str) -> Result<()> {
        self.ensure_enabled()?;
        self.check_failsafe()?;
        tracing::info!(target: "computer", action, "computer action");
        Ok(())
    }

    // ---------------------------------------------------------------- 只读

    /// 截取指定显示器（默认主显示器，index 0），返回 PNG(base64) + 尺寸。
    pub fn screenshot(&self, monitor_index: Option<usize>) -> Result<ScreenshotResult> {
        self.ensure_enabled()?;
        tracing::info!(target: "computer", "screenshot");
        capture::screenshot(monitor_index)
    }

    /// 当前鼠标坐标（绝对，屏幕左上角为原点）。
    pub fn cursor_position(&self) -> Result<(i32, i32)> {
        self.ensure_enabled()?;
        self.enigo
            .location()
            .map_err(|e| AppError::ProcessError(format!("读取光标位置失败: {e}")))
    }

    /// Windows 控件树（无障碍 UIAutomation）；非 Windows 返回错误。
    pub fn inspect_ui(&self, max_depth: usize) -> Result<serde_json::Value> {
        self.ensure_enabled()?;
        tracing::info!(target: "computer", max_depth, "inspect_ui");
        inspect::inspect_ui(max_depth, INSPECT_SIBLING_CAP)
    }

    // ------------------------------------------------------------ 副作用动作

    pub fn move_mouse(&mut self, x: i32, y: i32) -> Result<()> {
        self.guard_action(&format!("move_mouse({x},{y})"))?;
        input::move_mouse(&mut self.enigo, x, y)
    }

    pub fn click(
        &mut self,
        x: Option<i32>,
        y: Option<i32>,
        button: &str,
        double: bool,
    ) -> Result<()> {
        self.guard_action(&format!("click(x={x:?},y={y:?},button={button},double={double})"))?;
        input::click(&mut self.enigo, x, y, button, double)
    }

    pub fn type_text(&mut self, text: &str) -> Result<()> {
        self.guard_action("type_text")?;
        input::type_text(&mut self.enigo, text)
    }

    /// 组合键，如 `"ctrl+c"` / `"alt+f4"` / `"enter"`。
    pub fn press_key(&mut self, keys: &str) -> Result<()> {
        self.guard_action(&format!("press_key({keys})"))?;
        input::press_key(&mut self.enigo, keys)
    }

    /// 滚动：`dx` 水平、`dy` 垂直（正负代表方向，单位由平台决定的“行/刻度”）。
    pub fn scroll(&mut self, dx: i32, dy: i32) -> Result<()> {
        self.guard_action(&format!("scroll(dx={dx},dy={dy})"))?;
        input::scroll(&mut self.enigo, dx, dy)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_is_enabled_with_failsafe() {
        let cfg = ComputerConfig::default();
        assert!(cfg.enabled);
        assert!(cfg.failsafe);
    }

    #[test]
    fn read_bool_env_parses_falsey_values() {
        // 未设置 → default
        std::env::remove_var("POLARIS_TEST_FLAG_X");
        assert!(read_bool_env("POLARIS_TEST_FLAG_X", true));
        assert!(!read_bool_env("POLARIS_TEST_FLAG_X", false));
        // 显式假值
        std::env::set_var("POLARIS_TEST_FLAG_X", "0");
        assert!(!read_bool_env("POLARIS_TEST_FLAG_X", true));
        std::env::set_var("POLARIS_TEST_FLAG_X", "off");
        assert!(!read_bool_env("POLARIS_TEST_FLAG_X", true));
        // 其他值 → true
        std::env::set_var("POLARIS_TEST_FLAG_X", "1");
        assert!(read_bool_env("POLARIS_TEST_FLAG_X", false));
        std::env::remove_var("POLARIS_TEST_FLAG_X");
    }
}

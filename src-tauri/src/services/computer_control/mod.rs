//! 电脑操作核心（截图 / 鼠标键盘 / Windows 控件树 / 剪贴板）。
//!
//! 供两处共用，避免逻辑重复：
//! - `polaris-computer-mcp` 独立 MCP server（Claude Code / codex 引擎通过 MCP 调用）
//! - SimpleAI 引擎的 `computer` 原生工具（主进程内直接调用）
//!
//! 安全模型（默认开启 + failsafe）：
//! - `enabled`：默认 `true`，可经 `POLARIS_COMPUTER_MCP_ENABLED=0` 关闭。
//! - `failsafe`：默认 `true`，鼠标移动到屏幕任一角落即中断后续副作用动作（紧急停止）。
//! - 每个副作用动作执行前记 `tracing` 审计日志（target = "computer"）。
//!
//! 整个模块仅在 Windows 编译（见 `services/mod.rs`），因核心能力依赖 Windows UI Automation。

mod capture;
mod clipboard;
mod input;
mod inspect;

use std::sync::{Mutex, OnceLock};

use enigo::{Enigo, Mouse, Settings};

use crate::error::{AppError, Result};

pub use capture::ScreenshotResult;

/// failsafe 角落判定的边距（像素）。
const FAILSAFE_MARGIN_PX: i32 = 2;
/// 控件树遍历每层的兄弟节点上限。
const INSPECT_SIBLING_CAP: usize = 200;

/// 电脑操作配置。
#[derive(Debug, Clone)]
pub struct ComputerConfig {
    pub enabled: bool,
    pub failsafe: bool,
}

impl Default for ComputerConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            failsafe: true,
        }
    }
}

impl ComputerConfig {
    /// 从环境变量读取：`POLARIS_COMPUTER_MCP_ENABLED` / `POLARIS_COMPUTER_FAILSAFE`
    /// （默认 true；`0/false/no/off` 关闭）。
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

/// 进程级常驻控制器：供主进程内（如 SimpleAI 引擎）共享同一个 `ComputerController`，
/// 使 `mouse_down`/`mouse_up` 等跨调用的按键状态得以保持——每次新建实例会在 drop 时
/// 释放按下的键（enigo `release_keys_when_dropped` 默认 true）。
/// MCP server 进程自身已持久持有 controller，无需此单例。
static SHARED_CONTROLLER: OnceLock<Mutex<ComputerController>> = OnceLock::new();

impl ComputerController {
    pub fn new(config: ComputerConfig) -> Result<Self> {
        let enigo = Enigo::new(&Settings::default())
            .map_err(|e| AppError::ProcessError(format!("初始化输入控制器失败: {e}")))?;
        Ok(Self { config, enigo })
    }

    /// 获取进程级常驻控制器（首次按环境变量初始化）。
    /// 竞态下偶发多创建一个实例并丢弃，无副作用（被丢弃实例未按任何键）。
    pub fn shared() -> Result<&'static Mutex<ComputerController>> {
        if let Some(existing) = SHARED_CONTROLLER.get() {
            return Ok(existing);
        }
        let controller = ComputerController::new(ComputerConfig::from_env())?;
        Ok(SHARED_CONTROLLER.get_or_init(|| Mutex::new(controller)))
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

    /// 产生副作用的动作执行前调用：校验开关 + failsafe + 审计日志。
    fn guard_action(&self, action: &str) -> Result<()> {
        self.ensure_enabled()?;
        self.check_failsafe()?;
        tracing::info!(target: "computer", action, "computer action");
        Ok(())
    }

    // ---------------------------------------------------------------- 只读

    pub fn screenshot(
        &self,
        monitor_index: Option<usize>,
        region: Option<(u32, u32, u32, u32)>,
        scale: Option<f32>,
    ) -> Result<ScreenshotResult> {
        self.ensure_enabled()?;
        tracing::info!(target: "computer", "screenshot");
        capture::screenshot(monitor_index, region, scale)
    }

    pub fn cursor_position(&self) -> Result<(i32, i32)> {
        self.ensure_enabled()?;
        self.enigo
            .location()
            .map_err(|e| AppError::ProcessError(format!("读取光标位置失败: {e}")))
    }

    /// 前台控件树（无障碍 UIAutomation）。`interactable_only` 剔除无名噪声节点。
    pub fn inspect_ui(&self, max_depth: usize, interactable_only: bool) -> Result<serde_json::Value> {
        self.ensure_enabled()?;
        tracing::info!(target: "computer", max_depth, "inspect_ui");
        inspect::inspect_ui(max_depth, INSPECT_SIBLING_CAP, interactable_only)
    }

    pub fn clipboard_get(&self) -> Result<String> {
        self.ensure_enabled()?;
        clipboard::get_text()
    }

    // ------------------------------------------------------------ 副作用：鼠标/键盘

    pub fn move_mouse(&mut self, x: i32, y: i32) -> Result<()> {
        self.guard_action(&format!("move_mouse({x},{y})"))?;
        input::move_mouse(&mut self.enigo, x, y)
    }

    /// `count`：连击次数（1 单击 / 2 双击 / 3 三击）。
    pub fn click(
        &mut self,
        x: Option<i32>,
        y: Option<i32>,
        button: &str,
        count: u32,
    ) -> Result<()> {
        self.guard_action(&format!("click(x={x:?},y={y:?},button={button},count={count})"))?;
        input::click(&mut self.enigo, x, y, button, count)
    }

    pub fn drag(&mut self, from_x: i32, from_y: i32, to_x: i32, to_y: i32, button: &str) -> Result<()> {
        self.guard_action(&format!("drag(({from_x},{from_y})->({to_x},{to_y}),button={button})"))?;
        input::drag(&mut self.enigo, from_x, from_y, to_x, to_y, button)
    }

    pub fn mouse_down(&mut self, x: Option<i32>, y: Option<i32>, button: &str) -> Result<()> {
        self.guard_action(&format!("mouse_down(button={button})"))?;
        input::mouse_down(&mut self.enigo, x, y, button)
    }

    pub fn mouse_up(&mut self, x: Option<i32>, y: Option<i32>, button: &str) -> Result<()> {
        self.guard_action(&format!("mouse_up(button={button})"))?;
        input::mouse_up(&mut self.enigo, x, y, button)
    }

    pub fn type_text(&mut self, text: &str) -> Result<()> {
        self.guard_action("type_text")?;
        input::type_text(&mut self.enigo, text)
    }

    pub fn press_key(&mut self, keys: &str) -> Result<()> {
        self.guard_action(&format!("press_key({keys})"))?;
        input::press_key(&mut self.enigo, keys)
    }

    /// 按住组合键 `ms` 毫秒后释放。
    pub fn hold_key(&mut self, keys: &str, ms: u64) -> Result<()> {
        self.guard_action(&format!("hold_key({keys},{ms}ms)"))?;
        input::hold_key(&mut self.enigo, keys, ms)
    }

    pub fn scroll(&mut self, dx: i32, dy: i32) -> Result<()> {
        self.guard_action(&format!("scroll(dx={dx},dy={dy})"))?;
        input::scroll(&mut self.enigo, dx, dy)
    }

    // ------------------------------------------------- 副作用：结构化（控件直接操作）

    /// 按控件名/automationId 查找并直接点击（不靠坐标）。返回被点击控件名。
    pub fn click_element(
        &self,
        name: Option<&str>,
        automation_id: Option<&str>,
        button: &str,
        count: u32,
    ) -> Result<String> {
        self.guard_action(&format!("click_element(name={name:?},id={automation_id:?})"))?;
        inspect::click_element(name, automation_id, button, count)
    }

    /// 按控件名/automationId 查找并输入文本（聚焦后剪贴板粘贴）。返回控件名。
    pub fn set_text(
        &self,
        name: Option<&str>,
        automation_id: Option<&str>,
        text: &str,
    ) -> Result<String> {
        self.guard_action(&format!("set_text(name={name:?},id={automation_id:?})"))?;
        inspect::set_text(name, automation_id, text)
    }

    // ------------------------------------------------------------ 副作用：剪贴板

    pub fn clipboard_set(&self, text: &str) -> Result<()> {
        self.ensure_enabled()?;
        tracing::info!(target: "computer", "clipboard_set");
        clipboard::set_text(text)
    }

    // ------------------------------------------------- 查找 / 窗口管理

    /// 查找控件并返回信息（不操作）；`timeout_ms > 0` 时等待控件出现（wait_for 语义）。
    pub fn find_element(
        &self,
        name: Option<&str>,
        automation_id: Option<&str>,
        timeout_ms: u64,
    ) -> Result<serde_json::Value> {
        self.ensure_enabled()?;
        tracing::info!(target: "computer", "find_element");
        inspect::find_element_info(name, automation_id, timeout_ms)
    }

    /// 枚举顶层窗口（标题/应用/位置/状态）。
    pub fn list_windows(&self) -> Result<serde_json::Value> {
        self.ensure_enabled()?;
        tracing::info!(target: "computer", "list_windows");
        capture::list_windows()
    }

    /// 按标题激活（前置 + 聚焦）窗口。
    pub fn activate_window(&self, title: &str) -> Result<String> {
        self.guard_action(&format!("activate_window({title})"))?;
        inspect::activate_window(title)
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
        std::env::remove_var("POLARIS_TEST_FLAG_X");
        assert!(read_bool_env("POLARIS_TEST_FLAG_X", true));
        assert!(!read_bool_env("POLARIS_TEST_FLAG_X", false));
        std::env::set_var("POLARIS_TEST_FLAG_X", "0");
        assert!(!read_bool_env("POLARIS_TEST_FLAG_X", true));
        std::env::set_var("POLARIS_TEST_FLAG_X", "off");
        assert!(!read_bool_env("POLARIS_TEST_FLAG_X", true));
        std::env::set_var("POLARIS_TEST_FLAG_X", "1");
        assert!(read_bool_env("POLARIS_TEST_FLAG_X", false));
        std::env::remove_var("POLARIS_TEST_FLAG_X");
    }
}

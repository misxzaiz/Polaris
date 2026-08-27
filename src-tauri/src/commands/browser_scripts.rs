//! 浏览器注入脚本加载器
//!
//! 将独立 JS 文件通过 include_str! 编译时嵌入，
//! 替代浏览器命令模块中内联的 ~2000 行 JS 字符串。
//! 独立文件可用 IDE 语法高亮、lint 和格式化。

use crate::commands::browser::BrowserRect;

pub const PAGE_CONTEXT_SCRIPT: &str =
    include_str!("../../resources/browser-scripts/page-context.js");

pub const CONSOLE_CAPTURE_SCRIPT: &str =
    include_str!("../../resources/browser-scripts/console-capture.js");

pub const INTERACTIVE_ELEMENTS_SCRIPT_BODY: &str =
    include_str!("../../resources/browser-scripts/interactive-elements.js");

pub const DIAGNOSTICS_SCRIPT_BODY: &str =
    include_str!("../../resources/browser-scripts/diagnostics-body.js");

pub const CLICK_ELEMENT_SCRIPT_BODY: &str =
    include_str!("../../resources/browser-scripts/click-element-body.js");

pub const FILL_ELEMENT_SCRIPT_BODY: &str =
    include_str!("../../resources/browser-scripts/fill-element-body.js");

pub const AI_OVERLAY_SCRIPT_BODY: &str =
    include_str!("../../resources/browser-scripts/ai-overlay-body.js");

pub const MARQUEE_OVERLAY_SCRIPT_BODY: &str =
    include_str!("../../resources/browser-scripts/marquee-overlay-body.js");

pub const MARQUEE_GET_RESULT_SCRIPT: &str =
    include_str!("../../resources/browser-scripts/marquee-get-result.js");

pub const REGION_SELECT_SCRIPT_BODY: &str =
    include_str!("../../resources/browser-scripts/region-select-body.js");

pub const NETWORK_INFO_SCRIPT: &str =
    include_str!("../../resources/browser-scripts/network-info.js");

pub const NETWORK_REQUESTS_SCRIPT: &str =
    include_str!("../../resources/browser-scripts/network-requests.js");

pub const STORAGE_READ_SCRIPT: &str =
    include_str!("../../resources/browser-scripts/storage-read.js");

pub const STORAGE_WRITE_SCRIPT: &str =
    include_str!("../../resources/browser-scripts/storage-write.js");

pub const ASSERT_CHECK_SCRIPT: &str =
    include_str!("../../resources/browser-scripts/assert-check.js");

pub const BROWSER_STATUS_SCRIPT: &str =
    include_str!("../../resources/browser-scripts/browser-status.js");

pub const MUTE_CONTROL_SCRIPT: &str =
    include_str!("../../resources/browser-scripts/mute-control.js");

pub const READER_EXTRACT_SCRIPT: &str =
    include_str!("../../resources/browser-scripts/reader-extract.js");

/// 嵌入的交互元素收集器代码
pub const INTERACTIVE_COLLECTOR_SCRIPT: &str =
    include_str!("../../resources/browser-scripts/interactive-collector.js");

/// 构建带 collector 前缀的完整脚本
pub fn with_collector(body: &str) -> String {
    let mut script = String::from("(() => {\n");
    script.push_str(INTERACTIVE_COLLECTOR_SCRIPT);
    script.push('\n');
    script.push_str(body);
    script.push_str("\n})()");
    script
}

/// 交互元素列表脚本（含 collector）
pub fn interactive_elements_script() -> String {
    with_collector(INTERACTIVE_ELEMENTS_SCRIPT_BODY)
}

/// 诊断脚本（含 console capture + collector）
pub fn diagnostics_script() -> String {
    let mut script = String::from("(() => {\n");
    script.push_str(CONSOLE_CAPTURE_SCRIPT);
    script.push('\n');
    script.push_str(INTERACTIVE_COLLECTOR_SCRIPT);
    script.push('\n');
    script.push_str(DIAGNOSTICS_SCRIPT_BODY);
    script.push_str("\n})()");
    script
}

/// 点击元素脚本（含 collector）
pub fn click_element_script(index: Option<usize>, text: &str) -> String {
    let index_str = index.map(|v| v.to_string()).unwrap_or_else(|| "null".to_string());
    let text_str = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_string());
    let mut script = String::from("(() => {\nconst requestedIndex = ");
    script.push_str(&index_str);
    script.push_str(";\nconst requestedText = ");
    script.push_str(&text_str);
    script.push_str(";\n");
    script.push_str(INTERACTIVE_COLLECTOR_SCRIPT);
    script.push('\n');
    script.push_str(CLICK_ELEMENT_SCRIPT_BODY);
    script.push_str("\n})()");
    script
}

/// 填充元素脚本（含 collector）
pub fn fill_element_script(index: Option<usize>, text: &str, value: &str) -> String {
    let index_str = index.map(|v| v.to_string()).unwrap_or_else(|| "null".to_string());
    let text_str = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_string());
    let value_str = serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string());
    let mut script = String::from("(() => {\nconst requestedIndex = ");
    script.push_str(&index_str);
    script.push_str(";\nconst requestedText = ");
    script.push_str(&text_str);
    script.push_str(";\nconst fillValue = ");
    script.push_str(&value_str);
    script.push_str(";\n");
    script.push_str(INTERACTIVE_COLLECTOR_SCRIPT);
    script.push('\n');
    script.push_str(FILL_ELEMENT_SCRIPT_BODY);
    script.push_str("\n})()");
    script
}

/// AI overlay 高亮脚本（含 collector）
pub fn ai_overlay_script(enabled: bool) -> String {
    let enabled_str = if enabled { "true" } else { "false" };
    let mut script = String::from("(() => {\nconst overlayEnabled = ");
    script.push_str(enabled_str);
    script.push_str(";\n");
    script.push_str(INTERACTIVE_COLLECTOR_SCRIPT);
    script.push('\n');
    script.push_str(AI_OVERLAY_SCRIPT_BODY);
    script.push_str("\n})()");
    script
}

/// 圈选 overlay 脚本
pub fn marquee_overlay_script(enabled: bool) -> String {
    let enabled_str = if enabled { "true" } else { "false" };
    let mut script = String::from("(() => {\nconst marqueeEnabled = ");
    script.push_str(enabled_str);
    script.push_str(";\n");
    script.push_str(MARQUEE_OVERLAY_SCRIPT_BODY);
    script.push_str("\n})()");
    script
}

/// 媒体静音控制脚本
pub fn mute_control_script(mute: bool) -> String {
    format!("(() => {{\nconst muteEnabled = {mute};\n{})()", MUTE_CONTROL_SCRIPT)
}

/// 网络请求明细脚本：通过全局变量注入 limit，控制返回条数（防上下文膨胀）
pub fn network_requests_script(limit: Option<usize>) -> String {
    let limit_val = limit.unwrap_or(100).max(1).min(1000);
    format!("(() => {{\nwindow.__POLARIS_NETWORK_LIMIT__ = {limit_val};\n{})()", NETWORK_REQUESTS_SCRIPT)
}

/// 存储读写脚本：通过全局对象注入 { action, type, key, value, cookieOpts }
/// 由脚本内部从 window.__POLARIS_STORAGE_ARGS__ 读取并消费后清理。
pub fn storage_script(body: &str, args: &serde_json::Value) -> String {
    let args_json = serde_json::to_string(args).unwrap_or_else(|_| "{}".to_string());
    format!("(() => {{\nwindow.__POLARIS_STORAGE_ARGS__ = {args_json};\n{body}\n}})()")
}

/// 断言检查脚本：注入 { kind, text, index, initialUrl } 到全局，内含交互元素收集器。
pub fn assert_check_script(args: &serde_json::Value) -> String {
    let args_json = serde_json::to_string(args).unwrap_or_else(|_| "{}".to_string());
    let mut script = String::from("(() => {\nwindow.__POLARIS_ASSERT_ARGS__ = ");
    script.push_str(&args_json);
    script.push_str(";\n");
    script.push_str(INTERACTIVE_COLLECTOR_SCRIPT);
    script.push('\n');
    script.push_str(ASSERT_CHECK_SCRIPT);
    script.push_str("\n})()");
    script
}

/// 区域选择脚本（含 collector）
pub fn region_select_script(rect: &BrowserRect) -> String {
    let mut script = String::from("(() => {\nconst targetX = ");
    script.push_str(&rect.x.to_string());
    script.push_str(";\nconst targetY = ");
    script.push_str(&rect.y.to_string());
    script.push_str(";\nconst targetW = ");
    script.push_str(&rect.width.to_string());
    script.push_str(";\nconst targetH = ");
    script.push_str(&rect.height.to_string());
    script.push_str(";\n");
    script.push_str(INTERACTIVE_COLLECTOR_SCRIPT);
    script.push('\n');
    script.push_str(REGION_SELECT_SCRIPT_BODY);
    script.push_str("\n})()");
    script
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_context_script_is_valid_js() {
        assert!(PAGE_CONTEXT_SCRIPT.starts_with("(() => "));
        assert!(PAGE_CONTEXT_SCRIPT.ends_with("})()"));
        assert!(PAGE_CONTEXT_SCRIPT.contains("document.title"));
        assert!(PAGE_CONTEXT_SCRIPT.contains("favicon"));
        assert!(PAGE_CONTEXT_SCRIPT.contains("return JSON.stringify"));
    }

    #[test]
    fn interactive_collector_script_covers_modern_patterns() {
        let script = INTERACTIVE_COLLECTOR_SCRIPT;
        assert!(script.contains("[role=\"menuitem\"]"));
        assert!(script.contains("label[for]"));
        assert!(script.contains("[aria-expanded]"));
        assert!(script.contains("[jsaction]"));
        assert!(script.contains("shadowRoot"));
        assert!(script.contains("contentDocument"));
        assert!(script.contains("collectPolarisInteractiveElements"));
        assert!(script.contains("toPolarisInteractiveElement"));
        assert!(script.contains("toPolarisVisualElement"));
    }

    #[test]
    fn with_collector_wraps_body() {
        let body = "return 42;";
        let result = with_collector(body);
        assert!(result.starts_with("(() => {\n"));
        assert!(result.contains(body));
        assert!(result.ends_with("})()"));
        assert!(result.contains("collectPolarisInteractiveElements"));
    }

    #[test]
    fn click_element_script_includes_params() {
        let script = click_element_script(Some(5), "Search");
        assert!(script.contains("requestedIndex = 5"));
        assert!(script.contains("requestedText = \"Search\""));
        assert!(script.contains("collectPolarisInteractiveElements"));
    }

    #[test]
    fn fill_element_script_includes_params() {
        let script = fill_element_script(None, "Search", "Polaris");
        assert!(script.contains("requestedIndex = null"));
        assert!(script.contains("fillValue = \"Polaris\""));
        assert!(script.contains("collectPolarisInteractiveElements"));
    }

    #[test]
    fn ai_overlay_script_toggles_properly() {
        let enabled = ai_overlay_script(true);
        assert!(enabled.contains("overlayEnabled = true"));
        let disabled = ai_overlay_script(false);
        assert!(disabled.contains("overlayEnabled = false"));
    }

    #[test]
    fn marquee_scripts_work() {
        let enabled = marquee_overlay_script(true);
        assert!(enabled.contains("marqueeEnabled = true"));
        assert!(MARQUEE_GET_RESULT_SCRIPT.contains("__POLARIS_MARQUEE_RESULT__"));
    }

    #[test]
    fn region_select_script_includes_coordinates() {
        let rect = BrowserRect { x: 10.0, y: 20.0, width: 320.0, height: 240.0 };
        let script = region_select_script(&rect);
        assert!(script.contains("targetX = 10"));
        assert!(script.contains("targetY = 20"));
        assert!(script.contains("targetW = 320"));
        assert!(script.contains("targetH = 240"));
        assert!(script.contains("collectPolarisInteractiveElements"));
    }

    #[test]
    fn region_select_script_temporarily_hides_overlay_for_sampling() {
        // 圈选 overlay 以 fixed inset:0 pointer-events:auto 覆盖全屏，
        // elementFromPoint 采样时必须临时隐藏 overlay，否则命中 overlay 自身导致上下文为空。
        let rect = BrowserRect { x: 10.0, y: 20.0, width: 320.0, height: 240.0 };
        let script = region_select_script(&rect);
        // 采样前设置 pointer-events:none
        assert!(script.contains("el.style.pointerEvents = 'none'"));
        // 采样后恢复 pointer-events:auto
        assert!(script.contains("el.style.pointerEvents = 'auto'"));
        // 遍历 overlay id 隐藏
        assert!(script.contains("POLARIS_OVERLAY_IDS"));
    }
}
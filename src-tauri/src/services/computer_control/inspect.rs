//! Windows 控件树（UI Automation）：查询 + 结构化操作。
//!
//! 结构化驱动是 Windows 电脑操作相对裸坐标点击的核心优势：
//! - `inspect_ui` 返回控件树（含 name/controlType/automationId/enabled/rect/center），模型据此定位元素；
//! - `click_element` / `set_text` 按控件名或 automationId **直接操作控件**（UIAutomation invoke），
//!   不受窗口移动、遮挡、DPI 缩放影响，比"算坐标 + 物理点击"可靠。
//!
//! 整个 `computer_control` 模块仅在 Windows 编译（见 `services/mod.rs` 的 `#[cfg(windows)]`），
//! 故此处直接使用 uiautomation，无需平台分支。

use serde_json::{json, Value};
use uiautomation::{UIAutomation, UIElement, UIMatcher, UITreeWalker};

use crate::error::{AppError, Result};

/// 控件匹配的超时（毫秒）。
const MATCH_TIMEOUT_MS: u64 = 3000;

/// 遍历前台桌面控件树。
/// - `max_depth`：递归深度上限（根为 0）。
/// - `sibling_cap`：每层兄弟节点上限，防止超大窗口输出爆炸。
/// - `interactable_only`：剔除"无名且无子"的噪声节点，节省 token。
pub fn inspect_ui(max_depth: usize, sibling_cap: usize, interactable_only: bool) -> Result<Value> {
    let automation = UIAutomation::new()
        .map_err(|e| AppError::ProcessError(format!("初始化 UIAutomation 失败: {e}")))?;
    let root = automation
        .get_root_element()
        .map_err(|e| AppError::ProcessError(format!("获取桌面根元素失败: {e}")))?;
    let walker = automation
        .create_tree_walker()
        .map_err(|e| AppError::ProcessError(format!("创建控件树遍历器失败: {e}")))?;
    Ok(walk(&walker, &root, max_depth, sibling_cap, interactable_only, 0).unwrap_or(json!({})))
}

/// 按控件查找并直接点击（UIAutomation）。`name`（模糊匹配）与 `automation_id` 至少给一个。
/// `count >= 2` 为双击，`button == "right"` 为右键。
pub fn click_element(
    name: Option<&str>,
    automation_id: Option<&str>,
    button: &str,
    count: u32,
) -> Result<String> {
    let automation = UIAutomation::new()
        .map_err(|e| AppError::ProcessError(format!("初始化 UIAutomation 失败: {e}")))?;
    let element = find_element(&automation, name, automation_id)?;
    let label = element.get_name().unwrap_or_default();
    let result = match button.trim().to_ascii_lowercase().as_str() {
        "right" => element.right_click(),
        _ if count >= 2 => element.double_click(),
        _ => element.click(),
    };
    result.map_err(|e| AppError::ProcessError(format!("点击控件失败: {e}")))?;
    Ok(format!("已点击控件「{label}」"))
}

/// 按控件查找并输入文本（聚焦后经剪贴板粘贴，比逐字符可靠）。
pub fn set_text(name: Option<&str>, automation_id: Option<&str>, text: &str) -> Result<String> {
    let automation = UIAutomation::new()
        .map_err(|e| AppError::ProcessError(format!("初始化 UIAutomation 失败: {e}")))?;
    let element = find_element(&automation, name, automation_id)?;
    let label = element.get_name().unwrap_or_default();
    let _ = element.set_focus();
    element
        .send_text_by_clipboard(text)
        .map_err(|e| AppError::ProcessError(format!("向控件输入文本失败: {e}")))?;
    Ok(format!("已向控件「{label}」输入文本"))
}

/// 查找控件并返回其信息（不操作）。`timeout_ms > 0` 时轮询等待控件出现（wait_for 语义）。
/// `name`（模糊匹配）与 `automation_id` 至少给一个。
pub fn find_element_info(
    name: Option<&str>,
    automation_id: Option<&str>,
    timeout_ms: u64,
) -> Result<Value> {
    let automation = UIAutomation::new()
        .map_err(|e| AppError::ProcessError(format!("初始化 UIAutomation 失败: {e}")))?;
    if name.is_none() && automation_id.is_none() {
        return Err(AppError::ValidationError(
            "需要提供 name 或 automation_id 之一来定位控件".to_string(),
        ));
    }
    let mut matcher: UIMatcher = automation.create_matcher().timeout(timeout_ms);
    if let Some(n) = name {
        matcher = matcher.contains_name(n.to_string());
    }
    if let Some(aid) = automation_id {
        let aid = aid.to_string();
        matcher = matcher.filter_fn(Box::new(move |e: &UIElement| -> uiautomation::Result<bool> {
            Ok(e.get_automation_id().map(|x| x == aid).unwrap_or(false))
        }));
    }
    let element = matcher
        .find_first()
        .map_err(|e| AppError::ValidationError(format!("未找到控件（{timeout_ms}ms 内）: {e}")))?;
    Ok(element_json(&element))
}

/// 按标题激活（前置 + 聚焦）顶层窗口（control_type=Window，标题模糊匹配）。
pub fn activate_window(title: &str) -> Result<String> {
    use uiautomation::controls::ControlType;

    let automation = UIAutomation::new()
        .map_err(|e| AppError::ProcessError(format!("初始化 UIAutomation 失败: {e}")))?;
    let matcher = automation
        .create_matcher()
        .timeout(2000)
        .control_type(ControlType::Window)
        .contains_name(title.to_string());
    let window = matcher
        .find_first()
        .map_err(|e| AppError::ValidationError(format!("未找到标题含「{title}」的窗口: {e}")))?;
    let name = window.get_name().unwrap_or_default();
    window
        .set_focus()
        .map_err(|e| AppError::ProcessError(format!("激活窗口失败: {e}")))?;
    Ok(format!("已激活窗口「{name}」"))
}

fn find_element(
    automation: &UIAutomation,
    name: Option<&str>,
    automation_id: Option<&str>,
) -> Result<UIElement> {
    if name.is_none() && automation_id.is_none() {
        return Err(AppError::ValidationError(
            "需要提供 name 或 automation_id 之一来定位控件".to_string(),
        ));
    }
    let mut matcher: UIMatcher = automation.create_matcher().timeout(MATCH_TIMEOUT_MS);
    if let Some(n) = name {
        matcher = matcher.contains_name(n.to_string());
    }
    if let Some(aid) = automation_id {
        let aid = aid.to_string();
        matcher = matcher.filter_fn(Box::new(move |e: &UIElement| -> uiautomation::Result<bool> {
            Ok(e.get_automation_id().map(|x| x == aid).unwrap_or(false))
        }));
    }
    matcher
        .find_first()
        .map_err(|e| AppError::ValidationError(format!("未找到匹配的控件: {e}")))
}

fn walk(
    walker: &UITreeWalker,
    element: &UIElement,
    max_depth: usize,
    sibling_cap: usize,
    interactable_only: bool,
    depth: usize,
) -> Option<Value> {
    let name_empty = element.get_name().map(|n| n.is_empty()).unwrap_or(true);
    let mut node = element_json(element);

    let mut children = Vec::new();
    if depth < max_depth {
        if let Ok(mut child) = walker.get_first_child(element) {
            loop {
                if let Some(child_json) =
                    walk(walker, &child, max_depth, sibling_cap, interactable_only, depth + 1)
                {
                    children.push(child_json);
                }
                if children.len() >= sibling_cap {
                    break;
                }
                match walker.get_next_sibling(&child) {
                    Ok(next) => child = next,
                    Err(_) => break,
                }
            }
        }
    }

    let has_children = !children.is_empty();
    if has_children {
        node["children"] = Value::Array(children);
    }

    // 根节点（depth 0）始终保留；interactable_only 下剔除无名且无子的噪声节点。
    if interactable_only && depth > 0 && name_empty && !has_children {
        return None;
    }
    Some(node)
}

fn element_json(element: &UIElement) -> Value {
    let name = element.get_name().unwrap_or_default();
    let control_type = element
        .get_control_type()
        .map(|ct| format!("{ct:?}"))
        .unwrap_or_default();
    let automation_id = element.get_automation_id().unwrap_or_default();
    let enabled = element.is_enabled().unwrap_or(false);

    let (rect, center) = match element.get_bounding_rectangle() {
        Ok(r) => {
            let (left, top, right, bottom) =
                (r.get_left(), r.get_top(), r.get_right(), r.get_bottom());
            (
                json!({ "x": left, "y": top, "width": right - left, "height": bottom - top }),
                json!({ "x": (left + right) / 2, "y": (top + bottom) / 2 }),
            )
        }
        Err(_) => (Value::Null, Value::Null),
    };

    json!({
        "name": name,
        "controlType": control_type,
        "automationId": automation_id,
        "enabled": enabled,
        "rect": rect,
        "center": center,
    })
}

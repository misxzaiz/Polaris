//! Windows 控件树（无障碍 UI Automation）。
//!
//! 结构化驱动路线：相比纯视觉，控件树带 `name/controlType/bounds/enabled`，确定性高、省 token，
//! 且不依赖模型视觉能力。仅 Windows 可用；其它平台返回明确错误。

use crate::error::Result;

/// 遍历当前桌面的控件树，返回结构化 JSON。
///
/// - `max_depth`：递归深度上限（根为 0）。
/// - `sibling_cap`：每层兄弟节点上限，防止超大窗口输出爆炸。
#[cfg(windows)]
pub fn inspect_ui(max_depth: usize, sibling_cap: usize) -> Result<serde_json::Value> {
    windows_impl::inspect_ui(max_depth, sibling_cap)
}

#[cfg(not(windows))]
pub fn inspect_ui(_max_depth: usize, _sibling_cap: usize) -> Result<serde_json::Value> {
    Err(crate::error::AppError::ValidationError(
        "inspect_ui（控件树）仅在 Windows 平台可用".to_string(),
    ))
}

#[cfg(windows)]
mod windows_impl {
    use serde_json::{json, Value};
    use uiautomation::{UIAutomation, UIElement, UITreeWalker};

    use crate::error::{AppError, Result};

    pub fn inspect_ui(max_depth: usize, sibling_cap: usize) -> Result<Value> {
        let automation = UIAutomation::new()
            .map_err(|e| AppError::ProcessError(format!("初始化 UIAutomation 失败: {e}")))?;
        let root = automation
            .get_root_element()
            .map_err(|e| AppError::ProcessError(format!("获取桌面根元素失败: {e}")))?;
        let walker = automation
            .create_tree_walker()
            .map_err(|e| AppError::ProcessError(format!("创建控件树遍历器失败: {e}")))?;
        Ok(walk(&walker, &root, max_depth, sibling_cap, 0))
    }

    fn walk(
        walker: &UITreeWalker,
        element: &UIElement,
        max_depth: usize,
        sibling_cap: usize,
        depth: usize,
    ) -> Value {
        let mut node = element_json(element);
        if depth >= max_depth {
            return node;
        }

        let mut children = Vec::new();
        if let Ok(mut child) = walker.get_first_child(element) {
            loop {
                children.push(walk(walker, &child, max_depth, sibling_cap, depth + 1));
                if children.len() >= sibling_cap {
                    break;
                }
                match walker.get_next_sibling(&child) {
                    Ok(next) => child = next,
                    Err(_) => break,
                }
            }
        }
        if !children.is_empty() {
            node["children"] = Value::Array(children);
        }
        node
    }

    fn element_json(element: &UIElement) -> Value {
        let name = element.get_name().unwrap_or_default();
        let control_type = element
            .get_control_type()
            .map(|ct| format!("{ct:?}"))
            .unwrap_or_default();
        let enabled = element.is_enabled().unwrap_or(false);
        let rect = element
            .get_bounding_rectangle()
            .map(|r| {
                json!({
                    "x": r.get_left(),
                    "y": r.get_top(),
                    "width": r.get_right() - r.get_left(),
                    "height": r.get_bottom() - r.get_top(),
                })
            })
            .unwrap_or(Value::Null);

        json!({
            "name": name,
            "controlType": control_type,
            "enabled": enabled,
            "rect": rect,
        })
    }
}

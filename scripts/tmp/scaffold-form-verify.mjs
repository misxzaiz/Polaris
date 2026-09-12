// form_core 验证脚手架：在系统临时目录搭独立验证 crate（绕开 Tauri DLL 0xc0000139），
// 移植 sky 的 form_bridge / form_core 三纯函数 + FormBridge，原样跑单测。
// 目的：验证 step9 阶段 A（form_core 三纯函数）+ 阶段 B（桥往返/迟到拒绝/超时）核心假设。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const SRC = 'do/sky/src'
const DST = path.join(os.tmpdir(), 'sky-form-verify')
fs.rmSync(DST, { recursive: true, force: true })

function write(rel, content) {
  const d = path.join(DST, rel)
  fs.mkdirSync(path.dirname(d), { recursive: true })
  fs.writeFileSync(d, content)
}
function cp(rel, destRel = rel) {
  write(path.join('src', destRel), fs.readFileSync(path.join(SRC, rel), 'utf8'))
}

write('Cargo.toml', `[package]
name = "sky-form-verify"
version = "0.1.0"
edition = "2021"

[lib]
name = "sky_form_verify"
path = "src/lib.rs"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["sync", "rt-multi-thread", "macros", "time"] }
uuid = { version = "1", features = ["v4"] }

[workspace]
`)

write('src/lib.rs', `//! 独立验证 crate：绕开 Tauri DLL 环境限制（0xc0000139），实际运行
//! step9 阶段 A（form_core 三纯函数）+ 阶段 B（FormBridge 桥往返/迟到拒绝/超时清理）。
//! 全部单测来自 sky（form_bridge.rs），原样移植。
pub mod form_bridge;
pub mod form_core;
`)

// ① form_core.rs —— 三纯函数（validate_fields / expand_dot_paths / build_receipt）
// 从 sky form.rs + form_bridge.rs 提取，仅保留纯函数，去 Tool trait / ToolOutcome。
write('src/form_core.rs', `//! form_core —— 表单共享业务核（纯函数，可独立单测）
//! 从 sky（plugins/tools/form.rs + ai/form_bridge.rs）提取，去 Tool trait 依赖。

use serde_json::{json, Value};

/// 校验 fields schema（纯函数）
/// 规则（最小化）：
/// - fields 必须是非空数组
/// - 每个字段必须有非空 name
/// - select 类型必须带非空 options 数组
/// - 未知 type 不报错（前端回落 string 渲染）
pub fn validate_fields(fields: &Value) -> Result<(), String> {
    let arr = fields.as_array().ok_or("fields 必须是数组")?;
    if arr.is_empty() {
        return Err("fields 不能为空".into());
    }
    for (i, f) in arr.iter().enumerate() {
        let name = f
            .get("name")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .unwrap_or("");
        if name.is_empty() {
            return Err(format!("fields[{}] 缺少 name", i));
        }
        let ty = f.get("type").and_then(|v| v.as_str()).unwrap_or("string");
        if ty == "select" {
            let has_opts = f
                .get("options")
                .and_then(|v| v.as_array())
                .map(|a| !a.is_empty())
                .unwrap_or(false);
            if !has_opts {
                return Err(format!("fields[{}] type=select 需要 options 数组", i));
            }
        }
    }
    Ok(())
}

/// 点路径展开：{"a.b": 1, "a.c": 2, "d": 3} → {"a": {"b": 1, "c": 2}, "d": 3}
/// 无点路径的 key 原样保留。空段跳过。
pub fn expand_dot_paths(flat: &Value) -> Value {
    let obj = match flat.as_object() {
        Some(o) => o,
        None => return flat.clone(),
    };
    let mut root = serde_json::Map::new();
    for (k, v) in obj {
        let segments: Vec<&str> = k.split('.').filter(|s| !s.is_empty()).collect();
        if segments.len() <= 1 {
            root.insert(k.clone(), v.clone());
            continue;
        }
        let mut cur = &mut root;
        for seg in &segments[..segments.len() - 1] {
            cur = cur
                .entry(seg.to_string())
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .expect("expand_dot_paths: 非对象节点被意外覆盖");
        }
        cur.insert(segments[segments.len() - 1].to_string(), v.clone());
    }
    Value::Object(root)
}

/// 生成回执（信任边界所在 —— AI 只能看到这份文本）
/// 规则：
/// - read = "none"：只列字段名，值全部不出现
/// - read = "full"（默认）：完整字段值；但 secret 类型字段无论模式一律掩码
/// - 附带 target capability 的执行结果
pub fn build_receipt(
    read_mode: &str,
    fields: &[Value],
    values: &Value,
    exec_result: &Result<Value, String>,
) -> String {
    let secret_names: Vec<&str> = fields
        .iter()
        .filter(|f| f.get("type").and_then(|t| t.as_str()) == Some("secret"))
        .filter_map(|f| f.get("name").and_then(|n| n.as_str()))
        .collect();

    let exec_line = match exec_result {
        Ok(v) => format!("执行结果: {}", serde_json::to_string(v).unwrap_or_default()),
        Err(e) => format!("执行失败: {}", e),
    };

    let mut lines = Vec::new();
    match read_mode {
        "none" => {
            lines.push("用户已提交表单（隐私模式：AI 不可读取字段值）".to_string());
            for f in fields {
                if let Some(name) = f.get("name").and_then(|n| n.as_str()) {
                    lines.push(format!("- {}: <已隐藏>", name));
                }
            }
        }
        _ => {
            lines.push("用户已提交表单".to_string());
            if let Some(obj) = values.as_object() {
                for (k, v) in obj {
                    if secret_names.iter().any(|s| k.contains(s)) {
                        lines.push(format!("- {}: <secret 已掩码>", k));
                    } else {
                        lines.push(format!("- {}: {}", k, v));
                    }
                }
            }
        }
    }
    lines.push(exec_line);
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_accepts_valid_fields() {
        let fields = json!([
            {"name": "id", "type": "string", "value": "deepseek", "editable": false},
            {"name": "api_key", "type": "secret"},
            {"name": "wire", "type": "select", "options": ["a", "b"], "value": "a"},
            {"name": "ctx", "type": "number"},
            {"name": "enabled", "type": "boolean"},
            {"name": "day", "type": "date"}
        ]);
        assert!(validate_fields(&fields).is_ok());
    }

    #[test]
    fn validate_rejects_empty_and_missing_name() {
        assert!(validate_fields(&json!([])).is_err());
        assert!(validate_fields(&json!("not-array")).is_err());
        assert!(validate_fields(&json!([{"type": "string"}])).is_err()); // 缺 name
        assert!(validate_fields(&json!([{"name": "  "}])).is_err()); // 空白 name
        assert!(validate_fields(&json!([{"name": "x", "type": "select"}])).is_err()); // select 无 options
    }

    #[test]
    fn validate_tolerates_unknown_type() {
        let fields = json!([{"name": "x", "type": "color"}]);
        assert!(validate_fields(&fields).is_ok());
    }

    #[test]
    fn expand_dot_paths_nests() {
        let flat = json!({"profile.id": "x", "profile.api_key": "sk-1", "action": "save"});
        let out = expand_dot_paths(&flat);
        assert_eq!(out["profile"]["id"], "x");
        assert_eq!(out["profile"]["api_key"], "sk-1");
        assert_eq!(out["action"], "save");
    }

    #[test]
    fn expand_dot_paths_no_dots_passthrough() {
        let flat = json!({"a": 1, "b": "x"});
        assert_eq!(expand_dot_paths(&flat), flat);
    }

    #[test]
    fn receipt_none_mode_hides_all_values() {
        let fields = json!([
            {"name": "profile.id", "type": "string"},
            {"name": "profile.api_key", "type": "secret"}
        ]);
        let values = json!({"profile.id": "deepseek", "profile.api_key": "sk-real-9999"});
        let receipt = build_receipt("none", fields.as_array().unwrap(), &values, &Ok(json!({"ok": true})));
        assert!(!receipt.contains("deepseek"), "none 模式不得泄露字段值: {}", receipt);
        assert!(!receipt.contains("sk-real"), "none 模式不得泄露 secret: {}", receipt);
        assert!(receipt.contains("已隐藏"));
        assert!(receipt.contains("执行结果"));
    }

    #[test]
    fn receipt_full_mode_shows_values_but_masks_secrets() {
        let fields = json!([
            {"name": "profile.id", "type": "string"},
            {"name": "profile.api_key", "type": "secret"}
        ]);
        let values = json!({"profile.id": "deepseek", "profile.api_key": "sk-real-9999"});
        let receipt = build_receipt("full", fields.as_array().unwrap(), &values, &Ok(json!({"ok": true})));
        assert!(receipt.contains("deepseek"), "full 模式应展示普通值: {}", receipt);
        assert!(!receipt.contains("sk-real"), "secret 无论模式必须掩码: {}", receipt);
        assert!(receipt.contains("已掩码"));
    }

    #[test]
    fn receipt_exec_failure_reported() {
        let fields = json!([{"name": "a"}]);
        let receipt = build_receipt("full", fields.as_array().unwrap(), &json!({"a": "1"}), &Err("base_url 不能为空".into()));
        assert!(receipt.contains("执行失败"));
        assert!(receipt.contains("base_url 不能为空"));
    }
}
`)

// ② form_bridge.rs —— FormBridge（oneshot 等待）+ FormSubmission
// 从 sky form_bridge.rs 原样移植，去 FormSubmission 里的 payload/exec_result 直接引用
write('src/form_bridge.rs', `//! FormBridge —— form 工具的挂起/唤醒桥
//! 从 sky（ai/form_bridge.rs）原样移植。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;
use serde_json::Value;

/// 等待用户提交的超时（秒）。
pub const FORM_WAIT_TIMEOUT_SECS: u64 = 600;

/// 提交结果：target capability 的执行结果 + 服务端已生成的回执
#[derive(Debug, Clone)]
pub struct FormSubmission {
    /// 展开后的 payload（点路径 → 嵌套），原文
    pub payload: serde_json::Value,
    /// target capability 执行结果（Ok(result json) 或 Err(msg)）
    pub exec_result: Result<serde_json::Value, String>,
    /// 回执（按 read 模式生成，喂给 AI 的就是这份）
    pub receipt: String,
    /// 提交是否成功（exec_result.is_ok()）
    pub success: bool,
}

type Waiter = oneshot::Sender<FormSubmission>;

/// 全局桥。Key = form_id。
#[derive(Default)]
pub struct FormBridge {
    waiters: Mutex<HashMap<String, Waiter>>,
    holds: Mutex<HashMap<String, Value>>,
}

impl FormBridge {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn attach_hold(self: &Arc<Self>, form_id: &str, hold: Value) {
        self.holds.lock().expect("form bridge poisoned").insert(form_id.to_string(), hold);
    }

    pub fn take_hold(self: &Arc<Self>, form_id: &str) -> Option<Value> {
        self.holds.lock().expect("form bridge poisoned").remove(form_id)
    }

    /// 为 form_id 建立等待通道。同 form_id 重复调用以后者为准。
    pub fn channel(self: &Arc<Self>, form_id: &str) -> oneshot::Receiver<FormSubmission> {
        let (tx, rx) = oneshot::channel();
        self.waiters.lock().expect("form bridge poisoned").insert(form_id.to_string(), tx);
        rx
    }

    /// 提交：喂给等待者。form_id 不存在（已超时/服务重启）返回 false。
    pub fn submit(self: &Arc<Self>, form_id: &str, submission: FormSubmission) -> bool {
        if let Some(tx) = self.waiters.lock().expect("form bridge poisoned").remove(form_id) {
            let _ = tx.send(submission);
            true
        } else {
            false
        }
    }

    /// 取消（超时清理）：移除 sender 与 hold，迟到的提交会被拒绝。
    pub fn cancel(self: &Arc<Self>, form_id: &str) -> bool {
        let _ = self.take_hold(form_id);
        self.waiters.lock().expect("form bridge poisoned").remove(form_id).is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn bridge_submit_wakes_waiter() {
        let bridge = FormBridge::new();
        let rx = bridge.channel("f2");
        assert!(bridge.submit("f2", FormSubmission {
            payload: json!({"profile": {"api_key": "sk-1"}}),
            exec_result: Ok(json!({"ok": true, "id": "p1"})),
            receipt: "receipt-text".into(),
            success: true,
        }));
        let sub = rx.await.expect("waiter woken");
        assert!(sub.success);
        assert_eq!(sub.receipt, "receipt-text");
        assert_eq!(sub.payload["profile"]["api_key"], "sk-1");
    }

    #[tokio::test]
    async fn bridge_submit_unknown_id_returns_false() {
        let bridge = FormBridge::new();
        let _rx = bridge.channel("f3");
        assert!(!bridge.submit("nope", FormSubmission {
            payload: json!({}),
            exec_result: Ok(json!({})),
            receipt: String::new(),
            success: true,
        }));
    }

    #[tokio::test]
    async fn bridge_cancel_rejects_late_submit() {
        let bridge = FormBridge::new();
        let rx = bridge.channel("f4");
        assert!(bridge.cancel("f4"));
        assert!(!bridge.cancel("f4"), "二次 cancel 应返回 false");
        assert!(!bridge.submit("f4", FormSubmission {
            payload: json!({}),
            exec_result: Ok(json!({})),
            receipt: String::new(),
            success: true,
        }));
        assert!(rx.await.is_err());
    }

    #[tokio::test]
    async fn bridge_double_channel_latest_wins() {
        let bridge = FormBridge::new();
        let _rx1 = bridge.channel("f5");
        let rx2 = bridge.channel("f5");
        assert!(bridge.submit("f5", FormSubmission {
            payload: json!({}),
            exec_result: Ok(json!({})),
            receipt: "second".into(),
            success: true,
        }));
        assert!(rx2.await.is_ok());
    }

    #[test]
    fn hold_attach_take_roundtrip() {
        let bridge = FormBridge::new();
        bridge.attach_hold("f6", json!({"target": "cap.provider", "read": "none"}));
        let hold = bridge.take_hold("f6").expect("hold 存在");
        assert_eq!(hold["target"], "cap.provider");
        assert!(bridge.take_hold("f6").is_none(), "取走即删");
    }
}
`)

console.log('scaffolded at', DST)

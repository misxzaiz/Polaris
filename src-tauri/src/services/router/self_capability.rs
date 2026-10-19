//! cap.self.inspect —— 自身管理·透视（AI 看清 Polaris 全域）
//!
//! 目标（goal 衍生）：「支持 AI 清楚 Polaris 的内容」。
//! 本能力给 AI 一次调用即可获得的运行状态聚合，替代多趟拼装：
//! - `status`      运行版本 / 启动时长 / 数据根 / 引擎与能力计数
//! - `diskUsage`   数据根各子目录占用（复用 data_root::dir_stats，只读）
//! - `capabilities` 全能力索引（内置/流式/动态 分类计数 + 摘要）
//!
//! 设计要点：
//! - **纯只读**：不新增任何写路径；`cap.self.*` 能力域不碰清理/写文件。
//! - 能力索引复用 `RouterBus::described_capabilities()`（cap.help 同源），
//!   保证 AI 看到的就是 cap_list / cap.help 看到的同一份真相。
//! - 动态能力标记与 regsitry 一致（DynamicCapability.describe 带 `"dynamic": true`），
//!   通过该字段区分 builtin/dynamic，不依赖类名反射。
//! - 版本号来自编译期常量（`env!("CARGO_PKG_VERSION")`）与构建元数据。

use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::contracts::{Capability, CapabilityId, Context};
use crate::services::data_root::{data_root, dir_stats};
use crate::services::router::RouterBus;

/// 启动时刻（进程级，用于 uptime 计算）
static BOOT_TS: AtomicU64 = AtomicU64::new(0);

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 初始化启动时间戳（state.rs 装配时调用一次）
pub fn mark_boot() {
    BOOT_TS.store(now_unix(), Ordering::Relaxed);
}

fn boot_ts() -> u64 {
    let v = BOOT_TS.load(Ordering::Relaxed);
    if v == 0 {
        // 未显式调用则就地取当前时间（uptime≈0，不会误算）
        now_unix()
    } else {
        v
    }
}

/// cap.self.inspect —— 自身管理·透视（无状态只读聚合）
pub struct SelfInspectCapability {
    router: Arc<RouterBus>,
}

impl SelfInspectCapability {
    pub fn new(router: Arc<RouterBus>) -> Self {
        Self { router }
    }

    /// 运行状态聚合
    fn status(&self) -> Value {
        let dr = data_root();
        // described_capabilities 是同步+流式并集，capabilityCount 用它的长度
        let capability_count = self.router.described_capabilities().len();

        json!({
            "version": env!("CARGO_PKG_VERSION"),
            "uptimeSec": now_unix().saturating_sub(boot_ts()),
            "dataRoot": dr.root().to_string_lossy(),
            "dataRootIsCustom": dr.is_custom(),
            "capabilityCount": capability_count,
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
        })
    }

    /// 数据根占用聚合（只读目录统计）
    fn disk_usage(&self) -> Value {
        let dr = data_root();
        let root = dr.root().to_path_buf();

        let (root_bytes, root_files) = dir_stats(&root);

        // 语义子目录（与 cap.data_root get_info 的 SUBDIR_NAMES 对齐）
        let subdirs = [
            "logs",
            "dialogs",
            "scheduler",
            "plugins",
            "cache",
            ".meta",
            "stores",
        ]
        .iter()
        .map(|name| {
            let path = root.join(name);
            let (bytes, files) = dir_stats(&path);
            json!({
                "name": name,
                "sizeBytes": bytes,
                "fileCount": files,
            })
        })
        .collect::<Vec<_>>();

        let mut by_dir: std::collections::BTreeMap<String, u64> = subdirs
            .iter()
            .map(|s| {
                (
                    s["name"].as_str().unwrap_or("").to_string(),
                    s["sizeBytes"].as_u64().unwrap_or(0),
                )
            })
            .collect();
        by_dir.remove(""); // 防御：name 解析为空的行不应计入

        json!({
            "dataRootBytes": root_bytes,
            "dataRootFiles": root_files,
            "subdirs": subdirs,
            "largestSubdir": by_dir
                .iter()
                .max_by_key(|(_, &v)| v)
                .map(|(k, &v)| json!({ "name": k, "sizeBytes": v }))
                .unwrap_or(Value::Null),
        })
    }

    /// 全能力索引（与 cap.help 同源，分类计数）
    fn capabilities(&self) -> Value {
        let described = self.router.described_capabilities();

        let mut total = 0;
        let mut streaming = 0;
        let mut dynamic = Vec::new();

        let by_source: std::collections::BTreeMap<String, Vec<String>> = {
            let mut m: std::collections::BTreeMap<String, Vec<String>> = Default::default();
            for item in &described {
                total += 1;
                let id = item["id"].as_str().unwrap_or("").to_string();
                if item["streaming"].as_bool().unwrap_or(false) {
                    streaming += 1;
                }
                // 动态能力标记：describe 内 "dynamic": true（DynamicCapability 输出）
                let is_dynamic = item["describe"]["dynamic"].as_bool().unwrap_or(false);
                let src = match (is_dynamic, item["streaming"].as_bool().unwrap_or(false)) {
                    (true, _) => "dynamic",
                    (_, true) => "streaming",
                    _ => "builtin",
                };
                m.entry(src.to_string()).or_default().push(id.clone());
                if is_dynamic {
                    dynamic.push(json!({
                        "id": id,
                        "summary": item["describe"]["summary"].as_str().unwrap_or(""),
                    }));
                }
            }
            m
        };

        json!({
            "total": total,
            "streamingCount": streaming,
            "bySource": json!({
                "builtin": by_source.get("builtin").cloned().unwrap_or_default(),
                "dynamic": by_source.get("dynamic").cloned().unwrap_or_default(),
                "streaming": by_source.get("streaming").cloned().unwrap_or_default(),
            }),
            "builtinCount": by_source.get("builtin").map_or(0, Vec::len),
            "dynamicCount": by_source.get("dynamic").map_or(0, Vec::len),
            "dynamicDetails": dynamic,
        })
    }

    /// 健康自检（只读，探针：存储可读 / 审计链可验 / 调度器状态）
    fn health(&self) -> Value {
        // 数据根可读探针
        let dr = data_root();
        let root_readable = dr.root().exists() && dr.root().is_dir();

        // 配置目录可读探针
        let config_readable = std::fs::read_dir(dr.config_dir()).is_ok();

        // 审计链完整性（verify_chain：返回 Ok(total) 或 Err(断点行)）
        let (audit_ok, audit_detail) =
            match crate::services::router::audit_sink::verify_chain(
                &crate::services::router::audit_sink::audit_file_path(),
            ) {
                Ok(total) => (true, format!("{} entries", total)),
                Err(line) => (false, format!("broken at line {}", line)),
            };

        // 调度器：无句柄（AppState 持有），此处只报存储/审计两个可独立探针
        json!({
            "ok": root_readable && config_readable && audit_ok,
            "checks": {
                "dataRootReadable": root_readable,
                "configDirReadable": config_readable,
                "auditChain": { "ok": audit_ok, "detail": audit_detail },
            }
        })
    }
}

impl Capability for SelfInspectCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId("cap.self.inspect".into())
    }

    fn describe(&self) -> Value {
        json!({
            "summary": "自身管理·透视：运行状态 / 存储占用 / 能力索引 / 健康自检（只读）",
            "note": "AI 看清 Polaris 全貌：一次调用即获运行聚合，复用 cap.help / cap.data_root 同源数据。纯只读，无清理能力。",
            "actions": {
                "status": { "params": {}, "returns": "{ version, uptimeSec, dataRoot, capabilityCount, os, arch }" },
                "diskUsage": { "params": {}, "returns": "{ dataRootBytes, dataRootFiles, subdirs[], largestSubdir }" },
                "capabilities": { "params": {}, "returns": "{ total, bySource: { builtin, dynamic, streaming }, dynamicDetails[] }" },
                "health": { "params": {}, "returns": "{ ok, checks: { dataRootReadable, configDirReadable, auditChain } }" }
            }
        })
    }

    fn invoke(&self, params: Value, _ctx: &dyn Context) -> Result<Value, String> {
        let action = params
            .get("action")
            .and_then(|a| a.as_str())
            .ok_or_else(|| "cap.self.inspect 需要 action 参数".to_string())?;

        match action {
            "status" => Ok(self.status()),
            "diskUsage" => Ok(self.disk_usage()),
            "capabilities" => Ok(self.capabilities()),
            "health" => Ok(self.health()),
            other => Err(format!("cap.self.inspect 不支持动作: {}", other)),
        }
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{CapabilityId as CId, PermissionRequest, PluginId, Router as _, Source, Storage};
    use crate::services::router::{EchoCapability, EventAdapter, PolicyPermission, RegistryCapability};

    /// 测试 Context（对照 registry_capability 的 TestCtx：storage 可切换，source=Bootstrap）
    struct TestCtx {
        storage: Option<Arc<dyn Storage>>,
        _caller: PluginId,
    }
    impl Context for TestCtx {
        fn resolve_cap(&self, _id: &CId) -> Result<Value, String> {
            Err("not implemented".into())
        }
        fn storage(&self) -> Result<&dyn Storage, String> {
            match &self.storage {
                Some(s) => Ok(s.as_ref()),
                None => Err("no storage in test".into()),
            }
        }
        fn check_permission(
            &self,
            _req: &PermissionRequest,
        ) -> Result<crate::contracts::PermissionVerdict, String> {
            Ok(crate::contracts::PermissionVerdict::Allow)
        }
        fn source(&self) -> &Source {
            static S: Source = Source::Bootstrap;
            &S
        }
        fn caller_id(&self) -> &PluginId {
            &self._caller
        }
        fn plugin_config(&self) -> Result<Value, String> {
            Ok(Value::Null)
        }
    }
    fn ctx() -> TestCtx {
        TestCtx {
            storage: None,
            _caller: PluginId("cap.self.inspect".into()),
        }
    }

    /// 构造一个测试 bus（含 cap.echo 作为唯一内置）
    fn make_bus() -> Arc<RouterBus> {
        let adapter = Arc::new(EventAdapter::new(64));
        let permission = Box::new(PolicyPermission::default());
        let bus = Arc::new(RouterBus::new(adapter, permission, None, None));
        let _ = bus.register_handle(Box::new(EchoCapability));
        bus
    }

    #[test]
    fn status_returns_version_and_counts() {
        let cap = SelfInspectCapability::new(make_bus());
        let r = cap.invoke(json!({ "action": "status" }), &ctx()).unwrap();
        assert!(r["version"].as_str().is_some());
        assert!(r["uptimeSec"].as_u64().is_some());
        assert!(r["dataRoot"].as_str().is_some());
        // new() 未把 SelfInspectCapability 注册进 bus → count=1（只有 cap.echo）
        assert_eq!(r["capabilityCount"].as_u64().unwrap_or(0), 1);
    }

    #[test]
    fn capabilities_classifies_builtin_dynamic() {
        let bus = make_bus();
        // 注册动态能力进 bus（persist=false 仅内存态）
        let reg = RegistryCapability::new(bus.clone());
        reg.invoke(
            json!({
                "action": "register",
                "id": "cap.user.demo",
                "summary": "demo",
                "handler": { "type": "forward", "target": "cap.echo", "defaults": {} },
                "persist": false,
            }),
            &ctx(),
        )
        .unwrap();

        let cap = SelfInspectCapability::new(bus.clone());
        let r = cap
            .invoke(json!({ "action": "capabilities" }), &ctx())
            .unwrap();

        // builtin 含 cap.echo；dynamic 含 cap.user.demo
        let builtin = r["bySource"]["builtin"].as_array().unwrap();
        assert!(builtin.iter().any(|v| v == "cap.echo"));
        let dynamic = r["bySource"]["dynamic"].as_array().unwrap();
        assert!(dynamic.iter().any(|v| v == "cap.user.demo"));
        // dynamicDetails 带 summary
        let details = r["dynamicDetails"].as_array().unwrap();
        assert!(details.iter().any(|v| v["id"] == "cap.user.demo"));
    }

    #[test]
    fn disk_usage_returns_structure() {
        let cap = SelfInspectCapability::new(make_bus());
        let r = cap.invoke(json!({ "action": "diskUsage" }), &ctx()).unwrap();
        assert!(r["dataRootBytes"].as_u64().is_some());
        assert!(r["subdirs"].as_array().is_some());
    }

    #[test]
    fn health_returns_checks() {
        let cap = SelfInspectCapability::new(make_bus());
        let r = cap.invoke(json!({ "action": "health" }), &ctx()).unwrap();
        assert!(r["checks"]["dataRootReadable"].as_bool().is_some());
        assert!(r["checks"]["auditChain"]["ok"].as_bool().is_some());
    }

    #[test]
    fn unknown_action_rejected() {
        let cap = SelfInspectCapability::new(make_bus());
        assert!(cap.invoke(json!({ "action": "nope" }), &ctx()).is_err());
    }
}
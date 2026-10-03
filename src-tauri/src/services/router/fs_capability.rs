//! cap.fs —— 文件系统访问统一入口（cap.fs 契约）
//!
//! 定位：把文件浏览器的读取操作从 tauri command / Web IPC 直调，迁移到
//! RouterBus 统一总线（cat htttp / cap.bash / cap.context 同构）。收益：
//! - 文件读取对 AI / 插件开放（bus_dispatch 白名单可加 cap.fs）
//! - 权限 gate + 审计 + Source 注入统一走 dispatch
//! - 桌面与 Web 单份逻辑（cap.fs 业务核与 tauri command 层复用同一批同步函数）
//!
//! # 动作协议（payload 统一 `{ "action": ... }`）
//!
//! - `list`         `{ "action": "list", "path": "<绝对路径>" }`
//!                      → `{ "items": [ FileInfo... ] }`（目录直接子项，含 size/modified）
//! - `getFileInfo`  `{ "action": "getFileInfo", "path": "<绝对路径>" }`
//!                      → `{ "item": FileInfo | null }`（目录：子项数；文件：大小/时间）
//! - `exists`       `{ "action": "exists", "path": "<绝对路径>" }`
//!                      → `{ "exists": bool }`
//!
//! # 数据字段（与前端 `types/fileExplorer.ts` 对齐，snake_case 直通）
//!
//! 每个 FileInfo 含：`name / path / is_dir / size(字节,目录为 null) /
//! modified(秒级时间戳字符串,目录同样返回) / extension / children`。
//! modified 是秒级 Unix 时间戳字符串，前端需 `Number(v) * 1000` 转 Date。
//!
//! # 只读性
//!
//! 本能力只做读取（list / getFileInfo / exists）。创建/删除/重命名/复制等写操作
//! 保持既有 tauri command 通道（涉及确认对话框等交互，且 cap 写面需更细的
//! 权限策略，属后续阶段）。读操作走总线获得统一权限/审计，写操作暂留命令层，
//! 边界与 cap.data_root 的 `open_path_in_explorer` 同思路（平台壳命令不进总线）。

use crate::commands::file_explorer::{complete_file_info, read_directory_inner};
use crate::contracts::{Capability, CapabilityId, Context, Value};
use std::path::Path;

/// cap.fs —— 文件系统只读访问能力（无状态）
pub struct FsCapability;

const CAP_ID: &str = "cap.fs";

/// 支持的 action 协议（写死为契约，与前端对齐）
pub const FS_ACTIONS: &[&str] = &["list", "getFileInfo", "exists"];

impl Capability for FsCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId(CAP_ID.into())
    }

    fn invoke(&self, params: Value, _ctx: &dyn Context) -> Result<Value, String> {
        let action = params
            .get("action")
            .and_then(|a| a.as_str())
            .ok_or_else(|| format!("cap.fs 需要 action 参数（{:?}）", FS_ACTIONS))?;

        match action {
            "list" => {
                let path = params
                    .get("path")
                    .and_then(|p| p.as_str())
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| "cap.fs list 需要 path 参数".to_string())?;
                let items = read_directory_inner(Path::new(path)).map_err(|e| e.to_string())?;
                serde_json::to_value(items).map_err(|e| e.to_string())
            }
            "getFileInfo" => {
                let path = params
                    .get("path")
                    .and_then(|p| p.as_str())
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| "cap.fs getFileInfo 需要 path 参数".to_string())?;
                let item = complete_file_info(Path::new(path)).map_err(|e| e.to_string())?;
                match item {
                    Some(info) => Ok(serde_json::json!({ "item": info })),
                    None => Ok(serde_json::json!({ "item": Value::Null })),
                }
            }
            "exists" => {
                let path = params
                    .get("path")
                    .and_then(|p| p.as_str())
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| "cap.fs exists 需要 path 参数".to_string())?;
                Ok(serde_json::json!({ "exists": Path::new(path).exists() }))
            }
            other => Err(format!("cap.fs 不支持动作: {}", other)),
        }
    }

    fn dependencies(&self) -> Vec<CapabilityId> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{
        PermissionRequest, PermissionVerdict, PluginId, Source,
    };
    use serde_json::json;
    use tempfile::TempDir;

    struct NullCtx(Source);
    impl Context for NullCtx {
        fn resolve_cap(&self, _id: &CapabilityId) -> Result<Value, String> {
            Err("not implemented".into())
        }
        fn storage(&self) -> Result<&dyn crate::contracts::Storage, String> {
            Err("not implemented".into())
        }
        fn check_permission(
            &self,
            _req: &PermissionRequest,
        ) -> Result<PermissionVerdict, String> {
            Ok(PermissionVerdict::Allow)
        }
        fn source(&self) -> &Source {
            &self.0
        }
        fn caller_id(&self) -> &PluginId {
            static P: PluginId = PluginId(String::new());
            &P
        }
        fn plugin_config(&self) -> Result<Value, String> {
            Ok(json!({}))
        }
    }

    fn t(file: &Path, content: &str) {
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(file, content).unwrap();
    }

    #[test]
    fn list_returns_children_with_size_and_modified() {
        let dir = TempDir::new().unwrap();
        t(&dir.path().join("a.txt"), "hello world");
        std::fs::create_dir_all(dir.path().join("sub")).unwrap();
        t(&dir.path().join("sub/b.rs"), "fn main() {}");

        let v = FsCapability
            .invoke(
                json!({ "action": "list", "path": dir.path().to_string_lossy() }),
                &NullCtx(Source::Bootstrap),
            )
            .unwrap();
        let items = v["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);

        let a = items.iter().find(|i| i["name"] == "a.txt").unwrap();
        assert_eq!(a["is_dir"], false);
        assert_eq!(a["size"], 11);
        assert!(a["modified"].is_string(), "modified 应为时间戳字符串");

        let sub = items.iter().find(|i| i["name"] == "sub").unwrap();
        assert_eq!(sub["is_dir"], true);
        assert_eq!(sub["size"], Value::Null, "目录 size 应为 null，用子项数代替");
    }

    #[test]
    fn get_file_info_file_returns_size_and_time() {
        let dir = TempDir::new().unwrap();
        t(&dir.path().join("b.rs"), "fn main() {}");

        let v = FsCapability
            .invoke(
                json!({ "action": "getFileInfo", "path": dir.path().join("b.rs").to_string_lossy() }),
                &NullCtx(Source::Bootstrap),
            )
            .unwrap();
        let item = &v["item"];
        assert_eq!(item["name"], "b.rs");
        assert_eq!(item["is_dir"], false);
        assert_eq!(item["size"], 13);
        assert!(item["modified"].is_string());
        assert_eq!(item["extension"], "rs");
    }

    #[test]
    fn get_file_info_dir_returns_child_count() {
        let dir = TempDir::new().unwrap();
        t(&dir.path().join("x.txt"), "ok");
        t(&dir.path().join("y.md"), "hi");

        let v = FsCapability
            .invoke(
                json!({ "action": "getFileInfo", "path": dir.path().to_string_lossy() }),
                &NullCtx(Source::Bootstrap),
            )
            .unwrap();
        let item = &v["item"];
        assert_eq!(item["is_dir"], true);
        // 目录提供子项数（child_count）与 size=null
        assert_eq!(item["child_count"], 2);
        assert_eq!(item["size"], Value::Null);
    }

    #[test]
    fn get_file_info_missing_returns_null() {
        let dir = TempDir::new().unwrap();
        let v = FsCapability
            .invoke(
                json!({ "action": "getFileInfo", "path": dir.path().join("nope.txt").to_string_lossy() }),
                &NullCtx(Source::Bootstrap),
            )
            .unwrap();
        assert_eq!(v["item"], Value::Null);
    }

    #[test]
    fn exists_returns_bool() {
        let dir = TempDir::new().unwrap();
        t(&dir.path().join("a.txt"), "x");
        let v = FsCapability
            .invoke(
                json!({ "action": "exists", "path": dir.path().join("a.txt").to_string_lossy() }),
                &NullCtx(Source::Bootstrap),
            )
            .unwrap();
        assert_eq!(v["exists"], true);

        let v = FsCapability
            .invoke(
                json!({ "action": "exists", "path": dir.path().join("b.txt").to_string_lossy() }),
                &NullCtx(Source::Bootstrap),
            )
            .unwrap();
        assert_eq!(v["exists"], false);
    }

    #[test]
    fn missing_action_and_path_rejected() {
        let dir = TempDir::new().unwrap();
        assert!(
            FsCapability
                .invoke(json!({}), &NullCtx(Source::Bootstrap))
                .is_err(),
            "缺 action 应报错"
        );
        assert!(
            FsCapability
                .invoke(json!({ "action": "list" }), &NullCtx(Source::Bootstrap))
                .is_err(),
            "list 缺 path 应报错"
        );
        let _ = dir;
    }

    #[test]
    fn unknown_action_rejected() {
        let r = FsCapability
            .invoke(json!({ "action": "wat" }), &NullCtx(Source::Bootstrap));
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("不支持动作"));
    }
}
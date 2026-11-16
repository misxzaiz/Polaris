//! cap.fs —— 文件系统访问统一入口（cap.fs 契约）
//!
//! 定位：把文件浏览器的读取操作从 tauri command / Web IPC 直调，迁移到
//! RouterBus 统一总线（cap.http / cap.bash / cap.context 同构）。收益：
//! - 文件读取对 AI / 插件开放（bus_dispatch 白名单可加 cap.fs）
//! - 权限 gate + 审计 + Source 注入统一走 dispatch
//! - 桌面与 Web 单份逻辑（cap.fs 业务核与 tauri command 层复用同一批同步函数）
//!
//! # 动作协议（payload 统一 `{ "action": ... }`）
//!
//! - `list`         `{ "action": "list", "path": "<绝对路径>" }`
//!   → `{ "items": [ FileInfo... ] }`（目录直接子项，含 size/modified）
//! - `getFileInfo`  `{ "action": "getFileInfo", "path": "<绝对路径>" }`
//!   → `{ "item": FileInfo | null }`（目录：子项数；文件：大小/时间）
//! - `exists`       `{ "action": "exists", "path": "<绝对路径>" }`
//!   → `{ "exists": bool }`
//!
//! # 数据字段（与前端 `types/fileExplorer.ts` 对齐，snake_case 直通）
//!
//! 每个 FileInfo 含：`name / path / is_dir / size(字节,目录为 null) /
//! modified(秒级时间戳字符串,目录同样返回) / created(秒级时间戳字符串) /
//! extension / children`。
//! modified/created 是秒级 Unix 时间戳字符串，前端需 `Number(v) * 1000` 转 Date。
//! 注意 `list` 的子项 `child_count` 恒为 null；目录子项数仅 `getFileInfo` 提供。
//!
//! # 只读性
//!
//! 本能力只做读取（list / getFileInfo / exists）。创建/删除/重命名/复制等写操作
//! 保持既有 tauri command 通道（涉及确认对话框等交互，且 cap 写面需更细的
//! 权限策略，属后续阶段）。读操作走总线获得统一权限/审计，写操作暂留命令层，
//! 边界与 cap.data_root 的 `open_path_in_explorer` 同思路（平台壳命令不进总线）。

use crate::commands::file_explorer::{complete_file_info, read_directory_inner};
use crate::contracts::{
    standard_describe, unsupported_action, Capability, CapabilityId, Context, Value,
};
use std::path::Path;

/// cap.fs —— 文件系统只读访问能力（无状态）
pub struct FsCapability;

const CAP_ID: &str = "cap.fs";

/// 支持的 action 协议（写死为契约，与前端对齐）
pub const FS_ACTIONS: &[&str] = &[
    "list",
    "getFileInfo",
    "exists",
    "getFileContent",
    "createFile",
    "createDirectory",
    "deleteFile",
    "renameFile",
    "copyPath",
    "copyPathToDirectory",
    "movePath",
    "movePathToDirectory",
    "saveDroppedFileToDirectory",
    "pathExists",
    "searchFiles",
    "searchFileContents",
    "downloadFileBinary",
    "downloadDirectoryToZip",
    "saveImageBytes",
];


/// 取字符串参数（缺失/空报错）
fn require_str(params: &serde_json::Value, key: &str) -> Result<String, String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from)
        .ok_or_else(|| format!("cap.fs 需要 {} 参数", key))
}

/// 在同步 capability invoke 里驱动 async 命令（对齐 ai_chat_capability 的
/// block_in_place + block_on 范式；调用方均为 tokio 多线程运行时）
fn async_drive<F, Fut, T>(f: F) -> Result<Value, String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<T, crate::error::AppError>>,
    T: serde::Serialize,
{
    let handle = tokio::runtime::Handle::try_current()
        .map_err(|_| "cap.fs 写动作需在 tokio 运行时内调用".to_string())?;
    tokio::task::block_in_place(move || {
        handle
            .block_on(async { f().await })
            .map(|v| serde_json::to_value(v).unwrap_or(Value::Null))
            .map_err(|e| e.to_string())
    })
}

impl Capability for FsCapability {
    fn id(&self) -> CapabilityId {
        CapabilityId(CAP_ID.into())
    }

    fn describe(&self) -> Value {
        standard_describe(
            CAP_ID,
            "文件系统访问",
            "文件系统访问：列目录/文件详情/存在性/读写/复制移动/搜索/打包下载（与前端 file_explorer 命令同源）",
            Some(
                "list/getFileInfo/exists 为只读；其余为写或网络/打包动作；Remote 来源默认 deny（策略见 config permissions.rules）",
            ),
            serde_json::json!({
                "list": { "params": { "path": "string（必填，绝对路径，目录）" }, "returns": "{ items: FileInfo[] }（直接子项，含 size/modified/created；子项 child_count 恒为 null，目录子项数仅 getFileInfo 提供；路径不存在报错「路径不存在」）", "example": { "action": "list", "path": "<绝对路径>" } },
                "getFileInfo": { "params": { "path": "string（必填，绝对路径）" }, "returns": "{ item: FileInfo | null }（不存在返回 item=null 不报错；文件：size+modified+created；目录：child_count、size=null）", "example": { "action": "getFileInfo", "path": "<绝对路径>" } },
                "exists": { "params": { "path": "string（必填，绝对路径）" }, "returns": "{ exists: bool }" },
                "getFileContent": { "params": { "path": "string（必填，绝对路径）" }, "returns": "string（文件全文，UTF-8）" },
                "createFile": { "params": { "path": "string（必填）", "content": "string?" }, "returns": "void" },
                "createDirectory": { "params": { "path": "string（必填）" }, "returns": "void" },
                "deleteFile": { "params": { "path": "string（必填）" }, "returns": "void" },
                "renameFile": { "params": { "old_path": "string（必填）", "new_name": "string（必填）" }, "returns": "void" },
                "copyPath": { "params": { "source": "string（必填）", "destination": "string（必填）" }, "returns": "void" },
                "copyPathToDirectory": { "params": { "source": "string（必填）", "target_dir": "string（必填）" }, "returns": "FileOperationResult" },
                "movePath": { "params": { "source": "string（必填）", "destination": "string（必填）" }, "returns": "void" },
                "movePathToDirectory": { "params": { "source": "string（必填）", "target_dir": "string（必填）" }, "returns": "FileOperationResult" },
                "saveDroppedFileToDirectory": { "params": { "target_dir": "string（必填）", "file_name": "string（必填）", "content_base64": "string（必填）" }, "returns": "FileOperationResult" },
                "pathExists": { "params": { "path": "string（必填）" }, "returns": "bool" },
                "searchFiles": { "params": { "work_dir": "string（必填）", "query": "string（必填）", "max_results": "number?" }, "returns": "FileMatch[]" },
                "searchFileContents": { "params": { "work_dir": "string（必填）", "query": "string（必填）", "case_sensitive": "bool?", "whole_word": "bool?", "max_results": "number?" }, "returns": "ContentSearchResponse" },
                "downloadFileBinary": { "params": { "path": "string（必填）" }, "returns": "string（base64）" },
                "downloadDirectoryToZip": { "params": { "dir_path": "string（必填）" }, "returns": "string（zip 路径）" },
                "saveImageBytes": { "params": { "path": "string（必填）", "data_base64": "string（必填）" }, "returns": "string（落盘路径）" }
            }),
        )
    }

    fn invoke(&self, params: Value, _ctx: &dyn Context) -> Result<Value, String> {
        let action = params
            .get("action")
            .and_then(|a| a.as_str())
            .ok_or_else(|| format!("cap.fs 需要 action 参数（{}）", FS_ACTIONS.join(", ")))?;

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
            // ── 以下与前端 file_explorer 命令同源（双通道：Tauri IPC 与 cap 总线）──
            // async 命令统一 block_in_place + block_on 驱动（调用方均为多线程运行时）。
            "getFileContent" => {
                let path = require_str(&params, "path")?;
                async_drive(|| async { crate::commands::file_explorer::get_file_content(path).await })
            }
            "createFile" => {
                let path = require_str(&params, "path")?;
                let content = params.get("content").and_then(|v| v.as_str()).map(String::from);
                async_drive(|| async { crate::commands::file_explorer::create_file(path, content).await })
            }
            "createDirectory" => {
                let path = require_str(&params, "path")?;
                async_drive(|| async { crate::commands::file_explorer::create_directory(path).await })
            }
            "deleteFile" => {
                let path = require_str(&params, "path")?;
                async_drive(|| async { crate::commands::file_explorer::delete_file(path).await })
            }
            "renameFile" => {
                let old_path = require_str(&params, "old_path")?;
                let new_name = require_str(&params, "new_name")?;
                async_drive(|| async { crate::commands::file_explorer::rename_file(old_path, new_name).await })
            }
            "copyPath" => {
                let source = require_str(&params, "source")?;
                let destination = require_str(&params, "destination")?;
                async_drive(|| async { crate::commands::file_explorer::copy_path(source, destination).await })
            }
            "copyPathToDirectory" => {
                let source = require_str(&params, "source")?;
                let target_dir = require_str(&params, "target_dir")?;
                async_drive(|| async { crate::commands::file_explorer::copy_path_to_directory(source, target_dir).await })
            }
            "movePath" => {
                let source = require_str(&params, "source")?;
                let destination = require_str(&params, "destination")?;
                async_drive(|| async { crate::commands::file_explorer::move_path(source, destination).await })
            }
            "movePathToDirectory" => {
                let source = require_str(&params, "source")?;
                let target_dir = require_str(&params, "target_dir")?;
                async_drive(|| async { crate::commands::file_explorer::move_path_to_directory(source, target_dir).await })
            }
            "saveDroppedFileToDirectory" => {
                let target_dir = require_str(&params, "target_dir")?;
                let file_name = require_str(&params, "file_name")?;
                let content_base64 = require_str(&params, "content_base64")?;
                async_drive(|| async {
                    crate::commands::file_explorer::save_dropped_file_to_directory(target_dir, file_name, content_base64).await
                })
            }
            "pathExists" => {
                let path = require_str(&params, "path")?;
                async_drive(|| async { crate::commands::file_explorer::path_exists(path).await })
            }
            "searchFiles" => {
                let work_dir = require_str(&params, "work_dir")?;
                let query = require_str(&params, "query")?;
                let max_results = params.get("max_results").and_then(|v| v.as_u64()).map(|v| v as usize);
                async_drive(|| async { crate::commands::file_explorer::search_files(work_dir, query, max_results).await })
            }
            "searchFileContents" => {
                let work_dir = require_str(&params, "work_dir")?;
                let query = require_str(&params, "query")?;
                let case_sensitive = params.get("case_sensitive").and_then(|v| v.as_bool());
                let whole_word = params.get("whole_word").and_then(|v| v.as_bool());
                let max_results = params.get("max_results").and_then(|v| v.as_u64()).map(|v| v as usize);
                async_drive(|| async {
                    crate::commands::file_explorer::search_file_contents_detailed(work_dir, query, case_sensitive, whole_word, max_results).await
                })
            }
            "downloadFileBinary" => {
                let path = require_str(&params, "path")?;
                async_drive(|| async { crate::commands::file_explorer::download_file_binary(path).await })
            }
            "downloadDirectoryToZip" => {
                let dir_path = require_str(&params, "dir_path")?;
                async_drive(|| async { crate::commands::file_explorer::download_directory_to_zip(dir_path).await })
            }
            "saveImageBytes" => {
                let path = require_str(&params, "path")?;
                let data_base64 = require_str(&params, "data_base64")?;
                async_drive(|| async { crate::commands::file_explorer::save_image_bytes(path, data_base64).await })
            }
            other => Err(unsupported_action(CAP_ID, other, FS_ACTIONS)),
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

    #[test]
    fn describe_contract() {
        let d = FsCapability.describe();
        let problems = crate::contracts::validate_describe(CAP_ID, &d);
        assert!(problems.is_empty(), "describe 应过契约校验: {problems:?}");
        // actions 键与 FS_ACTIONS 常量一致（未知动作错误文案与 describe 同源）
        let mut keys: Vec<&str> = d["actions"]
            .as_object()
            .expect("actions 应为对象")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        let mut expected: Vec<&str> = FS_ACTIONS.to_vec();
        expected.sort_unstable();
        assert_eq!(keys, expected, "describe 动作清单应与 FS_ACTIONS 一致");
    }
}
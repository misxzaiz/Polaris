//! 插件 skill 同步（P4，2026-10-24 审计：插件注册 skill 的通道）
//!
//! 宿主已有健康的 SKILL.md 机制（SimpleAI `discover_skills` 扫描
//! `<work_dir>/.polaris/skills/` 与 `<DataRoot>/skills/`，索引注入 + read_skill
//! 按需加载），但插件此前无注册通道（manifest `deny_unknown_fields` 下写
//! skills 块整个装不上）。
//!
//! 设计：**复制到 DataRoot 权威目录**——把启用插件 `<pluginDir>/skills/<id>/`
//! 整目录复制到 `<DataRoot>/skills/plugin-<pluginId>-<id>/`，引擎零改动；
//! 目录名前缀 `plugin-` 即命名空间（skill 同名冲突按目录名去重，插件 skill
//! 永远不与用户手写 skill 同名）。生命周期事件时全量对账：
//! - 启用插件：SKILL.md 源 mtime 较新或目标缺失 → 递归复制（更新生效）；
//! - 禁用/卸载/目录缺失：删除对应 `plugin-*` 孤儿目录。
//!
//! 复制而非引用的原因：DataRoot 是 skill 发现的唯一可写权威路径，引用
//! （symlink/索引扩展）需要动引擎发现协议，收益不成比例。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use crate::models::plugin::DiscoveredPluginManifest;
use crate::models::plugin_state::PluginStateMap;

/// DataRoot skills 目录
fn skills_root() -> PathBuf {
    crate::services::data_root::data_root().root().join("skills")
}

/// 插件 skill 同步目录名（命名空间前缀）
fn sync_dir_name(plugin_id: &str, skill_id: &str) -> String {
    // 目录名安全化：插件 id / skill id 理论上可能含路径分隔符——压平
    let safe = |s: &str| {
        s.chars()
            .map(|c| if matches!(c, '/' | '\\' | ':' | '.') { '_' } else { c })
            .collect::<String>()
    };
    format!("plugin-{}-{}", safe(plugin_id), safe(skill_id))
}

/// 全量对账（幂等）。返回当前生效的插件 skill 同步目录名列表。
pub fn sync_plugin_skills(
    plugins: &[DiscoveredPluginManifest],
    plugin_states: &PluginStateMap,
) -> Vec<String> {
    let root = skills_root();
    let _ = std::fs::create_dir_all(&root);

    // 1) 期望集合：启用插件的 skills 声明
    let mut expected: BTreeSet<String> = BTreeSet::new();
    for plugin in plugins {
        if plugin.contributes.skills.is_empty() {
            continue;
        }
        let enabled = plugin_states
            .get(&plugin.id)
            .map(|st| st.enabled)
            .unwrap_or(plugin.enabled_by_default);
        if !enabled {
            continue;
        }
        for skill in &plugin.contributes.skills {
            expected.insert(sync_dir_name(&plugin.id, &skill.id));
        }
    }

    // 2) 删除孤儿（plugin- 前缀但不在期望集合）
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("plugin-") && !expected.contains(&name) {
                let _ = std::fs::remove_dir_all(entry.path());
                tracing::info!(dir = %name, "插件 skill 孤儿目录已清理");
            }
        }
    }

    // 3) 同步内容（缺失或源较新 → 递归复制）
    let mut synced = Vec::new();
    for plugin in plugins {
        let enabled = plugin_states
            .get(&plugin.id)
            .map(|st| st.enabled)
            .unwrap_or(plugin.enabled_by_default);
        if !enabled {
            continue;
        }
        for skill in &plugin.contributes.skills {
            let source = Path::new(&plugin.install_path).join("skills").join(&skill.id);
            if !source.join("SKILL.md").is_file() {
                tracing::warn!(
                    plugin = %plugin.id,
                    skill = %skill.id,
                    "contributes.skills 声明的目录缺少 SKILL.md，跳过（期望 <pluginDir>/skills/<id>/SKILL.md）"
                );
                continue;
            }
            let dest = root.join(sync_dir_name(&plugin.id, &skill.id));
            if !dest.exists() || source_fresher(&source, &dest) {
                if dest.exists() {
                    let _ = std::fs::remove_dir_all(&dest);
                }
                match copy_dir_recursive(&source, &dest) {
                    Ok(()) => tracing::info!(
                        plugin = %plugin.id,
                        skill = %skill.id,
                        dest = %dest.display(),
                        "插件 skill 已同步到 DataRoot"
                    ),
                    Err(e) => {
                        tracing::warn!(plugin = %plugin.id, skill = %skill.id, error = %e, "插件 skill 同步失败");
                        continue;
                    }
                }
            }
            synced.push(sync_dir_name(&plugin.id, &skill.id));
        }
    }
    synced
}

/// 源 SKILL.md 是否比目标目录内 SKILL.md 新（插件更新后内容刷新）
fn source_fresher(source: &Path, dest: &Path) -> bool {
    let src_md = source.join("SKILL.md");
    let dst_md = dest.join("SKILL.md");
    let modified = |p: &Path| {
        std::fs::metadata(p)
            .and_then(|m| m.modified())
            .ok()
            .unwrap_or(std::time::UNIX_EPOCH)
    };
    modified(&src_md) > modified(&dst_md)
}

/// 递归复制目录（文件粒度 create_dir_all + copy）
fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("创建目录失败: {}", e))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("读目录失败: {}", e))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        let target = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target).map_err(|e| format!("复制失败: {}", e))?;
        }
    }
    Ok(())
}

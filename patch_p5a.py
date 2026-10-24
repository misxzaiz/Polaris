import io, re

# ============ 1) Rust：views slot/slotMode 字段（漂移修复）+ 校验 ============
p = 'src-tauri/src/models/plugin.rs'
s = io.open(p, encoding='utf-8').read()
old = """pub struct PluginViewContribution {
    pub id: String,
    pub area: String,
    pub panel_type: String,
    pub icon: String,
    pub label_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label_default: Option<String>,
    pub order: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub badge: Option<String>,
}"""
new = """pub struct PluginViewContribution {
    pub id: String,
    pub area: String,
    pub panel_type: String,
    pub icon: String,
    pub label_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label_default: Option<String>,
    pub order: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub badge: Option<String>,
    /// 插槽定位（P5，2026-10-24 审计漂移修复）：前端 types.ts 早已支持
    /// slot/slotMode（shadow/chain/append），Rust 侧此前缺字段——外部插件
    /// manifest 声明了会因 deny_unknown_fields 整体装不上（该功能实际只对
    /// 前端内嵌 builtin 插件可用）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot: Option<String>,
    /// 插槽模式：shadow（覆盖默认面板）| chain（链式替换）| append（追加）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot_mode: Option<String>,
}"""
assert old in s, 'view struct'
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('views slot fields added')

# 校验：slotMode 值域（validate_manifest_fields views 段）
p = 'src-tauri/src/services/plugin_service.rs'
s = io.open(p, encoding='utf-8').read()
import re
m = re.search(r'(    for view in &views \{.*?\n    \}\n)', s, re.S)
assert m, 'views validation loop'
old = m.group(1)
# 在循环体末尾追加 slotMode 校验（保持缩进）
lines = old.rstrip('\n').split('\n')
# 找循环体最后一行（'}' 前）
body_end = len(lines) - 2  # lines[-1] 是 '    }'
insert_at = body_end
addition = """        // P5：slotMode 值域校验（值错误延迟到运行时静默失效，前移到安装期）
        if let Some(mode) = &view.slot_mode {
            if !matches!(mode.as_str(), "shadow" | "chain" | "append") {
                errors.push(format!(
                    "views[{}].slotMode 非法: {}（仅支持 shadow | chain | append）",
                    view.id, mode
                ));
            }
        }
"""
lines.insert(insert_at, addition.rstrip('\n'))
new_loop = '\n'.join(lines) + '\n'
s = s.replace(old, new_loop, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('slotMode validation added')

import io

# ============ 1) models/plugin.rs：capabilities 贡献声明 ============
p = 'src-tauri/src/models/plugin.rs'
s = io.open(p, encoding='utf-8').read()

old = """    /// 工具能力覆盖（AI 引擎工具域替换）
    #[serde(default)]"""
if old not in s:
    # 找 contributes 结构里 tool_providers 字段行做锚
    import re
    m = re.search(r'(    /// 工具能力覆盖[^\n]*\n    #\[serde\(default\)\]\n    pub tool_providers: Vec<PluginToolProviderManifestContribution>,\n)', s)
    assert m, 'tool_providers anchor'
    old = m.group(1)
new = old + """
    /// 插件提供的 cap（P2-d，2026-10-24 审计：「插件注册提供 cap」的声明面）。
    /// handler 形态与 cap.registry register 一致（forward / plugin-rpc）；
    /// replaces=true 表示覆盖既有 cap（分级授权仍生效）。装配见
    /// services/plugin_capability_assembly.rs。
    #[serde(default)]
    pub capabilities: Vec<PluginCapabilityManifestContribution>,
"""
s = s.replace(old, new, 1)

# 结构体定义：追加在 PluginToolProviderManifestContribution 定义之后
import re
m = re.search(r'pub struct PluginToolProviderManifestContribution \{[^}]*\}\n', s)
assert m, 'tool provider struct'
insert_at = m.end()
addition = '''
/// 插件提供的 cap 声明（P2-d）。handler 以 JSON 承载（与 cap.registry 的
/// handler 形态一致），装配时反序列化为 DynamicHandler 并校验——models 层
/// 不依赖 services/router 类型（分层纪律）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCapabilityManifestContribution {
    /// 注册的 cap id（cap.* 开头；replaces=true 时为目标既有 cap id）
    pub id: String,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// handler 定义（JSON：{type:"forward",target,defaults?} 或
    /// {type:"plugin-rpc",pluginId?,serverId,tool,timeoutMs?}）
    pub handler: serde_json::Value,
    /// 覆盖注册：true = id 为既有 cap，走覆盖链（L0/L2/L4 分级授权仍生效）
    #[serde(default)]
    pub replaces: bool,
    /// 覆盖模式（override | fallback；缺省 override）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replace_mode: Option<String>,
}
'''
s = s[:insert_at] + addition + s[insert_at:]
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('manifest capabilities added')

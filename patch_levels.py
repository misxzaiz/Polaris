import io

# ============ 1) models/config.rs：capOverride 字段 ============
p = 'src-tauri/src/models/config.rs'
s = io.open(p, encoding='utf-8').read()
old = """    /// dispatch 权限策略（第五步 PolicyPermission 覆盖规则；缺省 = 全放行）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<PermissionPolicyConfig>,"""
new = """    /// dispatch 权限策略（第五步 PolicyPermission 覆盖规则；缺省 = 全放行）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<PermissionPolicyConfig>,

    /// cap 覆盖授权（P2-c，2026-10-24 审计）：L2 级能力（bash/fs/http 等高危域）
    /// 被插件覆盖需在此白名单显式列出目标 cap id；L0（prompt_snippet/ui/kv 等
    /// 低危域）无需配置，L4（registry/help/ai.chat/self/mcp）永不放开。
    #[serde(default)]
    pub cap_override: CapOverrideConfig,"""
assert old in s, 'config permissions anchor'
s = s.replace(old, new)

# 结构体定义（追加在 PermissionPolicyConfig 附近）
anchor = "/// dispatch 权限策略（第五步 PolicyPermission 覆盖规则；缺省 = 全放行）"
idx = s.index(anchor)
# 找 struct Config 定义前的合适位置——直接放在 Config struct 之前
struct_idx = s.rindex('pub struct Config', 0, idx)
insert_before = s.rindex('\n', 0, s.rindex('\n', 0, struct_idx)) + 1
addition = """/// cap 覆盖授权配置（P2-c）：L2 级覆盖白名单
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapOverrideConfig {
    /// 允许被插件覆盖的 L2 级 cap id 白名单
    #[serde(default)]
    pub allow: Vec<String>,
}

"""
s = s[:insert_before] + addition + s[insert_before:]
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('config cap_override added')

# ============ 2) registry_capability.rs：replace 分支 + 分级 + unregister ============
p = 'src-tauri/src/services/router/registry_capability.rs'
s = io.open(p, encoding='utf-8').read()

# 2a. SENSITIVE_TARGETS 后加分级表
old = '''const SENSITIVE_TARGETS: [&str; 4] = ["cap.ai.chat", "cap.registry", "cap.help", "cap.context"];'''
new = '''const SENSITIVE_TARGETS: [&str; 4] = ["cap.ai.chat", "cap.registry", "cap.help", "cap.context"];

/// 覆盖分级表（P2-c，2026-10-24 审计；替代旧 SENSITIVE_TARGETS 一刀切）：
/// - L0 低危/展示域：任意插件可覆盖（无需授权）；
/// - L2 高危域：需 config.capOverride.allow 白名单显式列出；
/// - L4 永不覆盖：元能力/自递归高危/AI 核心通道（config 也不可放开）。
/// 其余一律按 L2 处理（保守默认）。
const OVERRIDE_L0_PREFIXES: &[&str] = &["cap.prompt_snippet", "cap.ui.", "cap.kv", "cap.history", "cap.context"];
const OVERRIDE_L4_PREFIXES: &[&str] = &[
    "cap.registry", "cap.help", "cap.ai.chat", "cap.stream.", "cap.self.",
    "cap.mcp", "cap.voice", "cap.hook", "cap.plugin",
];'''
assert old in s, 'sensitive targets'
s = s.replace(old, new)

# 2b. do_register：replace 分支
old = """        // 拒绝覆盖既有 cap（含内置与已注册动态）
        self.check_id_available(id)?;

        let persist = params.get("persist").and_then(Value::as_bool).unwrap_or(true);"""
new = """        // 覆盖注册（P2-c）：replace=true 时 id 可以是既有 cap（经分级授权表放行），
        // handler 复用 forward / plugin-rpc 实现（覆盖栈栈顶 active）。
        // v1 覆盖不持久化——重启后覆盖失效、base 恢复（安全降级，记录于 spec）。
        let replace = params.get("replace").and_then(Value::as_bool).unwrap_or(false);
        if replace {
            let mode = crate::contracts::ReplaceMode::parse(
                params.get("replaceMode").and_then(Value::as_str).unwrap_or("override"),
            )?;
            self.check_override_permission(id)?;
            self.router.register_override(
                CapabilityId(id.to_string()),
                std::sync::Arc::new(DynamicCapability::new(
                    DynamicCapabilityConfig {
                        id: id.to_string(),
                        summary: summary.to_string(),
                        description: params.get("description").and_then(Value::as_str).map(str::to_string),
                        handler,
                        persist: false,
                    },
                    self.router.clone(),
                )),
                mode,
            )?;
            tracing::warn!(
                capability = %id,
                mode = ?mode,
                "cap.override.register：能力被覆盖（审计审计链随 dispatch.ok 落 action=register）"
            );
            return Ok(json!({
                "registered": true,
                "id": id,
                "replaced": true,
                "mode": params.get("replaceMode").and_then(Value::as_str).unwrap_or("override"),
                "persisted": false,
                "note": "覆盖注册 v1 不持久化：宿主重启后覆盖失效，base handler 自动恢复",
            }));
        }

        // 拒绝覆盖既有 cap（含内置与已注册动态）
        self.check_id_available(id)?;

        let persist = params.get("persist").and_then(Value::as_bool).unwrap_or(true);"""
assert old in s, 'do_register replace branch'
s = s.replace(old, new)

# 2c. 分级判定方法（impl RegistryCapability 内；找 check_id_available 旁）
old = """    /// 目标 id 是否可用（未注册；含内置与动态）——注册前检查
    fn check_id_available(&self, id: &str) -> Result<(), String> {"""
if old not in s:
    # 找实际注释
    import re
    m = re.search(r'(    /// [^\n]*\n)+?    fn check_id_available', s)
    old = s[s.rindex('\n', 0, m.start())+1:m.end()] if m else None
assert old, 'check_id_available anchor not found'
new = """    /// 覆盖权限分级判定（P2-c）：L0 放行 / L2 白名单 / L4 拒绝
    fn check_override_permission(&self, id: &str) -> Result<(), String> {
        if !id.starts_with("cap.") {
            return Err(format!("覆盖目标必须以 `cap.` 开头: {}", id));
        }
        if OVERRIDE_L4_PREFIXES.iter().any(|p| id.starts_with(p)) {
            return Err(format!(
                "覆盖目标 {} 属于 L4 永不覆盖域（元能力/自递归高危/AI 核心通道），config 也不可放开",
                id
            ));
        }
        if OVERRIDE_L0_PREFIXES.iter().any(|p| id.starts_with(p)) {
            return Ok(());
        }
        if self.router.override_allowed(id) {
            Ok(())
        } else {
            Err(format!(
                "覆盖目标 {} 属于 L2 高危域：需在 config.capOverride.allow 白名单显式列出后方可覆盖",
                id
            ))
        }
    }

"""
# 在 check_id_available fn 之前插入
idx = s.index(old) if isinstance(old, str) else 0
# 用精确 fn 行定位
fn_idx = s.index('fn check_id_available')
# 插到它前面的注释块之前——找 fn 前最近的空行
s2 = s[:fn_idx]
insert_at = s2.rindex('\n\n')
s = s[:insert_at] + '\n' + new + s[insert_at+1:]
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('override permission levels added')

# 2d. do_unregister 先试覆盖弹出
old = """        // 只允许卸载动态能力 —— 通过「是否在持久化域或由本注册器标记」判断：
        // 内置能力不在动态域，unregister 内置是危险操作，拒绝。
        let was_dynamic = self.router.is_dynamic(&CapabilityId(id.into()));
        if !was_dynamic {"""
new = """        // P2-c：先试弹出覆盖层（覆盖方卸载 → base handler 无感恢复）
        if self.router.unregister_override(&CapabilityId(id.clone())) {
            tracing::warn!(capability = %id, "cap.override.unregister：覆盖弹出，base handler 恢复");
            return Ok(json!({
                "unregistered": true,
                "id": id,
                "mode": "override-popped",
                "note": "覆盖层已弹出，原 handler 恢复响应",
            }));
        }
        // 只允许卸载动态能力 —— 通过「是否在持久化域或由本注册器标记」判断：
        // 内置能力不在动态域，unregister 内置是危险操作，拒绝。
        let was_dynamic = self.router.is_dynamic(&CapabilityId(id.into()));
        if !was_dynamic {"""
assert old in s, 'do_unregister anchor'
s = s.replace(old, new)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('do_unregister override pop added')

# ============ 3) state.rs：allowlist 注入 ============
p = 'src-tauri/src/state.rs'
s = io.open(p, encoding='utf-8').read()
old = """    };

    // P1-g：Prompt 裁决的用户审批出口（非阻塞批准 + 重试模式）。"""
new = """    };
    // P2-c：L2 覆盖白名单（config.capOverride.allow）注入
    {
        let allow = config_store_arc.lock().unwrap().get().cap_override.allow.clone();
        router.set_override_allowlist(allow);
    }

    // P1-g：Prompt 裁决的用户审批出口（非阻塞批准 + 重试模式）。"""
assert old in s, 'state allowlist anchor'
s = s.replace(old, new)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('state allowlist injected')

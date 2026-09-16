//! PolicyPermission —— dispatch 权限策略矩阵（第五步阶段 C）
//!
//! 对应 `dev/docs/sky/step5-permission-audit.md` §2.C：
//! - 策略模型：`(source_class, capability)` → Allow/Deny/Prompt 静态矩阵
//! - 规则来源：内置默认表（空 = 全放行，与历史 `StaticPermission` 行为**等价**，
//!   本阶段零回归）+ `config.json` 的 `permissions.rules` 覆盖（装配时载入，
//!   运行中改动需重启生效——机制先行，热加载后置）。
//! - 匹配语义：精确匹配特异性 > 前缀通配（`cap.config*`）；同特异性时
//!   **后配置的规则覆盖先配置的**（config 覆盖语义）。
//! - 无匹配规则 → Allow（默认等价）；收紧规则由 config 显式启用。
//! - `prompt` 裁决原样返回 `PermissionVerdict::Prompt`，由 dispatch 统一安全失败
//!   （Phase 0 无审批 UI，见契约注释）。
//!
//! # cap.config 不在内置 deny 的原因
//!
//! `cap.config` **读**是 Web/移动端（`Source::Remote`）连接与驱动的刚需
//! （`configService.getConfig` → `cap.config get full`，连接前第一步），
//! 曾内置 `cap.config*` + Remote deny，导致移动端/Web 连接即「权限拒绝」。
//! `cap.config` 的**写保护**下沉到 `ConfigCapability::invoke` 内部按 source
//! 校验（Remote 拒绝写，Bootstrap / Plugin 放行），因为能力 id 是扁平的，
//! 策略矩阵按 `(source, capability)` 无法区分同能力内的读/写动作。
//! 内置 deny 仅保留能力级「远程完全不可用」域：`cap.data_root*` / `cap.plugin*`。
use crate::contracts::{Permission, PermissionRequest, PermissionVerdict, Source};
use crate::models::config::PermissionPolicyConfig;
use std::sync::RwLock;

/// 来源分类（对应契约 Source 三变体）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SourceClass {
    Bootstrap,
    Remote,
    Plugin,
}

impl SourceClass {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "bootstrap" => Some(Self::Bootstrap),
            "remote" => Some(Self::Remote),
            "plugin" => Some(Self::Plugin),
            _ => None,
        }
    }

    fn of(source: &Source) -> Self {
        match source {
            Source::Bootstrap => Self::Bootstrap,
            Source::Remote { .. } => Self::Remote,
            Source::Plugin { .. } => Self::Plugin,
        }
    }
}

/// 裁决结果（allow / deny / prompt）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuleVerdict {
    Allow,
    Deny,
    Prompt,
}

impl RuleVerdict {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "allow" => Some(Self::Allow),
            "deny" => Some(Self::Deny),
            "prompt" => Some(Self::Prompt),
            _ => None,
        }
    }

    fn to_contract(self) -> PermissionVerdict {
        match self {
            RuleVerdict::Allow => PermissionVerdict::Allow,
            RuleVerdict::Deny => PermissionVerdict::Deny,
            RuleVerdict::Prompt => PermissionVerdict::Prompt,
        }
    }
}

/// 编译后的策略规则
#[derive(Debug, Clone)]
struct CompiledRule {
    /// 能力 id（精确）或前缀通配（去 `*` 后的前缀，如 `cap.config`）
    capability: String,
    wildcard: bool,
    source: SourceClass,
    verdict: RuleVerdict,
}

impl CompiledRule {
    /// 特异性：精确=2，前缀通配=1
    fn specificity(&self) -> u8 {
        if self.wildcard {
            1
        } else {
            2
        }
    }

    fn matches(&self, capability: &str, source: SourceClass) -> bool {
        if self.source != source {
            return false;
        }
        if self.wildcard {
            capability.starts_with(&self.capability)
        } else {
            capability == self.capability
        }
    }
}

/// 策略权限（dispatch 唯一入口的统一 gate）
///
/// 空规则表 = 全放行（与 `StaticPermission` 等价）；收紧规则经 config 显式启用。
pub struct PolicyPermission {
    rules: RwLock<Vec<CompiledRule>>,
}

impl PolicyPermission {
    /// 默认策略：无规则 = 全放行（与现状等价，零回归）
    pub fn new() -> Self {
        Self {
            rules: RwLock::new(Vec::new()),
        }
    }

    /// 从 config.json `permissions` 段构造。
    ///
    /// 装配时校验：非法规则跳过并记 warn（不阻塞启动，可见可查）；
    /// 全部规则合法时行为与配置严格一致。
    pub fn from_config(config: Option<&PermissionPolicyConfig>) -> Self {
        let mut rules = Vec::new();
        if let Some(cfg) = config {
            for rule in &cfg.rules {
                let (Some(source), Some(verdict)) = (
                    SourceClass::parse(&rule.source),
                    RuleVerdict::parse(&rule.verdict),
                ) else {
                    tracing::warn!(
                        "[PolicyPermission] 跳过非法规则：capability={}, source={}, verdict={}",
                        rule.capability,
                        rule.source,
                        rule.verdict
                    );
                    continue;
                };
                if rule.capability.is_empty() {
                    tracing::warn!("[PolicyPermission] 跳过空 capability 规则");
                    continue;
                }
                let (capability, wildcard) = match rule.capability.strip_suffix('*') {
                    Some(prefix) => (prefix.to_string(), true),
                    None => (rule.capability.clone(), false),
                };
                rules.push(CompiledRule {
                    capability,
                    wildcard,
                    source,
                    verdict,
                });
            }
        }
        // 首批内置收紧（安全基线）：管理面能力禁止远程（Web/HTTP/Remote 会话）触碰。
        // 追加在 config 规则之后 → `best_match` 同特异性后者覆盖前者，
        // 用户在 config 显式 allow（精确规则特异性更高）可覆盖内置 deny。
        // step7 §4 验收：规则固化为代码内置默认，config 缺省也生效，部署/换机不丢。
        // 注意：cap.config 不在其中 —— 见模块文档，远程读是 Web/移动端刚需，
        // 写保护下沉到 ConfigCapability::invoke 内按 source 校验。
        for (cap_prefix, wildcard) in [
            ("cap.data_root", true),
            ("cap.plugin", true),
        ] {
            rules.push(CompiledRule {
                capability: cap_prefix.to_string(),
                wildcard,
                source: SourceClass::Remote,
                verdict: RuleVerdict::Deny,
            });
        }
        Self {
            rules: RwLock::new(rules),
        }
    }

    /// 当前生效规则数（诊断用）

    /// 当前生效规则数（诊断用）
    pub fn rule_count(&self) -> usize {
        self.rules.read().unwrap().len()
    }

    /// 命中规则（无匹配 → None；特异性高者优先，同特异性后者覆盖前者）
    fn best_match(&self, capability: &str, source: SourceClass) -> Option<CompiledRule> {
        let rules = self.rules.read().unwrap();
        let mut best: Option<(u8, CompiledRule)> = None;
        for rule in rules.iter() {
            if rule.matches(capability, source) {
                let spec = rule.specificity();
                match &best {
                    Some((best_spec, _)) if *best_spec > spec => {}
                    _ => best = Some((spec, rule.clone())),
                }
            }
        }
        best.map(|(_, r)| r)
    }
}

impl Default for PolicyPermission {
    fn default() -> Self {
        Self::new()
    }
}

impl Permission for PolicyPermission {
    fn check(&self, req: &PermissionRequest) -> Result<PermissionVerdict, String> {
        let class = SourceClass::of(&req.source);
        match self.best_match(&req.capability.0, class) {
            Some(rule) => Ok(rule.verdict.to_contract()),
            None => Ok(PermissionVerdict::Allow),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::CapabilityId;

    fn req(cap: &str, source: Source) -> PermissionRequest {
        PermissionRequest {
            capability: CapabilityId(cap.into()),
            resource: cap.into(),
            source,
        }
    }

    fn policy_from(rules: serde_json::Value) -> PolicyPermission {
        let cfg: PermissionPolicyConfig = serde_json::from_value(rules).unwrap();
        PolicyPermission::from_config(Some(&cfg))
    }

    #[test]
    fn empty_policy_equals_static_permission() {
        // 默认等价：空策略对任意 (capability, source) 全放行
        let p = PolicyPermission::new();
        for source in [
            Source::Bootstrap,
            Source::Remote { token: "t".into() },
            Source::Plugin { caller: crate::contracts::PluginId("cap.ai".into()) },
        ] {
            for cap in ["cap.todo", "cap.kv", "cap.config"] {
                assert_eq!(
                    p.check(&req(cap, source.clone())).unwrap(),
                    PermissionVerdict::Allow
                );
            }
        }
    }

    #[test]
    fn deny_remote_write_rule() {
        // 预埋管理面规则：Remote 对 cap.config* 拒绝（对应域迁移后启用）
        let p = policy_from(serde_json::json!({
            "rules": [
                { "capability": "cap.config*", "source": "remote", "verdict": "deny" }
            ]
        }));
        assert_eq!(
            p.check(&req("cap.config", Source::Remote { token: "t".into() })).unwrap(),
            PermissionVerdict::Deny
        );
        assert_eq!(
            p.check(&req("cap.config.write", Source::Remote { token: "t".into() })).unwrap(),
            PermissionVerdict::Deny,
            "前缀通配应命中子路径"
        );
        // Bootstrap 不受限
        assert_eq!(
            p.check(&req("cap.config", Source::Bootstrap)).unwrap(),
            PermissionVerdict::Allow
        );
    }

    #[test]
    fn exact_rule_beats_wildcard() {
        let p = policy_from(serde_json::json!({
            "rules": [
                { "capability": "cap.config*", "source": "remote", "verdict": "deny" },
                { "capability": "cap.config.read", "source": "remote", "verdict": "allow" }
            ]
        }));
        // 精确规则特异性 2 > 通配 1
        assert_eq!(
            p.check(&req("cap.config.read", Source::Remote { token: "t".into() })).unwrap(),
            PermissionVerdict::Allow
        );
        assert_eq!(
            p.check(&req("cap.config.write", Source::Remote { token: "t".into() })).unwrap(),
            PermissionVerdict::Deny
        );
    }

    #[test]
    fn later_rule_overrides_at_same_specificity() {
        let p = policy_from(serde_json::json!({
            "rules": [
                { "capability": "cap.kv", "source": "remote", "verdict": "deny" },
                { "capability": "cap.kv", "source": "remote", "verdict": "allow" }
            ]
        }));
        assert_eq!(
            p.check(&req("cap.kv", Source::Remote { token: "t".into() })).unwrap(),
            PermissionVerdict::Allow,
            "同特异性后者覆盖（config 覆盖语义）"
        );
    }

    #[test]
    fn prompt_verdict_passes_through() {
        let p = policy_from(serde_json::json!({
            "rules": [
                { "capability": "cap.shell", "source": "plugin", "verdict": "prompt" }
            ]
        }));
        assert_eq!(
            p.check(&req("cap.shell", Source::Plugin { caller: crate::contracts::PluginId("cap.ai".into()) })).unwrap(),
            PermissionVerdict::Prompt,
            "prompt 由 dispatch 统一安全失败"
        );
    }

#[test]
    fn invalid_rules_are_skipped() {
        let p = policy_from(serde_json::json!({
            "rules": [
                { "capability": "cap.x", "source": "bogus", "verdict": "deny" },
                { "capability": "cap.y", "source": "remote", "verdict": "maybe" },
                { "capability": "", "source": "remote", "verdict": "deny" },
                { "capability": "cap.valid", "source": "remote", "verdict": "deny" }
            ]
        }));
        // 1 条合法 config 规则 + 2 条内置收紧（cap.data_root*/cap.plugin* remote deny）
        assert_eq!(p.rule_count(), 3, "三条非法规则应被跳过，内置默认并入");
        assert_eq!(
            p.check(&req("cap.valid", Source::Remote { token: "t".into() })).unwrap(),
            PermissionVerdict::Deny
        );
        // 未命中 → 放行（默认等价）
        assert_eq!(
            p.check(&req("cap.other", Source::Remote { token: "t".into() })).unwrap(),
            PermissionVerdict::Allow
        );
    }

    #[test]
    fn builtin_rules_deny_remote_management_caps() {
        // config 缺省（from_config(None)）也收紧管理面：内置默认规则生效
        let p = PolicyPermission::from_config(None);
        // cap.config 读是 Web/移动端刚需 → 策略层放行（写保护下沉到能力内）
        assert_eq!(
            p.check(&req("cap.config", Source::Remote { token: "t".into() })).unwrap(),
            PermissionVerdict::Allow,
            "cap.config 策略层放行（读必需；写由能力内 source 校验）"
        );
        assert_eq!(
            p.check(&req("cap.config.write", Source::Remote { token: "t".into() })).unwrap(),
            PermissionVerdict::Allow,
            "cap.config* 不再内置 deny"
        );
        for cap in ["cap.data_root", "cap.data_root.get_info",
                    "cap.pluginDiscovery", "cap.pluginServiceManager", "cap.plugin_foo"] {
            assert_eq!(
                p.check(&req(cap, Source::Remote { token: "t".into() })).unwrap(),
                PermissionVerdict::Deny,
                "管理面 {cap} 应被内置规则拒绝（Remote）"
            );
        }
        // 未管理面能力不受影响
        assert_eq!(
            p.check(&req("cap.kv", Source::Remote { token: "t".into() })).unwrap(),
            PermissionVerdict::Allow
        );
        // Bootstrap / Plugin source 不受内置 deny 影响
        assert_eq!(
            p.check(&req("cap.data_root", Source::Bootstrap)).unwrap(),
            PermissionVerdict::Allow
        );
        assert_eq!(
            p.check(&req("cap.pluginDiscovery", Source::Plugin { caller: crate::contracts::PluginId("cap.ai".into()) })).unwrap(),
            PermissionVerdict::Allow
        );
    }

    #[test]
    fn user_config_can_relax_builtin() {
        // config 显式 allow（精确规则特异性更高）可覆盖内置前缀 deny
        let p = policy_from(serde_json::json!({
            "rules": [
                { "capability": "cap.pluginDiscovery", "source": "remote", "verdict": "allow" }
            ]
        }));
        assert_eq!(
            p.check(&req("cap.pluginDiscovery", Source::Remote { token: "t".into() })).unwrap(),
            PermissionVerdict::Allow,
            "config 精确 allow 覆盖内置通配 deny"
        );
        // 未被覆盖的相邻前缀仍受内置 deny
        assert_eq!(
            p.check(&req("cap.pluginServiceManager", Source::Remote { token: "t".into() })).unwrap(),
            PermissionVerdict::Deny
        );
    }
}

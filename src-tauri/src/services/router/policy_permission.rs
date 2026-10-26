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
//! 写保护曾下沉到 `ConfigCapability::invoke` 内部按 source 校验（Remote 拒绝写），
//! 产品决策已放开：远程（Web/移动端）可写，鉴权依赖传输层 token。
//! 内置 deny 仅保留能力级「远程完全不可用」域：`cap.data_root*` / `cap.plugin*`
//! （`cap.plugin*` 中 `cap.pluginDiscovery` 的只读动作经 P1-h 拆分放行，见
//! `from_config` 内注释与 `plans/plugin-discovery-remote-readonly-split.md`）。
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
    /// 仅对「已鉴权 Remote」（token 与 config.web.token 匹配）生效的内置放行规则
    /// （P1-f，2026-10-24 审计 X9/X7：Web 模式插件服务管理放行子集）。
    /// 用户 config 规则恒为 false（不受 token 影响）。
    require_auth: bool,
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
    /// config.web.token（P1-f）：非空时「token 匹配的 Remote」视为已鉴权 Web 会话，
    /// `require_auth` 的内置放行规则对其生效（如 cap.pluginServiceManager）。
    /// None/未设置 → Remote 维持现状全 deny（X9 零回归）。
    web_token: RwLock<Option<String>>,
}

impl PolicyPermission {
    /// 默认策略：无规则 = 全放行（与现状等价，零回归）
    pub fn new() -> Self {
        Self {
            rules: RwLock::new(Vec::new()),
            web_token: RwLock::new(None),
        }
    }

    /// 注入 web 鉴权 token（装配时从 config.web.token 读取；P1-f）
    pub fn set_web_token(&self, token: Option<String>) {
        *self.web_token.write().unwrap() = token.filter(|t| !t.is_empty());
    }

    /// source 是否为「已鉴权 Remote」（token 与 web_token 一致且非空）
    fn is_authenticated_remote(&self, source: &Source) -> bool {
        let Source::Remote { token } = source else {
            return false;
        };
        if token.is_empty() {
            return false; // 内置浏览器 webview 的空 token 占位恒为未鉴权
        }
        matches!(&*self.web_token.read().unwrap(), Some(expected) if expected == token)
    }

    /// 从 config.json `permissions` 段构造。
    ///
    /// `ui_control_enabled`（config 同名字段，默认 false）：关闭时追加 Plugin 源
    /// （AI 会话）对 `cap.ui*` / `cap.self.mutate*` 的 deny。前端挂载门
    /// （disabledMcpServers）只摘 polaris-bus，挡不住 polaris-dispatch 的
    /// cap_dispatch 路径；策略层 deny 补齐该旁路（2026-10-25 治理收紧，
    /// plans/router-governance-hardening-spec.md）。与其余内置规则一致：
    /// 装配时载入、改动需重启生效；config 精确 allow（特异性更高）可覆盖。
    ///
    /// 装配时校验：非法规则跳过并记 warn（不阻塞启动，可见可查）；
    /// 全部规则合法时行为与配置严格一致。
    pub fn from_config(config: Option<&PermissionPolicyConfig>, ui_control_enabled: bool) -> Self {
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
                    require_auth: false,
                });
            }
        }
        // 首批内置收紧（安全基线）：管理面能力禁止远程（Web/HTTP/Remote 会话）触碰。
        // 追加在 config 规则之后 → `best_match` 同特异性后者覆盖前者，
        // 用户在 config 显式 allow（精确规则特异性更高）可覆盖内置 deny。
        // step7 §4 验收：规则固化为代码内置默认，config 缺省也生效，部署/换机不丢。
        // 注意：cap.config 不在其中 —— 见模块文档，远程读写均为 Web/移动端刚需。
        // cap.http 远程禁发：通用转发是 SSRF 高敏面，默认只对本地面板（Bootstrap/
        // Plugin）开放；Web/移动端需要时经 config 精确 allow 显式放开。
        for (cap_prefix, wildcard) in [
            ("cap.data_root", true),
            ("cap.http", true),
            // cap.bash 远程禁发：shell 命令执行是高危面，默认只对本地面板（Bootstrap/
            // Plugin）开放；Web/移动端需要时经 config 精确 allow 显式放开。
            ("cap.bash", true),
            // cap.fs 远程禁发：任意路径读取是高敏面，默认只对本地面板（Bootstrap/
            // Plugin）开放；Web/移动端需要时经 config 精确 allow 显式放开。
            ("cap.fs", true),
            // cap.ui 远程禁改：AI 控制界面（主题/对话渲染）作用于本地面板 DOM，
            // 远程 Web/移动端能力来源于"控制本地 UI"无意义且在跨端场景下会漂移。
            // 默认只对本地面板（Bootstrap/Plugin）开放；远程需要时经 config 精确 allow。
            // 注：AI 工具暴露的大闸在前端 uiControlEnabled（默认 false），此处防远程直连旁路。
            ("cap.ui", true),
            // cap.self.mutate 远程禁改：AI 改造（UI 部件插槽注入）与 cap.ui 同域——
            // 作用于本地面板 DOM，远程控制无意义且可被旁路利用。只读的 cap.self.inspect
            // 不受影响（精确前缀不同），仍对 Remote 放行（"看清这台机器"是远程刚需）。
            ("cap.self.mutate", true),
        ] {
            rules.push(CompiledRule {
                capability: cap_prefix.to_string(),
                wildcard,
                source: SourceClass::Remote,
                verdict: RuleVerdict::Deny,
                require_auth: false,
            });
        }
        // P1-f（X9/X7）：cap.plugin 的 Remote deny 拆为两档——
        // 已鉴权 Remote（token 匹配）放行 cap.pluginServiceManager（服务启停/状态，
        // Web 模式管理插件的刚需），cap.pluginDiscovery（安装/卸载=文件系统变更）
        // 仍 deny；未鉴权 Remote 维持全 deny（零回归）。放在 deny 之后 push，
        // 同特异性（均前缀通配）后者覆盖前者。
        rules.push(CompiledRule {
            capability: "cap.plugin".to_string(),
            wildcard: true,
            source: SourceClass::Remote,
            verdict: RuleVerdict::Deny,
            require_auth: false,
        });
        rules.push(CompiledRule {
            capability: "cap.pluginServiceManager".to_string(),
            wildcard: true,
            source: SourceClass::Remote,
            verdict: RuleVerdict::Allow,
            require_auth: true,
        });
        // P1-h（2026-10-25）：cap.pluginDiscovery 只读动作对已鉴权 Remote 放行。
        // 根因：上方 `cap.plugin*` 通配 deny 把只读发现（discover/list 等）一并挡在
        // Remote 门外，移动端/Web 插件页完全无法列插件——商城（polaris.marketplace）
        // 本身是经 discover 出现的已安装插件，故连商城入口都消失。按 P1-f 同款
        // 思路拆读写：只读动作放行（需 token 鉴权），写动作（install_*/uninstall_*/
        // apply_update = 文件系统变更）维持 deny；discover_adapter 为调试用强制
        // 刷新入口（绕缓存/熔断 + one-shot MCP 网络调用），UI 无消费方，不放行。
        // 匹配走 P1-g 动作级规则：dispatch 注入 payload.action → check 先试
        // `capId:action`（精确，特异性 2）后回退 bare id（通配 deny，特异性 1），
        // 精确 allow 胜出；未鉴权时 require_auth 规则被 best_match 跳过，回落
        // 通配 deny（X9 零回归语义不变）。spec: plans/plugin-discovery-remote-readonly-split.md
        for action in [
            "discover",
            "list",
            "install_locations",
            "validate_manifest",
            "adapters_list",
            "check_update",
        ] {
            rules.push(CompiledRule {
                capability: format!("cap.pluginDiscovery:{}", action),
                wildcard: false,
                source: SourceClass::Remote,
                verdict: RuleVerdict::Allow,
                require_auth: true,
            });
        }
        // P1-g（审计：AI 操控插件无门控）：Plugin 源（AI 会话）的高危动作需用户
        // 审批。动作编码进 resource（`capId:action`，dispatch 从 payload.action 注入），
        // 与内置 deny 同表匹配。批准经 PermissionPromptSink（一次性、10 分钟 TTL）。
        // 2026-10-26：全量停用 Plugin 源审批名单（AI 默认放行，不再弹审批）。
        // 保留名单仅注释，逻辑与规则构成不动，需要时取消注释即恢复。
        // for prompt_cap in [
        //     "cap.pluginServiceManager:stop_for_plugin",
        //     "cap.pluginServiceManager:autostart",
        //     "cap.pluginDiscovery:uninstall_local",
        //     "cap.pluginDiscovery:uninstall_with_cleanup",
        //     "cap.pluginDiscovery:force_uninstall",
        // ] {
        //     rules.push(CompiledRule {
        //         capability: prompt_cap.to_string(),
        //         wildcard: false,
        //         source: SourceClass::Plugin,
        //         verdict: RuleVerdict::Prompt,
        //         require_auth: false,
        //     });
        // }
        // 2026-10-25 高危 cap 扩面（router-governance-hardening）：AI 会话触达的
        // 宿主级破坏面默认需用户逐次审批（基建 PermissionPromptHost 已存在）。
        // - cap.bash:run：宿主级 shell 执行（任务存活期超越会话）
        // - cap.data_root:set_root：数据根迁移/切换（含 overwrite 破坏性选项）
        // - cap.registry:register：动态能力注册（可插入常驻转发/插件 RPC 通道）
        // 2026-10-26：全量停用 Plugin 源审批名单（AI 默认放行，不再弹审批）。
        // 保留名单仅注释，逻辑与规则构成不动，需要时取消注释即恢复。
        // for prompt_cap in [
        //     ("cap.bash:run", false),
        //     ("cap.data_root:set_root", false),
        //     ("cap.registry:register", false),
        // ] {
        //     rules.push(CompiledRule {
        //         capability: prompt_cap.0.to_string(),
        //         wildcard: prompt_cap.1,
        //         source: SourceClass::Plugin,
        //         verdict: RuleVerdict::Prompt,
        //         require_auth: false,
        //     });
        // }
        // ui_control_enabled=false（默认）：AI 会话禁控 UI 域（cap.ui* / cap.self.mutate*）。
        // 追加在 prompt 规则之后 → 同特异性后者覆盖，deny 优先；config 精确 allow
        // （特异性 2 > 通配 1）仍可放开。Bootstrap（本机用户直点 UI）不受影响。
        if !ui_control_enabled {
            for ui_cap in ["cap.ui", "cap.self.mutate"] {
                rules.push(CompiledRule {
                    capability: ui_cap.to_string(),
                    wildcard: true,
                    source: SourceClass::Plugin,
                    verdict: RuleVerdict::Deny,
                    require_auth: false,
                });
            }
        }
        Self {
            rules: RwLock::new(rules),
            web_token: RwLock::new(None),
        }
    }

    /// 当前生效规则数（诊断用）
    pub fn rule_count(&self) -> usize {
        self.rules.read().unwrap().len()
    }

    /// 命中规则（无匹配 → None；特异性高者优先，同特异性后者覆盖前者）。
    /// `keys`：候选能力标识列表（带 action 时 = [`capId:action`, `capId`]），
    /// 任一命中即计入。`authenticated_remote`：false 时跳过 require_auth 规则。
    fn best_match(
        &self,
        keys: &[String],
        source: SourceClass,
        authenticated_remote: bool,
    ) -> Option<CompiledRule> {
        let rules = self.rules.read().unwrap();
        let mut best: Option<(u8, CompiledRule)> = None;
        for rule in rules.iter() {
            if rule.require_auth && !authenticated_remote {
                continue;
            }
            if keys.iter().any(|k| rule.matches(k, source)) {
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
        let authenticated_remote = self.is_authenticated_remote(&req.source);
        // 候选能力标识：带 action 调用同时匹配 `capId:action` 与裸 `capId`，
        // 在同一规则表内按特异性统一仲裁；规则表顺序仍是同特异性覆盖次序。
        // 修复（2026-10-26）：旧实现「动作级命中即返回」会让内置 `cap.http*`
        // 等通配 deny 短路掉 config 的裸 id 精确 allow——ZCode 面板（移动端）
        // 经 cap.http request 被「权限拒绝」的根因。P1-h/P1-g 的动作级精确规则
        // 依赖特异性 2 > 通配 1 取胜，并表后语义不变（见 best_match 注释）。
        let keys: Vec<String> = match &req.action {
            Some(a) => vec![format!("{}:{}", req.capability.0, a), req.capability.0.clone()],
            None => vec![req.capability.0.clone()],
        };
        match self.best_match(&keys, class, authenticated_remote) {
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
            action: None,
        }
    }

    /// 携带动作的请求（P1-g/P1-h 动作级规则匹配用，与 dispatch 注入 payload.action 对齐）
    fn req_action(cap: &str, action: &str, source: Source) -> PermissionRequest {
        PermissionRequest {
            capability: CapabilityId(cap.into()),
            resource: cap.into(),
            source,
            action: Some(action.into()),
        }
    }

    fn policy_from(rules: serde_json::Value) -> PolicyPermission {
        let cfg: PermissionPolicyConfig = serde_json::from_value(rules).unwrap();
        PolicyPermission::from_config(Some(&cfg), true)
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
        // 1 条合法 config 规则 + 14 条内置（6 通配 remote deny + cap.plugin deny
        // + pluginServiceManager require_auth allow + 6 条 pluginDiscovery 只读
        // require_auth allow（P1-h）；Plugin 审批名单已全量停用（2026-10-26）——
        // 原 5+4 条 prompt 仅注释保留；ui_control=true 无条件 deny）
        assert_eq!(p.rule_count(), 15, "三条非法规则应被跳过，内置默认并入");
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
        // config 缺省（from_config(None, false)）也收紧管理面：内置默认规则生效
        let p = PolicyPermission::from_config(None, false);
        // cap.config 远程读写均放行（读是 Web/移动端刚需；写也已放开，能力内不再拒写）
        assert_eq!(
            p.check(&req("cap.config", Source::Remote { token: "t".into() })).unwrap(),
            PermissionVerdict::Allow,
            "cap.config 策略层放行（远程读写均不拒）"
        );
        assert_eq!(
            p.check(&req("cap.config.write", Source::Remote { token: "t".into() })).unwrap(),
            PermissionVerdict::Allow,
            "cap.config* 不再内置 deny"
        );
        for cap in ["cap.data_root", "cap.data_root.get_info",
                    "cap.pluginDiscovery", "cap.pluginServiceManager", "cap.plugin_foo",
                    "cap.http", "cap.ui.theme", "cap.ui.chat", "cap.self.mutate"] {
            assert_eq!(
                p.check(&req(cap, Source::Remote { token: "t".into() })).unwrap(),
                PermissionVerdict::Deny,
                "管理面 {cap} 应被内置规则拒绝（Remote）"
            );
        }
        // cap.self.inspect 是只读透视：远程 AI "看清这台机器" 是刚需，不受内置 deny 影响
        assert_eq!(
            p.check(&req("cap.self.inspect", Source::Remote { token: "t".into() })).unwrap(),
            PermissionVerdict::Allow,
            "cap.self.inspect 只读，Remote 放行"
        );
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
    fn plugin_discovery_readonly_split_for_authenticated_remote() {
        // P1-h：已鉴权 Remote（token 匹配 web.token）放行插件发现域只读动作，
        // 写动作维持拒绝。根因：cap.plugin* 通配 deny 曾把只读 discover 一并挡在
        // Remote 门外，移动端/Web 插件页列表为空、商城（polaris.marketplace
        // 经 discover 出现）入口随之消失。
        let p = PolicyPermission::from_config(None, false);
        p.set_web_token(Some("secret".into()));
        let remote = Source::Remote { token: "secret".into() };

        // 只读动作放行：动作级精确规则（特异性 2）胜过 cap.plugin* 通配 deny（特异性 1）
        for action in [
            "discover",
            "list",
            "install_locations",
            "validate_manifest",
            "adapters_list",
            "check_update",
        ] {
            assert_eq!(
                p.check(&req_action("cap.pluginDiscovery", action, remote.clone())).unwrap(),
                PermissionVerdict::Allow,
                "已鉴权 Remote 应放行只读动作 {action}"
            );
        }
        // 写动作维持 deny（安装/卸载/更新 = 文件系统变更）；discover_adapter
        // 为调试用强制刷新入口（绕缓存/熔断 + 网络调用），不放行
        for action in [
            "install_local",
            "install_package",
            "install_remote",
            "uninstall_local",
            "uninstall_with_cleanup",
            "force_uninstall",
            "apply_update",
            "discover_adapter",
        ] {
            assert_eq!(
                p.check(&req_action("cap.pluginDiscovery", action, remote.clone())).unwrap(),
                PermissionVerdict::Deny,
                "写动作 {action} 应对 Remote 维持拒绝"
            );
        }
        // bare id（无 action）回落 cap.plugin* 通配 deny
        assert_eq!(
            p.check(&req("cap.pluginDiscovery", remote.clone())).unwrap(),
            PermissionVerdict::Deny
        );
        // 未鉴权 Remote（token 不匹配）只读也不放行（X9 零回归语义不变）
        let wrong = Source::Remote { token: "other".into() };
        assert_eq!(
            p.check(&req_action("cap.pluginDiscovery", "discover", wrong)).unwrap(),
            PermissionVerdict::Deny,
            "未鉴权 Remote 不进入 require_auth 放行规则"
        );
        // Bootstrap（桌面 IPC）不受内置 Remote 规则影响
        assert_eq!(
            p.check(&req_action("cap.pluginDiscovery", "discover", Source::Bootstrap)).unwrap(),
            PermissionVerdict::Allow
        );
    }

    #[test]
    fn config_bare_allow_beats_builtin_wildcard_deny_for_action_calls() {
        // 回归（2026-10-26）：ZCode 面板（移动端）经 cap.http request 被
        // 「权限拒绝」的根因。旧实现动作级匹配命中即返回：config 的裸 id
        // 精确 allow（`cap.http`，全等）对 `cap.http:request` 不命中，而内置
        // 通配 deny `cap.http*` 命中 → 短路 deny。现在动作级与裸 id 并表仲裁，
        // config 精确 allow（特异性 2）应胜出。
        let p = policy_from(serde_json::json!({
            "rules": [
                { "capability": "cap.http", "source": "remote", "verdict": "allow" }
            ]
        }));
        let remote = Source::Remote { token: "t".into() };
        assert_eq!(
            p.check(&req_action("cap.http", "request", remote.clone())).unwrap(),
            PermissionVerdict::Allow,
            "config 裸 id allow 应覆盖内置通配 deny（带 action 调用）"
        );
        // 未被放行的相邻能力仍受内置 deny 影响
        assert_eq!(
            p.check(&req_action("cap.fs", "read", remote.clone())).unwrap(),
            PermissionVerdict::Deny
        );
        assert_eq!(
            p.check(&req_action("cap.bash", "run", remote)).unwrap(),
            PermissionVerdict::Deny
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

    #[test]
    fn ui_control_disabled_denies_plugin_ui() {
        // ui_control_enabled=false（生产默认）：Plugin 源（AI 会话）禁控 UI 域——
        // 补齐 cap_dispatch 旁路（前端挂载门只摘 polaris-bus）。
        let p = PolicyPermission::from_config(None, false);
        let plugin = Source::Plugin { caller: crate::contracts::PluginId("cap.ai".into()) };
        for cap in ["cap.ui.theme", "cap.ui.chat", "cap.ui.input", "cap.ui.render", "cap.self.mutate"] {
            assert_eq!(
                p.check(&req(cap, plugin.clone())).unwrap(),
                PermissionVerdict::Deny,
                "ui_control 关闭时 {cap} 应对 Plugin 源拒绝"
            );
        }
        // 开启后放行；Bootstrap（本机 UI）不受开关影响
        let p_on = PolicyPermission::from_config(None, true);
        assert_eq!(
            p_on.check(&req("cap.ui.theme", plugin.clone())).unwrap(),
            PermissionVerdict::Allow
        );
        assert_eq!(
            p.check(&req("cap.ui.theme", Source::Bootstrap)).unwrap(),
            PermissionVerdict::Allow
        );
        // config 精确 allow 可覆盖内置通配 deny（特异性 2 > 1）
        let p_user = policy_from(serde_json::json!({
            "rules": [
                { "capability": "cap.ui.theme", "source": "plugin", "verdict": "allow" }
            ]
        }));
        // 注意：policy_from 固定 ui_control=true，此处手工构造 false 验证覆盖语义
        let cfg: PermissionPolicyConfig = serde_json::from_value(serde_json::json!({
            "rules": [
                { "capability": "cap.ui.theme", "source": "plugin", "verdict": "allow" }
            ]
        })).unwrap();
        let p_user_off = PolicyPermission::from_config(Some(&cfg), false);
        assert_eq!(
            p_user_off.check(&req("cap.ui.theme", plugin)).unwrap(),
            PermissionVerdict::Allow,
            "config 精确 allow 覆盖 ui_control deny"
        );
    }

    #[test]
    fn high_risk_plugin_actions_default_allow() {
        // 2026-10-26：Plugin 源审批名单全量停用（名单仅注释保留）。
        // AI 会话（Plugin 源）对这些高危能力默认放行，不再逐次弹审批；
        // 需要时取消注释恢复 Prompt 语义。
        let p = PolicyPermission::from_config(None, true);
        let plugin = Source::Plugin { caller: crate::contracts::PluginId("cap.ai".into()) };
        for cap in [
            "cap.bash:run",
            "cap.http",
            "cap.http:fetch",
            "cap.data_root:set_root",
            "cap.registry:register",
            "cap.pluginServiceManager:stop_for_plugin",
            "cap.pluginServiceManager:autostart",
            "cap.pluginDiscovery:uninstall_local",
            "cap.pluginDiscovery:uninstall_with_cleanup",
            "cap.pluginDiscovery:force_uninstall",
        ] {
            assert_eq!(
                p.check(&req(cap, plugin.clone())).unwrap(),
                PermissionVerdict::Allow,
                "{cap} 对 Plugin 源应默认放行（审批名单已停用）"
            );
        }
        // 带 action 的动作请求同样默认放行
        assert_eq!(
            p.check(&req_action("cap.http", "request", plugin.clone())).unwrap(),
            PermissionVerdict::Allow,
            "cap.http:request 局部动作默认放行"
        );
        assert_eq!(
            p.check(&req_action("cap.data_root", "set_root", plugin)).unwrap(),
            PermissionVerdict::Allow,
            "cap.data_root:set_root 动作请求默认放行"
        );
        // Bootstrap（本机面板）不受影响；bash 其他动作（status/kill）也不弹审批
        assert_eq!(
            p.check(&req("cap.bash:run", Source::Bootstrap)).unwrap(),
            PermissionVerdict::Allow
        );
        assert_eq!(
            p.check(&req("cap.bash:kill", Source::Plugin { caller: crate::contracts::PluginId("cap.ai".into()) })).unwrap(),
            PermissionVerdict::Allow
        );
    }
}

# 插件可见性治理：enabledByDefault 语义重定义

> 状态：✅ 已实施（2026-09-12），Web 实测验证通过
> 日期：2026-09-12
> 来源：第四步摘旧复盘漏项 A（`dev/docs/sky/step4-migration.md` §3.1）——复盘明确
> "修法要单独开一块（影响所有插件可见性），不要夹在摘旧里做"。
> 实施结果：§4 方案 1-3 全部落地；§6 裁决落地——polaris.requirement 恢复默认启用
> （摘 deprecated）、polaris.agnes 维持默认关闭 + 废弃徽标（开关现已生效）。
> 实测：设置页开关 Agnes UI → activityBar 立即出现/消失（9827 vite 实测）；
> vitest plugin-system + pluginStore + pluginDiscovery 66 passed。
> ---
> 以下为规划原文（存档）。

## 1. 症状

插件设置页能看到插件、能勾选开关、状态能写进 state.json，
但**对 activityBar 完全无效**——开关为 true，面板仍不出现。
`polaris.todo`、`polaris.requirement`、`polaris.agnes` 三插件症状一致
（todo 已靠改声明临时绕过）。

## 2. 事实链（2026-09-12 核实）

1. **硬过滤**：`src/plugin-system/registry.ts:247` —— `listViewContributions` 第一行
   `.filter((plugin) => plugin.enabledByDefault)`。同样的硬过滤还在
   `listChatCardContributions`（`:271`）/ `listToolProviderContributions`（`:289`）/
   `listStyleContributions`（`:325`）——**四类贡献点同病，不止 views**。
2. **运行时门**：`isPluginUiEnabled`（`src/stores/pluginStore.ts:63-66`）=
   `state.enabled && state.uiEnabled`；无记录回退 `DEFAULT_PLUGIN_STATE`
   （`:50-54`，**全 true**，经 `getEffectivePluginState` `:56-61`）。
3. **两层门不等价**：第一层按静态声明硬滤，第二层按运行时 pluginStates。
   manifest `enabledByDefault: false` 的插件在任何用户设置下都不会出现；
   用户开关只写状态、不起作用。
4. **消费方**：
   - `listViewContributions`：`App.tsx:180-185`（hasLeftPanel + panelType 解析）、
     `toolSwitcherData.tsx:62-63`、`RadialMenu.tsx:66-67`、
     `plugin-system/inspector.ts:111-119`（诊断统计）。后三者各自再做 isPluginUiEnabled 过滤。
   - `isPluginUiEnabled`：App.tsx / RadialMenu / toolSwitcherData / pluginStore.test.ts。
5. **状态持久化**：开关变更 `setPluginUiEnabled`（`pluginStore.ts:167-169`）→
   `persistPluginStates` → `plugin_state_save` → 后端 PluginStateService
   （`commands/plugin_state.rs:26-31`，落 DataRoot config_dir）；zustand persist
   仅 localStorage 镜像；启动从后端 hydrate（`:121-147`）。
6. **现状清单**：15 个内置插件中仅 `polaris.agnes`（manifest.ts:16-17）与
   `polaris.requirement`（目录 `src/plugins/requirement/`，manifest.ts:9-10）
   处于 `enabledByDefault: false + deprecated: true`。

## 3. 根因与关键判断

`enabledByDefault` 身兼两职：**初始默认值** 和 **永久硬门**。语义分裂是根因——
它本该只表达"无用户记录时的默认状态"（VSCode contributes 模式：贡献默认可见，
可见性由状态门单独裁决），却成了不可逾越的注册表过滤器。

**修法方向：单一权威源。运行时唯一门 = `isPluginUiEnabled`；`enabledByDefault`
退回"初始默认值"一职。**

## 4. 方案

1. **registry**：四个 `list*Contributions` 移除 `enabledByDefault` 硬过滤，返回全部已注册贡献。
2. **pluginStore**：`getEffectivePluginState` 的无记录回退值从"恒 true"改为
   读该插件 manifest 的 `enabledByDefault`（初始默认语义落地）。
3. **deprecated 字段**：不再参与可见性判定，仅作设置页展示标记（"已弃用"徽标）；
   是否彻底删除字段待 §6 裁决后定。
4. **兼容**：已有用户 `pluginStates` 记录优先级最高，不做迁移、不覆盖。

改动量小（两文件 + 测试），但行为影响全部内置插件，必须按 §7 回归清单验收。

## 5. 影响面

| 维度 | 影响 |
|---|---|
| 代码 | `registry.ts`（4 处过滤移除）、`pluginStore.ts`（回退逻辑）、两侧单测 |
| 行为 | 修复后 agnes / requirement 默认不可见（同今天）但**开关生效**；其余 13 插件行为不变（enabledByDefault=true 且无记录→true） |
| 风险 | 低——四类贡献点的消费方本就各自做 isPluginUiEnabled 过滤，移除硬过滤后语义衔接 |

## 6. 开放裁决（需拍板，不阻塞修复本身）

1. **polaris.requirement**：有真实业务（requirementService 7 命令、RequirementPanel、
   独立 MCP server polaris-requirements）。建议：摘 `deprecated`、`enabledByDefault` 恢复
   `true`，让修复后的开关机制接管；若产品上确认弃用，则走第四步摘旧 playbook 整体下线。
2. **polaris.agnes**：用途待确认。若弃用 → 整体摘旧（含 MCP server polaris-agnes、
   agnes MCP 配置分支）；若保留 → 同 requirement 处理。
3. 修复先行、裁决随后：即使两个插件暂不裁决，本修复也应落地——
   它解决的是"开关无效"这个通用 bug。

## 7. 验收标准

1. 单测（registry + pluginStore）：
   - 无用户记录 → 可见性由 manifest `enabledByDefault` 决定；
   - 有用户记录 → 记录决定（含与默认相反的值）；
   - `enabledByDefault: false` 的插件贡献不再被 registry 丢弃。
2. 手工回归清单（每个内置插件 × 开/关/重启 三态）：
   activityBar 面板、工具切换器、径向菜单、设置页开关四处的可见性一致。
3. 第四步摘旧清单 v2 第 ③ 层（用户可见性验证）此后以本机制为准。

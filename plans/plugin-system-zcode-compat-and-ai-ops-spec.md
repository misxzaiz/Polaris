# 插件系统升级·阶段 2+ spec：ZCode 插件兼容 + cap 整合 + AI 全流程操作

> 状态：待评审
> 日期：2026-10-22
> 前置：`plans/plugin-system-upgrade-phase1-spec.md`（阶段 1 已立项，本 spec 排其后的阶段 2/3 与兼容层）
> 对照基准：`temp/ZCode`（HEAD 3c5b2276，UI_PLUGIN.md 为插件能力权威文档）、`D:\space\base\Polaris-plugin`

## 0. 假设声明（评审待确认项，因 Polaris UI 未运行无法交互确认）

1. **兼容深度 = L1 manifest 适配先行**；L2（MCP Apps 沙箱页面渲染）挂阶段 3 iframe 沙箱基建之后。
2. **AI 敏感操作走确认流**：查询/诊断/创建草稿 AI 自主；install/uninstall/update/enable/disable 弹一次性确认页（与阶段 2 权限体系的「信任根」立项一致）。
3. **本期交付物 = 本 spec**；开工从其中标注「最小切片」的项起步。

## 1. 现状事实（侦察 + 现场实证）

- `cap.pluginDiscovery` 已有 12 动作：`list / discover / install_locations / validate_manifest / install_local / install_package / install_remote / uninstall_local / uninstall_with_cleanup / force_uninstall / check_update / apply_update`（`plugin_discovery_capability.rs:14-38`）。
- `cap.pluginServiceManager` 已有 6 动作：`start / stop / restart / list_status / stop_for_plugin / autostart`。
- **缺口**：无插件状态读取/设置动作（enabled/uiEnabled/mcpEnabled 在前端 pluginStore 的 localStorage + state.json，AI/后端够不着）；无商城检索动作；无 doctor/scaffold。
- **反模式现场复现**（2026-10-22，主进程未运行时实测）：marketplace MCP `list_installed` 返回指引文字「请在 Polaris 商城面板查看已装标签」而非数据；Polaris UI 不可用期间 AI 对插件库完全失明。
- ZCode 插件形态：`.zcode-plugin/plugin.json`，`mcpServers`（stdio，`${ZCODE_PLUGIN_ROOT/PROJECT_DIR/DATA}` 变量注水）+ `ui.surfaces`（`availability: "session"`）+ 工具 `_meta.ui.resourceUri/surface/visibility` + `userConfig`（宿主管配置，服务用 `${user_config.<key>}` 引用）。**运行时与 Polaris 同构：独立 stdio Node 进程 + JSON-RPC 2.0**。Polaris 已有双布局先例（`plugin.json` / `.codex-plugin/plugin.json`，`plugin_service.rs:1136-1197`）。

## 2. ZCode 兼容层设计（L1）

### 2.1 布局识别
发现路径新增第三种布局：`<pluginRoot>/.zcode-plugin/plugin.json` → 走 ZCode 适配器翻译为 Polaris 内部 `DiscoveredPluginManifest`，其余校验/安装/更新链路零改动。

### 2.2 字段映射表（适配器实现规格）

| ZCode 字段 | Polaris 目标 | 策略 |
|---|---|---|
| `name` | `id` / `name` | `id` 缺省时用 `opts.<name>` 前缀派生防撞；原 name 保留 |
| `mcpServers` (stdio: command/args/cwd/env) | `contributes.mcpServers[]` {id, transport:"stdio", command, argsTemplate} | `args` 原样进 `argsTemplate`；`cwd`/`env` 映射到 env 注入（见 2.3） |
| `${ZCODE_PLUGIN_ROOT}` | `{{pluginDir}}` | 字符串替换，内存中翻译，不写回用户文件 |
| `${ZCODE_PROJECT_DIR}` | `{{workspacePath}}` | 同上 |
| `${ZCODE_PLUGIN_DATA}` | 数据根下插件数据目录（`data_root` 派生，非 `{{appConfigDir}}`） | 消灭 image-recognition 类配置目录分叉 |
| `${user_config.<key>}` | 插件配置（`cap.config` 按插件 id 命名空间读写） | 宿主管配置语义两家一致 |
| `userConfig`（string/number/boolean/directory/file + required/sensitive/default） | manifest 扩展字段 `compat.zcode.userConfig` 保留 + 设置页插件配置表单消费 | sensitive 值不进 AI 可见上下文 |
| `ui.surfaces[]` {id, title, server, resourceUri, availability:"session"} | `contributes.views[]` {id, area:"activityBar", panelType, labelDefault, icon} | `title.en`→`labelDefault`；`panelType`=`zc:<pluginId>:<surfaceId>` 防 panelType 撞车；**icon 白名单值填默认**并在 doctor 提示；`resourceUri` 存入 `compat.zcode.surface.resourceUri` 为 L2 预留 |
| 工具 `_meta.ui.resourceUri`（内联页面） | （L1 降级）普通工具结果卡片 | L1 不渲染沙箱页；L2 对接 chatCardRegistry |
| `_meta.ui.visibility: ["app"]` | L1 忽略 | 记 doctor 提示「L1 不支持仅页面工具交互」 |

### 2.3 兼容层验收（作者/AI 可观测）

- 打包 UI_PLUGIN.md:300-329 的最小示例插件 → `install_local` → 校验通过（B-lite zod schema 单源里加 zcode 适配用例）→ activityBar 出现 view → AI 能调到其 MCP 工具。
- `${ZCODE_PLUGIN_DATA}` 解析结果落在数据根且与面板配置写入路径一致（config 目录分叉回归用例）。
- 非 stdio transport（http/sse）→ 拒装且报「Polaris L1 仅支持 stdio」。

## 3. cap 契约扩展：AI 可调控面

### 3.1 新增动作（全部 `{action, ...}` + 阶段 1 B-lite 的 per-action 参数白名单）

**cap.pluginDiscovery 新增：**

```
status     { pluginId? | installPath? } → 聚合视图:
             manifest(id/version/origin/entrypoints) + installPath + source
             + enabled/uiEnabled/mcpEnabled  ← 读 state.json（前端 persistPluginStates 已维护，
                                                后端单源读取，不新增写路径）
             + services: PSM list_status 过滤该插件 + 服务健康/端口
             + mcp: McpClientRegistry 在线状态
doctor     { sourcePath | installPath } → B-lite zod 校验逐条错误
             （字段级：期望什么/实际什么/白名单可选值列表），L1 适配器诊断含于此
market_search { query } → index.json 检索（id/name/description/tags），
             仅读商城索引，不改动安装状态
market_versions { id } → index.json versions 数组（版本/downloadUrl@tag/sha256）
set_state  { pluginId, enabled?|uiEnabled?|mcpEnabled? } → 写 state.json
             + emit plugin.lifecycle {reason:"state_changed"}
             （唯一写路径的起点：前端对 state.json 退化为「订阅+缓存」，阶段 3 完成单轨）
scaffold_validate { sourcePath } → 对 AI 生成的插件草稿做完整校验（含 zcode L1 见 2.3）
```

**cap.pluginServiceManager**：不扩（现有 6 动作足够，`list_status` 被 `status` 动作聚合消费）。

### 3.2 动作权限矩阵（阶段 2 (id,action) 粒度化的落地实例）

| 级别 | 动作 | AI 策略 |
|---|---|---|
| 只读（AI 自主） | list / discover / install_locations / validate_manifest / status / doctor / market_search / market_versions / list_status / scaffold_validate | 直接执行 + audit |
| 会话级可逆 | set_state(uiEnabled/mcpEnabled) | 首次确认后本轮信任 + audit |
| 变更级（必确认） | install_local / install_package / install_remote / apply_update / uninstall_local / uninstall_with_cleanup / force_uninstall / set_state(enabled) / autostart(写) | 一次性确认页（动作明示：来源 URL/目标安装路径/权限请求摘要）+ 来源白名单（商城 index.json id 或 manifest origin.repository 域）+ audit |

确认流复用阶段 2 权限体系的 Prompt→UI 落叶（阶段 1 已把 `PermissionVerdict::Prompt` 从硬 Deny 解放的路径）。

## 4. AI 操作消费端：MCP 工具实化（消灭 instruction 反模式）

消费端两类，殊途同归进 `router_dispatch → cap.pluginDiscovery`：

1. **Polaris 内置 AI**（`bus_mcp_server` 白名单 `:40` 已含 plugin_discovery）。
2. **外部 coding agent**（如商城 MCP server.js 暴露的工具——本会话 agent 正是通过它操作）。

实化改造（`Polaris-plugin/plugins/marketplace/mcp/server.js`）：

| 工具 | 现状 | 实化后 |
|---|---|---|
| list_plugins / search_plugins | 读 CDN index.json（真数据） | 保持，但补 `sha256/versions` 透传 |
| list_installed | **返回指引文字（现场实证）** | 直调 `cap.pluginDiscovery status`（无参=全量聚合） |
| install_plugin | 返回 downloadUrl+instruction | 直调 `install_remote`（触发阶段 2 确认页；返回安装结果与 installPath） |
| check_plugin_update / apply_plugin_update | instruction | 直调 `check_update` / `apply_update` |
| uninstall_plugin | instruction | 直调 `uninstall_with_cleanup`（确认页） |
| **新增 doctor_plugin / plugin_skill_pack** | 无 | `scaffold_validate` 包装；插件导入 Polaris 主仓是一个独立插件包（plugins/plugin-dev）提交 |

**验收红线**：主进程未运行时，工具返回结构化错误（含 `hint`），不再是「请人工查看面板」黑箱。
**协议注意**：marketplace 工具目录描述 schema 改动后 `cargo build --bin polaris-mcp`（AGENTS 五-5，memory `polaris-mcp-schema-exe-staleness`）。

## 5. AI 全流程操作矩阵（用户目标：创建/安装/查询/管理）

| 用户意图 | AI 路径 | 权限级别 |
|---|---|---|
| 「查看插件情况」 | `status`（全量聚合：装了哪些/版本/来源/开关/服务健康/MCP 在线） | 只读 |
| 「市场里有没有 XX 类插件」 | `market_search` | 只读 |
| 「帮我写一个 XX 插件」 | polaris-plugin-dev / scaffold: 生成 plugin.json + mcp/server.js 骨架 + 面板最小源码 → `cap.fs` 落盘 → `scaffold_validate` → `cap.bash` 跑 smoke.mjs（initialize/tools/list 握手） | 落在 `<workspace>/.polaris/plugins-dev/`，只读级（dev 目录非安装目录） |
| 「装上」 | `install_local`（dev 目录→安装目录）→ 确认页 | 变更级 |
| 「升级 XX」 | `check_update` → `apply_update`（阶段 1 已前置停服+evict） | 变更级 |
| 「关掉它的可视化面板」 | `set_state(uiEnabled:false)` | 会话级可逆 |
| 「卸载 XX」 | `uninstall_with_cleanup`（阶段 1 已收敛杀进程）→ `status` 复验为空 | 变更级 |

### 5.1 scaffold/package 消费插件（阶段 2 尾、阶段 3 主体）

Polaris 主仓上架节点的「插件开发」扩展，owner：`Polaris-plugin` 仓 + 主仓 skill/expert 脚手架（如 `.agents/skills/...`），来源模板二选一：
- core 模板（Polaris 目录 + docs/plugin-development-guide.md）
- zcode-sim 模板（zcode 结构 + 模板级、护住感知的是 GLM 生成的等价文本兼容层提示）

## 6. 分阶段落地衔接（不推翻 phase 1，插队管线）

### 阶段 1（不动，已有 1.1–1.8）
唯一新增：**1.9 ZCode L1 最小适配器（~0.5 周）** —— `.zcode-plugin/{plugin.json}` 布局识别 + §2.2 映射 + 适配用例进 B-lite zod 单源（依赖 1.1 交付 schema 单源）。代码落点 `plugin_service.rs` 适配函数 + `models/plugin.rs` 的 `compat` 扩展字段（**保守：扩展字段加 `#[serde(default)]`，不动既有枚举**，协议双端同步纪律见 AGENTS 4.1）。

### 阶段 2（AI 操作层 = 本 spec 新增主体，~3 周、可与既有阶段 2 并轨）
| 序 | 事项 | 顺序依赖 |
|---|---|---|
| 2.A | `status` + `doctor` 动作（阶段 1.5/1.6 完成后） | 依赖阶段 1.1 schema、1.5 PSM 单轨起步 |
| 2.B | `set_state` + lifecycle `state_changed` reason | 依赖 2.A；**写路径先双写并行（前端 pluginStore 仍自写 + cap 写），阶段 3 单轨收口** |
| 2.C | `market_search/versions` + 商城 MCP 工具实化（§4 表） | 依赖 2.A；确认流依赖阶段 2 权限 Prompt→UI |
| 2.D | (id,action) 权限矩阵以本 spec §3.2 为首批实施对象 | 与阶段 2 权限体系统一并轨 |

### 阶段 3（兼容层深化）
- L2 MCP Apps 页面渲染：`compat.zcode.surface.resourceUri` → iframe 沙箱（对齐 ZCode pluginSandbox：CSP default-src none、固定 origin partition、HTML 16MiB 上限、ext-apps 握手），与阶段 3 已立项的「面板 iframe 沙箱」**同一基建、同一批消费**。
- `_meta.ui.resourceUri` → chatCardRegistry 的 `_meta.ui` 映射。
- `requiresHostAPI` 能力协商（ZCode `getHostCapabilities()` 对标，作者痛点遗漏项⑥）。

## 7. 验收清单（AI+作者双视角）

- [ ] 装一个 ZCode 真实插件（UI_PLUGIN.md 示例）→ activityBar 出现 view、MCP 工具被 AI 调通、`${ZCODE_PLUGIN_DATA}` 数据面/服务端读写同路径。
- [ ] 主进程未运行 → `list_installed` 返回结构化 error+hint（非人工指引黑箱）。
- [ ] 用户说「帮我写一个会议纪要插件」→ dev 目录草稿 → smoke 绿 → 确认页 → 安装 → 面板出现 → 全程 AI 主导、用户只点一次确认。
- [ ] 「查看插件情况」→ 一次调用返回聚合状态（含服务健康与 MCP 在线）。
- [ ] 关着面板（uiEnabled=false）的插件，「打开它的面板」→ `set_state(uiEnabled:true)` → 前端 lifecycleSubscriber 接 `state_changed` 刷新，ActivityBar 立现。
- [ ] 变更级动作全走确认页 + audit 链可查（PolicyPermission 白名单和 Prompt 记录）。
- [ ] `cargo build --bin polaris-mcp` 后 AI 看到的工具 schema 与 §4 一致。

## 8. 已知边界（如实）

- `status` 读 state.json 单源是**短期读路径**，前端反而自发写该文件（双写）——阶段 3 D「状态单一 owner」完成前，cap `set_state` 与前端写并存可能竞写；缓解：`set_state` + 前端订阅 `state_changed` 事件以对账刷新（session-v2 Reconcile 思路）。
- L1 不翻译 ZCode 的 PC/IDE 键绑定、`_meta.ui.visibility:["app"]` 语义；L2 落地前这类插件 doctor 会显式列出「L1 降级项」。
- Polaris 主进程未运行时本 spec 的交互型验收无法现场执行，均已转为计划内验收步骤。

## 9. 与两仓现有纪律的衔接

- AGENTS 3.2：AI 操作全部落 `services/router/`（不新增 `commands/`）。
- AGENTS 4.1：`compat` 扩展字段 = Rust 类型 + 前端类型（`src/types/?` + `pluginDiscoveryService.ts` normalize）双端同步 + zod 单源校验兜底。
- AGENTS 5：`cap.pluginDiscovery` 新动作若改动白名单/bus_mcp_server schema → 同步 `cargo build --bin polaris-mcp`。
- 阶段 1/2 每项开工前照例 `plans/` 内逐项补任务 spec（或以本 spec §5-6 为任务卡的 target spec，评审时合并处理）。

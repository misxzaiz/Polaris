# PRD 预览外移实施规划书（含可复用插件化手册）

> **修订 2026-11-07**：本项已升级为「交互组件」泛化方案——插件落 **Polaris-plugin 仓**（原 §4.1 主仓 plugins/ 目录路径作废，本地冒烟改 zip 安装），命名与表单整合见 `interactive-component-plugin-plan.md`。本文件保留价值：§3 宿主 artifact 桥、§5 主仓移除清单、§6 八步手册、§8 防膨胀规则仍为现行有效版本。

> 状态：**规划，未实施** · 日期：2026-11-06
> 来源：用户定案——按交互演示面板的方案，把主仓内置 PRD 预览 MCP 插件外移到 `D:\space\base\Polaris\plugins` 本地插件目录，随后移除主仓实现；产出**可复用实施手册**，供后续其余 11 个内置壳（Agnes / Computer / PersonalHub / Requirement…）复制。
> 上游：`host-slimming-incremental-roadmap.md`（W3 首项）、`host-slimdown-plugin-contracts-plan.md`、core-slimdown 总纲 B1-1。
> 配套演示：对话内交互面板（架构对比 / 迁移四步 / 文件去向），本文件是它的书面版 + 机制实证。

---

## 1. 目标与非目标

**目标**
1. PRD 预览以独立插件形态运行：源码放 `D:\space\base\Polaris\plugins\prd-preview\`，经 dev-link 接入宿主。
2. 主仓移除全部 PRD 专属实现（净删 ~957 行 + 6 处注册点）。
3. 沉淀《八步外移手册》（§6），后续插件照抄。

**非目标**
- 不改任何行为：3 个工具签名、落盘格式、卡片 UI 逐字段等价。
- 不动通用核心：`ArtifactPreviewRenderer` / `artifactVersions` / chatCards 契约留在主仓（多插件共用）。
- 不做面板（PRD 插件无 panel，只有 MCP + chatCard，是七个壳里唯一无面板的——这也是它最适合首例的原因）。

---

## 2. 机制实证（实施前必须知道的四个事实）

实施可行性由这四条机制决定，全部已核实源码：

| # | 事实 | 出处 | 对方案的影响 |
|---|---|---|---|
| F1 | 插件发现只扫两个根：`<appConfigDir>/plugins`（User）与 `<workspace>/.polaris/plugins`（Project）。**仓库根 `plugins/` 不是扫描路径** | `plugin_service.rs:408-447` | 放在 `D:\space\base\Polaris\plugins` 的插件须经 **dev-link** 接入（F2），不能只靠目录就位 |
| F2 | dev-link 官方通道：`dev_link_plugin(appConfigDir, sourcePath)` 校验 plugin.json → 写 state.json `<id>.devLink` → 发现时回读盖戳，installPath = 源码目录 | `plugin_service.rs:573` | 源码目录即安装目录：改即生效；MCP `{{pluginDir}}` 与卡片 `card.entry` 都解析到它 |
| F3 | 插件模块加载器**只重写 `react`/`react/jsx-runtime`** 为宿主 shim；其余裸导入（`clsx`、`@/stores/...`）不解析，bundle 必须自包含 | `pluginModuleLoader.ts:44-64` | 现卡片 import 了宿主内部组件（见 F4），不能原样打包——需 §3 的宿主桥 |
| F4 | 现卡片 6 个 import 中 3 个是宿主内部：`ArtifactPreviewRenderer`、`artifactVersions`、`useFileEditorStore`+`getFileContent` | `PrdPreviewCard.tsx:19-26` | 直接搬会挂——由 §3 宿主 artifact 桥解决，桥一次多插件受益 |
| F5 | 现为 **trusted 免检**注册（跳过 aiToolAccess）；外移后走插件门控 | `mcp_config_service.rs:578,891` | 安全增强，同时回归验证时注意插件需启用 + aiToolAccess 声明 |

---

## 3. 前置工作 P1：宿主 artifact 渲染桥（通用地基，~0.5 会话）

**问题**：卡片 bundle 自包含（F3）与复用宿主渲染核心（F4）矛盾。复制 ~600 行渲染核心进插件 = 通用核心分叉，违背瘦身初衷。

**方案**：仿照 react shim 惯例，在宿主加第二个模块 shim——`window.__POLARIS_HOST_ARTIFACT__`：
- 内容：`ArtifactPreviewRenderer`、`buildArtifactBlockFromData`、`useArtifactVersions`、源码查看动作（`useFileEditorStore` + `getFileContent` 的封装）
- 注册：App 启动时挂 window（对齐 `__POLARIS_HOST_REACT__` 现行做法）；`pluginModuleLoader.ensureArtifactShim()` 生成 blob shim 供卡片 import
- 插件卡片侧：`import { ArtifactPreviewRenderer } from '<shim blob url>'`（由加载器重写，插件源码里写 `from 'polaris-host/artifact'` 占位符，加载器统一替换——与 react 重写同机制）
- **多插件受益**：Agnes（图片/视频预览卡）、未来任何 artifact 类插件都用同一桥

验收：shim 存在性单测 + 现有内置卡片改走 shim 后渲染回归（这正是 P1 先行的原因——先在受控的内置形态上验证桥，再外移）。

---

## 4. PRD 预览插件实施（~1.5 会话）

### 4.1 目录结构（落 `D:\space\base\Polaris\plugins\prd-preview\`）

```
prd-preview/
├── plugin.json            # 完整 manifest（§4.2）
├── mcp/
│   └── server.js          # Rust 557 行的 Node 零依赖等价重写（§4.3）
├── dist/
│   └── card.js            # 卡片 bundle（react 由宿主 shim，artifact 由 §3 桥）
├── src/                   # card 源码 + 打包脚本（esbuild，对齐插件仓惯例）
├── test/                  # 迁移 PrdPreviewCard.test.tsx + server 行为测试
└── update.json            # v1.0.0
```

### 4.2 plugin.json 要点

```jsonc
{
  "id": "prd-preview",
  "name": "PRD 预览",
  "version": "1.0.0",
  "enabledByDefault": true,
  "contributes": {
    "mcpServers": [{
      "id": "polaris-prd-preview",          // 与现 server 名一致 → 既有对话工具引用不断链
      "transport": "stdio",
      "command": "node",
      "argsTemplate": ["{{pluginDir}}/mcp/server.js", "{{appConfigDir}}", "{{workspacePath}}"]
    }],
    "chatCards": [{
      "id": "preview-card",
      "mcpServerId": "polaris-prd-preview",  // 必须属于本插件声明（registry 校验）
      "tools": ["preview_html", "read_preview"],
      "mode": "result",
      "entry": "./dist/card.js"              // 内置壳没有的，本插件必须有
    }]
  },
  "permissions": { "workspaceRead": true, "workspaceWrite": true, "aiToolAccess": true }
}
```

注意：`appConfigDir/workspacePath` 参数语义以 Rust 版 `argsTemplate` 实际接收为准，重写前先跑一次现 server 抓真实 argv。

### 4.3 server.js 行为等价清单（以 Rust 实现为金标逐条对齐）

| 行为 | 金标（prd_preview_mcp_server.rs） |
|---|---|
| 落盘路径 | 工作区 `.polaris/previews/<previewId>/index.html` + metadata |
| 版本语义 | 同 requirementId 时 version 递增、versionLabel 自动 v1/v2… |
| 上限 | MAX_HTML_BYTES = 2MB，超限报错语义一致 |
| 返回 marker | `artifact_type: polaris.preview` + camelCase 全字段（PreviewArtifact 结构逐字段比对） |
| stdio 协议 | MCP JSON-RPC（initialize / tools_list / tools_call），与宿主 stdio 客户端协商一致 |

测试：迁移 Rust 侧单测用例（`exposes_expected_tools` 等）到 Node 侧等价断言；真宿主冒烟走 dev-link。

---

## 5. 主仓移除清单（~0.5 会话，单独 commit）

| 位置 | 动作 |
|---|---|
| `src-tauri/src/services/prd_preview_mcp_server.rs`（557 行） | 删除 |
| `src-tauri/src/services/mod.rs:36` | 删 `pub mod` 声明 |
| `mcp_config_service.rs`（常量 :13/:23、builtin 注册 :578、capability 映射 :891） | 摘除 |
| `src/plugins/prd-preview/`（manifest 35 + card 209 + test 156） | 删除 |
| `builtinPlugins.ts`（:11 import、:134 register、:169-178 chatCard 懒加载） | 摘除 |

门槛命令（AGENTS.md §七）：`pnpm typecheck` + `pnpm exec eslint <改动文件>` + `cargo check` +
`cargo check --no-default-features --bin polaris-web --bin polaris-mcp`；
`grep -rn "prd_preview\|prd-preview" src src-tauri/src` 残留为零（`ArtifactPreviewRenderer` 的通用 artifact 引用除外）。
无 MCP schema 变更 → 不触发 `cargo build --bin polaris-mcp` 纪律（server 移交插件进程）。

---

## 6. 八步外移手册（复用模板，后续插件照抄）

1. **画边界**：列出该功能全部文件/注册点/宿主内部依赖（import `@/` 扫描），标出「通用核心 vs 功能专属」。
2. **找缺口**：逐条对照 F1-F5 机制——发现路径（dev-link？）、加载器边界（bundle 依赖什么宿主内部？）、
   trusted→门控差异、存储位置（DataRoot 插件命名空间）。缺通用桥就先立项（如 §3 artifact 桥），不抄近道。
3. **冻结金标**：把现实现的行为（工具 schema、数据格式、阈值、错误语义）写成等价清单，外移期间是唯一验收依据。
4. **插件仓/本地目录实现**：先在测试市场冒烟（`plugin-creator` 流程），dev-link 真宿主复验。
5. **影子并行**：插件启用 + 主仓实现共存跑一轮（server 名不同避冲突），功能等价对照。
6. **主仓删码**：单主题 commit，门槛命令全绿 + 残留 grep 为零 + 注册表摘除（builtinPlugins / mcp_config_service / mod.rs）。
7. **三处同步**：主仓文档、插件仓 update.json/商城、AGENTS.md §五（如涉及 cap）。
8. **行数对账**：实测 vs 预估 ±20%，更新瘦身路线基线表，勾销总纲批次项。

反模式（手册明令禁止）：同 window 直调宿主内部绕过加载器边界；复制宿主核心组件进插件 bundle；
删除主仓代码前未做影子并行；一次外移多项混批。

---

## 7. 验收与回滚

- **验收**：真宿主 dev-link 冒烟——AI 对话调 `preview_html` 出卡片、版本递增、read/list 正常、
  既有 `.polaris/previews` 产物可读；禁用插件 → 工具消失（门控生效）；双端（桌面 + Web）。
- **回滚**：dev-link 卸载不删源码（`uninstall_dev_link_plugin`）；主仓删除单 commit 可 revert；
  插件仓保留前一版 zip。
- **风险登记**：① 卡片 hydration 双形态（直出 html / 缺 html 回读落盘）在新加载链路的行为需真机验证；
  ② trusted→门控后，若用户禁用插件，历史对话中旧卡片渲染依赖 dist/card.js 仍在安装目录（dev-link 源码即目录，天然满足）。

---

## 8. 契约成本核算与防膨胀规则（回答「会不会为兼容插件引入更多代码」）

**会新增，但账是净减，且要靠规则守住净减。** 以本项为例：删 977（功能实现）+ 增 ~180（artifact 桥），
第一插件净删 ~780；桥为 N 个 artifact 类插件共用，边际成本趋零（量级参照：react shim 基建现值 215 行）。
被删的是持续演改的实现，新增的是立项一次即冻结的契约——两种代码维护负载不同量级。

**四条防膨胀规则（每个外移项立项时逐条过）：**

1. **桥只收通用核心**：桥内代码必须是立项前就已服务多个调用方的（ArtifactPreviewRenderer 本就服务
   全部 artifact 类卡片）；禁止为单个插件的需求往桥里加专属逻辑——那是换了个地方塞功能。
2. **受益者门槛**：一座桥预期服务插件 < 2 个就不立项，改插件自包含或功能留核心。桥的总量有预算意识：
   react shim(215) + artifact 桥(~180) + 至多再 2~3 座封顶；持续增长即信号——在往主仓回塞功能。
3. **禁垫层 + 影子并行设终点**：主仓删除不留向后兼容 shim（总纲 §9 既有纪律）；影子并行只允许存活到
   删码 commit，不允许长期双轨。
4. **对账单列桥成本**：每波行数对账时，「新增契约行数」单列一栏，净删数 = 删除数 − 桥新增数，如实报
   总账；基线表（roadmap §4）追踪主仓契约面总量，防止趋势性回涨。

**已评估并否决的「零桥」替代路线**：宿主把 plugin_card→artifact 归一化做成通用路由匹配（归一化逻辑
本就在宿主 `artifactVersions.tsx:46-76`），插件可免带 card.js。否决理由：每新增一种 artifact 插件都要
改一次宿主路由，把耦合藏进更贵的地方——明面上的桥 + plugin.json 声明才是匹配权的正确归属。

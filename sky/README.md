# Sky — Capability OS

> Polaris 架构契约的 Node + TypeScript 实现。无头 Core（HTTP/WS 常驻服务）+ 浏览器即 Shell。
> **对话即全功能**：AI 对话是唯一常驻界面，其余一切（页面/面板/可视化）由 AI 现场渲染——桌面悬浮窗、手机底部抽屉、对话内卡片。

## 设计基线（AI-first 交互原型，2026-10）

1. **对话即应用**：内置 UI 只保留 消息流 + 输入区 + 会话抽屉 + 极简设置 sheet。没有传统导航/面板——需要什么界面，对 AI 说，它用 `cap.ui.window` / `cap.ui.component` 现场渲染。
2. **一切能力通过 cap 注册**：所有能力都是 `Capability` 接口的实现，走统一 `dispatch(capId, params, ctx)` 唯一入口；before/after 拦截器链（permission → audit）可插拔。
3. **AI 可操作所有 cap**：注册的 cap 自动暴露为 AI 工具（OpenAI function-calling），工具列表每轮刷新。系统提示注入能力 OS 行为契约（渲染界面、编辑文件、自写插件）。
4. **AI 渲染的 UI 可交互**：`cap.ui.window`（桌面悬浮窗：拖拽/最小化/托盘恢复；≤640px 自动变手机底部抽屉）；`cap.ui.component`（mountPoint: "inline"）渲染进对话流。js 在 `__sky = {dispatch, close, toast}` 受限沙箱执行，CSS 自动作用域。
5. **手机优先**：断点 640px；软键盘 visualViewport 适配；WS 断线指数退避重连 + 心跳 + 重连后自动恢复会话；PWA 可安装（manifest + service worker）。
6. **认证**：token 签发/吊销（SHA-256 存储）+ 服务端强制校验（HTTP 401 / WS upgrade 拒绝）+ 密钥脱敏（见下文「认证」）。

## 启动

```bash
cd sky
npm install        # 8 个包，秒装（无原生依赖；better-sqlite3 换成了 node:sqlite）
npm start          # tsx src/main.ts，冷启 <2s
```

访问 `http://localhost:9825`。数据根目录：`%APPDATA%/Polaris-sky/`（Linux `~/.local/share/Polaris-sky/`），env `POLARIS_SKY_DATA_ROOT` 可覆盖。

生产环境建议：

```bash
# 配置强制认证后再对外暴露（见「认证」）
npm run build 2>/dev/null || npx tsc --noEmit   # 类型检查
node node_modules/tsx/dist/cli.mjs src/main.ts   # 前台运行
```

## 认证（生产红线）

默认**本地开发模式**：无 master token 且未开启强制认证，本机访问免认证（无 token 的 remote 视为 admin，便于从 UI 签发第一批 token）。

对外部署时开启强制认证：

```json
// cap.config patch
{ "server": { "token": "sk-<你的主token>", "authRequired": true } }
```

开启后：

- 除 `/api/health`、`/api/auth/verify`、Shell 静态页外，所有 HTTP 请求需 `Authorization: Bearer sk-...`（401 拒绝）
- WS 在 HTTP upgrade 阶段拒绝未认证连接
- 浏览器首次访问弹出登录层，验证通过后 token 存 localStorage

token 管理（Web Shell → 设置 → 安全，或直接 dispatch）：

| 动作 | 说明 |
|---|---|
| `cap.auth issue {name, role?, expiresDays?}` | 签发 `sk-<48hex>`，**原文仅返回一次**，库存 SHA-256 + 8 位前缀 |
| `cap.auth list` | 列表（前缀/角色/最近使用/过期），需 admin |
| `cap.auth revoke {id}` | 吊销，立即生效，需 admin |
| `cap.auth verify` | 校验当前 token |

角色：`admin` 可管理 token；`user` 仅可调用能力。`server.token`（主 token）不入库，恒为 admin。

**密钥脱敏**：`cap.config get` 对非 admin 的 remote 来源把 `apiKey/token/secret/password` 类字段遮蔽为 `••••••`；set/patch 收到遮蔽值时自动保留库中真实值（整表保存不会误清密钥）。

## 能力清单（31 个）

| 层 | Cap | 说明 |
|---|---|---|
| 基础 | `cap.echo` | Demo，原样返回 |
| | `cap.kv` | SQLite 持久化 KV，domain 隔离 |
| | `cap.bash` | Shell 任务 run/status/log/wait/kill（后台任务） |
| | `cap.config` | 配置读写（密钥脱敏） |
| | `cap.history` | 会话历史 JSONL |
| | `cap.audit` | 审计/事件流（每次 dispatch 自动落库） |
| | `cap.fs` | 文件系统（DataRoot 沙箱；plugins/ 前缀重定向到 cap.capability） |
| | `cap.http` | HTTP 客户端 |
| | `cap.task` | 任务管理（复用 bash 任务池） |
| | `cap.time` | 时间工具 |
| 编辑 | `cap.edit` | **工作区文件编辑**：read（行号）/replace（精确唯一匹配）/insert/deleteLines/undo（快照）/search（内容搜索）——AI 编辑代码的核心工具 |
| AI | `cap.ai.chat` | 流式对话 + 工具调用循环（无轮数上限，工具列表每轮刷新） |
| 元 | `cap.interceptor` | 拦截器管理 |
| | `cap.capability` | 插件脚手架 scaffold/write/read/files（内嵌契约铁律模板） |
| | `cap.plugin` | 插件 install/uninstall/reload/available |
| | `cap.transport` | 传输适配 |
| | `cap.shell` | Shell 信息 |
| | `cap.engine` | 引擎信息 |
| | `cap.storage` | 存储后端信息/维护 |
| | `cap.bus` | 事件总线 |
| | `cap.auth` | token 签发/列表/吊销/校验 |
| UI | `cap.ui.style` / `cap.ui.theme` / `cap.ui.layout` | 样式/主题/布局热更新（CSS 变量） |
| | `cap.ui.component` | 注入可交互组件（js 执行 + CSS 作用域 + 热更新） |
| | `cap.ui.snapshot` / `cap.ui.observe` / `cap.ui.chat` | UI 快照/反向观察/AI 改 UI |
| 插件 | `cap.session` | 会话管理（计数/切换/排序） |
| | `cap.workspace` | 多工作区（任意绝对路径，node:fs 只读树，深度≤2） |
| | `cap.shell.info` | 平台信息示例插件 |

## AI 编辑代码工作流（cap.edit）

```
cap.edit search {query: "FIXME"}          → 定位
cap.edit read   {path, offsetLine, limitLines} → 行号上下文
cap.edit replace {path, old: "...", new: "..."}  → 精确唯一替换, 返回修改点 snippet
cap.edit read   {...}                     → 验证 (或 undo 撤销)
```

`replace` 默认要求 old 在文件中**唯一匹配**——多处匹配会拒绝并列出计数，引导 AI 补充上下文；`all: true` 显式全替换。每次修改前快照，`undo` 每文件 5 层。

## 插件

`plugins/` 下每个子目录含 `manifest.json` + `index.ts`，启动自动加载。AI 自写插件的标准流程：

```
cap.capability scaffold {name, capId}   → 生成 manifest + index.ts（内嵌契约模板）
cap.capability write    {name, file, content} → 改写（自动语法校验，缺 manifest 自动补齐）
cap.plugin install      {path: "./<name>"}    → 装载注册
→ 新 cap 立即可调用（AI 工具列表每轮刷新）
```

注意：插件文件读写必须走 `cap.capability`（写项目 `plugins/`），`cap.fs` 会拦截 `plugins/` 前缀并提示重定向——两套根目录不混用。

## HTTP API

```
GET  /api/health         — 健康检查（含 authRequired/authed）
GET  /api/auth/verify    — 校验 Bearer token
GET  /api/caps           — 列出所有能力
GET  /api/config         — 读配置（密钥脱敏）
POST /api/config         — 写配置（patch）
GET  /api/ui-state       — UI State 初始同步
POST /api/dispatch       — { cap, params, stream? } → Reply
GET  /                   — Web Shell
WS   /ws?token=          — { type:'dispatch'|'shell-register'|... } / 事件推送
```

## 测试

```bash
node scripts/auth-e2e.mjs      # 认证 38 项（自动重启 Core 切换 dev/强制模式）
node scripts/edit-e2e.mjs      # cap.edit 31 项（临时工作区全动作）
node scripts/edit-ai-e2e.mjs   # 真实 AI × cap.edit 验收（search→read→replace 修 bug）
```

前置：Core 运行中（`npm start`），AI 代理可用（后两个脚本之一）。

## 目录结构

```
sky/
├─ src/
│  ├─ contracts.ts          — 契约层（Capability/Source/Envelope/CallContext）
│  ├─ storage.ts            — node:sqlite + DataRoot
│  ├─ main.ts               — 入口（注册 cap + 拦截器 + 启动 server）
│  ├─ caps/                 — 业务 cap（echo/kv/bash/config/edit/auth/ai...）
│  │  ├─ ui/                — UI cap（style/theme/layout/component/observe...）
│  ├─ interceptors/         — permission（权限+认证 gate）/ audit
│  ├─ server/
│  │  ├─ router.ts          — 唯一入口 dispatch + 拦截器链
│  │  ├─ http.ts            — HTTP + WS（认证强制）
│  │  ├─ auth.ts            — 认证状态（master token / 已签发校验）
│  │  └─ plugin-loader.ts   — plugins/ 扫描装载
│  └─ web/shell.ts          — Web Shell（单文件模板，无构建）
├─ plugins/                 — session / workspace / shell-helper
└─ scripts/                 — e2e 测试（auth/edit/edit-ai）
```

## 已知边界

- 单进程：外部插件同进程 import（非进程隔离）；插件崩溃影响 Core
- `cap.edit`/`cap.workspace` 的信任边界是用户显式设置的工作区 root——对多用户部署，应给 user 角色限制工作区设置权限（当前 permission 拦截器支持 `remoteAllow` 白名单裁剪）
- `cap.edit` 的 undo 快照在进程内存（Core 重启后丢失）
- 审计记录无自动轮转（长期运行需定期 `cap.audit clear`）
- Windows 下 Core 无服务化封装（NSSM/计划任务/PM2 均可托管）

# Sky — Capability OS Preview

> 基于 Polaris 架构契约的简化预览版。Node + TypeScript 直跑，零编译。
> 一切能力通过 cap 注册，AI 通过工具调用操作所有 cap。

## 设计基线

1. **无头 Core + Web Shell**：Core 是 HTTP/WS 服务进程，浏览器即 Shell。无 Tauri/Electron 桌面壳依赖。
2. **一切能力通过 cap 注册**：echo/kv/bash/config/history/ai.chat 都是 `Capability` 接口的实现，走统一 `dispatch(capId, params, ctx)`。
3. **AI 可操作所有 cap**：所有注册的 cap 自动暴露为 AI 工具（OpenAI function-calling 协议），AI 流式 + 工具调用循环。
4. **权限 gate**：`Source` 由传输层注入（Remote/Bootstrap/Plugin），`PermissionPolicy` 在 dispatch 唯一入口校验。
5. **插件自动扫描**：`plugins/` 目录下每个子目录含 `manifest.json` + `index.ts`，启动时自动加载注册。

## 启动

```bash
cd sky
npm install        # 8 个包，秒装（无原生依赖）
npm start          # tsx src/main.ts，冷启 <2s
```

访问 `http://localhost:9825`。

## 能力清单（11 内置 + 1 插件示例）

| Cap | 说明 | 流式 |
|---|---|---|
| `cap.echo` | Demo，原样返回 | 否 |
| `cap.kv` | SQLite 持久化 KV，set/get/delete/list，domain 隔离 | 否 |
| `cap.bash` | Shell 任务，run/status/log/wait/kill，默认异步后台任务 | 否 |
| `cap.config` | 配置读写，get/set/patch，存于 cap.kv(domain=config) | 否 |
| `cap.history` | 会话历史 JSONL，append/list/get/clear/sessions | 否 |
| `cap.audit` | 审计/事件流，list/get/byTrace/byCap/recent/stats/clear | 否 |
| `cap.fs` | 文件系统（DataRoot 沙箱），read/write/append/list/stat/mkdir/delete/rename | 否 |
| `cap.http` | HTTP 客户端，get/post/put/patch/delete/head | 否 |
| `cap.task` | 任务管理（复用 bash 任务），list/get/kill/wait/clear | 否 |
| `cap.time` | 时间工具，now/format/sleep/timestamp | 否 |
| `cap.ai.chat` | AI 对话，流式 + 工具调用，所有 cap 自动暴露为工具 | **是** |
| `cap.shell.info` | 插件示例，返回平台/Node 信息 | 否 |

## 事件流 / 审计

每次 dispatch 自动产生审计记录，经 `cap.audit` 持久化到 SQLite（`audit` 表），含：
- `trace` / `msgId` — 全链路追溯
- `cap` / `source` — 调用目标与来源
- `params` / `result` — 请求与响应内容
- `durationMs` — 耗时
- `kind` — allow/deny/allow-error/prompt-deny/stream-start/stream-error
- `ts` — 时间戳

审计记录同时推送 `audit.event` 事件到 EventBus，前端可实时观察。`cap.audit` 自身的查询不被审计（避免循环）。

AI 可通过 `cap.audit` 查询历史请求：
```
cap.audit { action: "byCap", cap: "cap.bash", limit: 10 }  // 查 bash 调用历史
cap.audit { action: "byTrace", trace: "trace-xxx" }        // 按链路追溯
cap.audit { action: "recent", since: 1696000000000 }      // 增量拉取
cap.audit { action: "stats" }                               // 统计
```

## HTTP API

```
GET  /api/health        — 健康检查
GET  /api/caps          — 列出所有能力（供 AI/前端发现）
GET  /api/config        — 读配置
POST /api/config        — 写配置（patch）
POST /api/dispatch      — { cap, params, stream? } → Reply
GET  /                   — Web Shell
WS   /ws                — { type:'dispatch', cap, params, stream? } / { type:'event', event }
```

## AI 工具调用闭环

```
用户消息
  → cap.ai.chat dispatch_stream → streamId
  → AI 流式 chunk (stream.chunk)
  → AI 请求工具 (stream.tool)
  → Router.dispatch(工具 cap) → 执行 → 结果 (stream.toolResult)
  → AI 看到结果继续生成
  → 最终文本 → stream.end
```

AI 默认可调用全部已注册 cap（`cap.ai.chat` 自身除外）。可通过 `params.tools: ["cap.echo"]` 限制。

## 配置

Web Shell 右侧面板填 Base URL / API Key / Model（OpenAI 兼容协议）。配置存于：
- Win: `%APPDATA%/Polaris-sky/sky.db` (kv) + `history/` (JSONL)
- Linux: `~/.local/share/Polaris-sky/`
- env `POLARIS_SKY_DATA_ROOT` 覆盖

## 目录结构

```
sky/
├─ src/
│  ├─ contracts.ts        — 契约层（Capability/Source/Envelope/CallContext/PermissionPolicy）
│  ├─ storage.ts          — node:sqlite + DataRoot
│  ├─ main.ts             — 入口（注册 cap + 启动 server）
│  ├─ caps/
│  │  ├─ echo.ts kv.ts bash.ts config.ts history.ts ai.ts
│  ├─ server/
│  │  ├─ router.ts        — Router（注册表 + dispatch + 权限 gate + 审计）
│  │  ├─ eventbus.ts      — 事件广播
│  │  ├─ http.ts          — HTTP + WS server
│  │  ├─ plugin-loader.ts — 自动扫描 plugins/
│  └─ web/
│     └─ shell.ts         — Web Shell HTML（内嵌）
├─ plugins/
│  └─ shell-helper/       — 示例插件
└─ scripts/
   └─ ai-stream-test.ts   — AI 流式 + 工具调用闭环验证
```

## 验证状态

- typecheck：0 错误
- echo/kv/bash/config/history：HTTP 实测全绿
- 插件加载：shell-helper 自动注册 cap.shell.info
- 权限 gate：cap.shell.info 被 Remote deny（白名单未列入）——权限设计有效
- AI 流式 + 工具调用闭环：mock SSE 双轮验证 PASS

## 与 Polaris 的关系

契约层对齐 Polaris `src-tauri/src/contracts/mod.rs`（7 trait 冻结版）。预览版用 Node 直跑验证架构闭环，发行版可切 Rust 重写 Core——契约层（JSON 类型 + Capability 接口）可直接移植。

## 已知限制（预览版）

- 单进程（外部插件同进程 import，非进程隔离）
- 无 token 鉴权（本地开发宽松，remoteAllow 全放行）
- 审计走 console（发行版接 AuditSink 文件/SQLite）
- 无 WASM 组件加载（Phase 2）

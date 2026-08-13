# DSH 引擎插件 — Polaris × DeepSeek Harness 集成验证

## 目录

1. [功能兼容矩阵](#1-功能兼容矩阵)
2. [快速验证](#2-快速验证)
3. [安装方式](#3-安装方式)
4. [架构说明](#4-架构说明)
5. [验证流程](#5-验证流程)
6. [已知限制与风险](#6-已知限制与风险)

---

## 1. 功能兼容矩阵

### 1.1 引擎适配器（engine-v1 协议）

| 功能 | headless 驱动 | webapi 驱动 | 备注 |
|------|:-:|:-:|------|
| 基础聊天（一问一答） | ✅ | ✅ | |
| 流式输出（逐 token） | ❌ | 🔶 | headless 只在完成后输出全文；webapi 需确认 SSE 端点 |
| 工具调用帧（tool_call_start/end） | ❌ | 🔶 | headless 不暴露内部事件；webapi 需从轨迹事件解析 |
| 多轮对话（会话续接） | ✅ | ✅ | headless 通过重放 history 模拟；webapi 原生支持 |
| 中断回答 | ✅ | ✅ | kill 子进程 / HTTP 中断 |
| 错误报告 | ✅ | ✅ | |
| 使用量统计（usage） | ❌ | 🔶 | headless 无此信息 |
| 引擎状态报告 | ✅ | ✅ | is_available 通过 `dsh --version` 检测 |
| 模型选择传递 | ✅ | ✅ | 通过 DSH_DEFAULT_MODEL env 传递 |
| 环境变量覆盖 | ✅ | ✅ | env_overrides 透传 |
| 工作目录 | ✅ | ✅ | cwd 设置 |
| 系统提示词 | ✅ | ✅ | 拼入 headless task prompt |
| MCP 工具注入 | ❌ | 🔶 | headless 无 MCP 通道；webapi 可通过 DSH MCP client 配置 |

### 1.2 DSH 完整功能支持（通过 Panel 嵌入式 Web UI）

| 功能 | 支持 | 说明 |
|------|:----:|------|
| DSH 会话管理 | ✅ | 原生 Web UI |
| 工具链（bash/pwsh/fs） | ✅ | 原生 |
| 子代理（subagent） | ✅ | 原生 |
| 工作流（workflow） | ✅ | 原生 |
| 目标（goal） | ✅ | 原生 |
| 技能（skill） | ✅ | 原生 |
| 任务（jobs） | ✅ | 原生 |
| 用户审批（ask-user） | ✅ | 原生 |
| MCP 客户端 | ✅ | 原生 |
| 客户端插件（HMR） | ✅ | 原生 |
| 模型选择 | ✅ | 原生 |
| 凭据管理 | ✅ | 原生 |
| 工作区管理 | ✅ | 原生 |
| 会话历史导出 | ✅ | 原生 |
| 多语言 | ✅ | 原生 |

### 1.3 Polaris 集成点

| 集成点 | 状态 | 说明 |
|--------|:----:|------|
| 引擎选择器（引擎切换） | ✅ | 注册为 `deepseek-dsh` 引擎 |
| 引擎设置页（一键安装/卸载） | ✅ | npmPackage 字段 |
| Chat 消息 | ✅ | 通过 engine-v1 适配器 |
| 活动栏面板 | ✅ | 「DSH 工作区」面板 |
| 后台服务托管 | ✅ | dsh-web 服务 autoStart/Restart |
| 文件互操作 | ❌ | 适配器不直接提供文件访问；Web UI 内有 |
| 审批卡片 | 🔶 | 需 chatCard 映射（待实现） |
| MCP 桥接 | 🔶 | 需双向配置（待验证） |

---

## 2. 快速验证

### 2.1 前置条件

```bash
# 1. 安装 dsh
npm install -g @deepseek-ai/dsh

# 2. 验证安装
dsh --version
# 输出: 0.1.0-rc.6

# 3. 首次启动配置 LLM 凭据
dsh --profile headless "你好"
# 首次运行会引导配置 API Key
```

### 2.2 烟测试（适配器协议验证）

```bash
# 进入插件目录
cd plugins/dsh-engine

# 运行烟测试（headless 模式，需要 LLM 凭据）
node smoke.mjs

# 带调试日志
DSH_ADAPTER_DEBUG=1 node smoke.mjs

# 指定模型
DSH_DEFAULT_MODEL=deepseek-chat node smoke.mjs
```

预期输出：
```
ℹ️ DSH 引擎适配器烟测试
==================================================
  驱动模式: headless (default)
  ... 

ℹ️ 1. 启动适配器进程...
  ✅ 适配器进程已启动，未退出

ℹ️ 2. 发送 start_session 请求...
  [event] assistant_message: 你好！很高兴认识你！...
  [event] session_end: completed
  [result] id=1: session_id=dsh-xxxx
  ✅ 收到 assistant_message 事件
  ✅ 收到 session_end 事件
  ✅ 收到 start_session 结果帧

ℹ️ 3. 发送 continue_session 请求...
  ✅ 续接后收到新事件
  ✅ 收到 continue_session 结果帧

ℹ️ 4. 发送 interrupt 请求...
  ✅ 收到 interrupt 结果帧

==================================================
测试结果: 8 通过, 0 失败
```

### 2.3 API 探测（webapi 驱动验证）

```bash
# 1. 启动 dsh web（新终端）
dsh --profile web

# 2. 运行探测脚本
cd plugins/dsh-engine
node probe-api.mjs --port 3080

# 3.（可选）将结果传给适配器
cp dsh-api-probe-result.json /tmp/
DSH_DRIVER=webapi node smoke.mjs
```

---

## 3. 安装方式

### 方式 A：内置插件（开发/测试用）

1. 将 `plugins/dsh-engine/manifest.ts` 复制到 `src/plugins/dsh-engine/manifest.ts`
2. 在 `src/plugin-system/builtinPlugins.ts` 中添加：
   ```ts
   import { dshEngineManifest } from '@/plugins/dsh-engine/manifest'
   // 在 registerBuiltinPlugins() 中：
   pluginRegistry.register(dshEngineManifest)
   ```
3. 手动注册面板加载器（因为 builtin 插件无 installPath）：
   ```ts
   pluginPanelRegistry.register('dsh-workspace', 'polaris.dsh-engine', () =>
     import('@/plugins/dsh-engine/DSHPanel').then(m => ({ default: m.default }))
   )
   ```
4. 适配器路径：将 `adapter.mjs` 放在 Polaris 能访问的路径（如 `src-tauri/plugins/dsh-engine/adapter.mjs`），并在 manifest 中更新 entry 为绝对路径

### 方式 B：用户插件（生产用）

1. 将 `plugins/dsh-engine/` 目录复制到 Polaris 用户插件目录：
   - `~/.polaris/plugins/dsh-engine/`
   - 或通过 Polaris 插件设置页面的"安装本地插件"
2. 确保 `manifest.json` 中的 `adapter.entry` 是相对于 `installPath` 的路径（即 `./adapter.mjs`）
3. 启动 Polaris，在引擎设置中启用 DeepSeek Harness 引擎
4. 如果未安装 `@deepseek-ai/dsh`，引擎设置页会显示"一键安装"按钮

### 方式 C：独立运行（最小原型）

适配器可以独立运行，无需 Polaris：

```bash
# 直接给适配器发 JSONL 请求
echo '{"id":1,"method":"start_session","params":{"message":"你好"}}' | \
  node adapter.mjs

# 输出：
# {"event":"ai_event","type":"assistant_message","session_id":"dsh-xxx","content":"你好！","is_delta":false}
# {"event":"ai_event","type":"session_end","session_id":"dsh-xxx","reason":"completed"}
# {"id":1,"result":{"session_id":"dsh-xxx","resume_token":"..."}}
```

---

## 4. 架构说明

```
┌─────────────────────────────────────────────────────────────────────┐
│  Polaris (Tauri App)                                                │
│                                                                     │
│  ┌──────────────┐  ┌──────────────────────────────────────────────┐│
│  │ PluginProcess │  │  DSH Web UI Panel (iframe)                   ││
│  │ Engine        │  │  ┌─────────────────────────────────────────┐ ││
│  │ (Rust, JSONL) │  │  │  localhost:3080 (DSH Web UI)            │ ││
│  └──────┬───────┘  │  └─────────────────────────────────────────┘ ││
│         │          │                                               ││
│         │stdin     │  ┌──────────────────────────────────────────┐ ││
│         │JSONL     │  │  Plugin Service Manager (dsh-web)        │ ││
│         ▼          │  │  spawns & supervises dsh web process     │ ││
│  ┌──────────────┐  │  └──────────────────────────────────────────┘ ││
│  │ adapter.mjs  │  │                                               ││
│  │ (Node.js)    │  │                                               ││
│  └──────┬───────┘  │                                               ││
│         │          │                                               ││
└─────────┼──────────┴───────────────────────────────────────────────┘
          │
          │ ┌── DSH_DRIVER=headless ──────────────────────────────┐
          │ │ spawn dsh --profile headless "<task>"               │
          │ │ 每轮生成新进程，通过重放 history 模拟多轮对话        │
          │ └──────────────────────────────────────────────────────┘
          │
          │ ┌── DSH_DRIVER=webapi ────────────────────────────────┐
          │ │ 通过 HTTP API + WebSocket 驱动 dsh web 会话         │
          │ │ 获得完整流式事件（工具调用、delta、ask-user 等）     │
          │ │ 需要先运行 probe-api.mjs 探测路由                    │
          │ └──────────────────────────────────────────────────────┘
          │
          ▼
   ┌──────────────┐
   │  dsh 进程    │
   │  (Cordis 4)  │
   │  Agent + 工具 │
   └──────────────┘
```

---

## 5. 验证流程

### 5.1 最小可行性验证（1 小时）

```bash
# 步骤 1: 安装 dsh
npm install -g @deepseek-ai/dsh
dsh --version         # 验证安装

# 步骤 2: 配置凭据
# 首次运行 dsh 会引导设置 API Key，或直接设置环境变量
export DEEPSEEK_API_KEY=sk-xxx

# 步骤 3: 烟测试适配器
cd plugins/dsh-engine
node smoke.mjs        # 8 个测试应全部通过

# 步骤 4: 手动测试适配器
echo '{"id":1,"method":"start_session","params":{"message":"用中文写一首诗"}}' | \
  node adapter.mjs
# 应输出结果和事件

# 步骤 5: 探测 API 路由（如果 dsh web 已启动）
node probe-api.mjs --port 3080
```

### 5.2 完整集成验证（半天）

```bash
# 步骤 6: 注册为 Polaris 内置插件（见 3.1）
# 步骤 7: 启动 Polaris（dev 或 tauri:dev）
# 步骤 8: 在引擎设置中找到 DeepSeek Harness 引擎
# 步骤 9: 创建新会话，选择 DeepSeek Harness 引擎
# 步骤 10: 发送消息，验证响应
# 步骤 11: 点击活动栏 "DSH 工作区" 面板，验证 iframe 嵌入
# 步骤 12: 验证 dsh-web 服务自动启动
```

### 5.3 高级验证（1 天）

```bash
# 步骤 13: 在 DSH 工作区面板中测试完整功能
#   - 多轮对话
#   - 工具调用（bash、文件操作）
#   - 子代理
#   - 工作流
#   - 目标跟踪
# 步骤 14: 验证 webapi 驱动（需要 probe-api 输出）
#   DSH_DRIVER=webapi node smoke.mjs
# 步骤 15: 引擎切换测试
#   - 在 Polaris 聊天中切换到 DeepSeek Harness 引擎
#   - 发送消息，验证响应通过适配器返回
# 步骤 16: MCP 桥接验证
#   - 在 DSH 配置中添加 Polaris 的 MCP server
#   - 验证 DSH 可使用 Polaris 的 Git/文件工具
```

---

## 6. 已知限制与风险

### 6.1 headless 驱动限制

| 限制 | 影响 | 解决方案 |
|------|------|----------|
| 无流式输出 | 用户需等待完整响应 | 使用 webapi 驱动 |
| 无工具事件帧 | Polaris 看不到工具调用过程 | webapi 驱动可解析轨迹事件 |
| 每轮秒级延迟 | 启动 dsh 有开销 | 适配器常驻 + 预热 |
| 上下文窗口 | 重放 history 会消耗 token | headless 无此机制 |

### 6.2 webapi 驱动待验证

- **路由不确定性**：dsh-host-apiproxy 的路由需运行时探测（probe-api.mjs）
- **事件格式**：DSH API 的事件格式需要反向确认
- **认证**：DSH web API 的认证机制未知
- **WebSocket 协议**：如果使用 WS 而非 SSE，需要不同的连接管理

### 6.3 集成风险

| 风险 | 等级 | 说明 |
|------|:----:|------|
| 双审批系统冲突 | 🔴 | DSH 有自己的 ask-user 审批，Polaris 也有 approval 通道；需透传 |
| 凭据路由 | 🟡 | DSH 用 profile 分层配置 API Key，需与 Polaris 的 Provider 设置同步 |
| 双模型选择 | 🟡 | Polaris 选模型 + DSH 选模型，需确定谁优先 |
| 启动延迟 | 🟡 | dsh boot 秒级，用户感知 |
| Node.js 依赖 | 🟡 | 需要用户安装 Node.js（已有 Codex/Claude 的先例，可接受） |
| 版本兼容 | 🟢 | 当前适配的 dsh 0.1.0-rc.6；升级需同步 |

### 6.4 建议

1. **短期**（1-2 天）：完成 headless 驱动的烟测试 + Polaris 内置插件注册，验证"最小可行"路径
2. **中期**（1 周）：运行 probe-api.mjs，补全 webapi 驱动的路由映射，实现流式 + 工具事件
3. **长期**（2-4 周）：实现审批透传 + 凭据路由 + MCP 双向桥接，达到"深度集成"水平

---

## 文件清单

| 文件 | 用途 |
|------|------|
| `adapter.mjs` | engine-v1 协议适配器（双驱动） |
| `panel.js` | React 面板组件（iframe 嵌入 DSH Web UI） |
| `manifest.json` | Polaris 插件 manifest（用户安装用） |
| `manifest.ts` | TypeScript manifest（内置注册用） |
| `smoke.mjs` | 端到端烟测试脚本 |
| `probe-api.mjs` | DSH Web API 路由探测工具 |
| `package.json` | npm 包元数据 |
| `README.md` | 本文件 |

---

*DSH = DeepSeek Harness (`@deepseek-ai/dsh`)*
*协议版本: engine-v1 / 适配器版本: 0.1.0*
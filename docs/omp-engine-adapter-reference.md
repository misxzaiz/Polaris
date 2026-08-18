# omp-engine-adapter 样例插件 — 参考实现

> 本文件是 Polaris-plugin 仓库中 `omp-engine-adapter/` 插件的参考实现指南。
> 该插件验证 `PluginProcessEngine` 全链路：适配器进程 → 协议帧解析 → 事件透传。

## ✅ 落地状态（2026-08-18 核验）

插件包**已实装**于同名仓库 `D:\space\base\Polaris-plugin\plugins\omp-engine-adapter\`
（早于本文档创建，git 已跟踪），含 `plugin.json` + `engine.js` + `update.json`：

- `plugin.json`：声明 `engines[].adapter`（entry=engine.js, runtime=node, protocol=engine-v1）
- `engine.js`：完整实现 `start_session` / `continue_session` / `interrupt` 三方法协议帧
- `update.json`：CDN 更新源

主仓库 `PluginProcessEngine`（`src-tauri/src/ai/engine/plugin_process_engine.rs`，644 行）
与适配器协议匹配；`registry.rs` 注册分流（有 adapter → PluginProcessEngine，无 → PluginEngineRunner）。

**回归测试**：本次已在 `plugin_process_engine.rs` 补 9 个 `parse_event_frame` 单测，
覆盖 assistant_message / session_end / tool_call_start / tool_call_end（含 null result）/
usage / 未知类型 / 畸形帧——确保适配器契约在生产级回归时不漂移。
`cargo test --lib --no-run` 编译通过（本机运行受 [[rust-lib-test-env-limit]] 约束，逻辑由 CI 执行）。

## 文件结构

```
omp-engine-adapter/
├── plugin.json          # 插件清单（声明 adapter + engines）
├── engine.js            # 适配器进程（Node.js）
└── README.md            # 说明文档
```

## plugin.json

```json
{
  "id": "omp-engine-adapter",
  "name": "OMP Engine Adapter",
  "version": "0.1.0",
  "description": "验证 PluginProcessEngine 全链路的样例适配器插件",
  "builtin": false,
  "contributes": {
    "engines": [{
      "id": "omp-adapter-test",
      "name": "OMP Adapter (test)",
      "adapter": {
        "entry": "engine.js",
        "runtime": "node",
        "protocol": "engine-v1"
      },
      "env": {},
      "capabilities": {
        "streaming": true,
        "tools": false,
        "systemPrompt": true,
        "maxContextWindow": 128000
      }
    }]
  }
}
```

## engine.js

```javascript
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });

/** 会话状态：{ sessionId, resumeToken, messages } */
const sessions = new Map();

rl.on('line', (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    process.stderr.write(`[adapter] 解析失败: ${line}\n`);
    return;
  }

  const { id, method, params } = req;

  switch (method) {
    case 'start_session': {
      const sessionId = params?.session_id || `mock-${Date.now()}`;
      const resumeToken = `/mock/${sessionId}`;
      sessions.set(sessionId, { resumeToken, messages: [] });

      // 模拟 AI 回复（事件流）
      emitEvent(sessionId, 'assistant_message', { content: 'Hello from adapter!', is_delta: true, session_id: sessionId });
      emitEvent(sessionId, 'assistant_message', { content: ' This is a mock response.', is_delta: true, session_id: sessionId });
      emitEvent(sessionId, 'session_end', { session_id: sessionId });

      // 响应帧
      emitResponse(id, { session_id: sessionId, resume_token: resumeToken });
      break;
    }

    case 'continue_session': {
      const sessionId = params?.session_id;
      const session = sessions.get(sessionId);
      if (!session) {
        emitResponse(id, { error: `Session not found: ${sessionId}` });
        return;
      }

      // 模拟续聊回复
      emitEvent(sessionId, 'assistant_message', { content: 'Continuing session...', is_delta: true, session_id: sessionId });
      emitEvent(sessionId, 'session_end', { session_id: sessionId });

      emitResponse(id, { session_id: sessionId, resume_token: session.resumeToken });
      break;
    }

    case 'interrupt': {
      const sessionId = params?.session_id;
      emitEvent(sessionId, 'session_end', { session_id: sessionId });
      emitResponse(id, { ok: true, session_id: sessionId });
      break;
    }

    default:
      emitResponse(id, { error: `Unknown method: ${method}` });
  }
});

function emitEvent(sessionId, type, data) {
  const frame = JSON.stringify({ event: 'ai_event', type, ...data });
  process.stdout.write(frame + '\n');
}

function emitResponse(id, result) {
  const frame = JSON.stringify({ id, result });
  process.stdout.write(frame + '\n');
}

// 通知宿主适配器已就绪
process.stdout.write(JSON.stringify({ event: 'ready', protocol: 'engine-v1' }) + '\n');
```

## 协议说明

每行一条 JSON，两种帧类型：

### 请求帧（宿主 → 适配器）

```json
{"id": 1, "method": "start_session", "params": {"session_id": "...", "message": "用户消息", "system_prompt": "..."}}
{"id": 2, "method": "continue_session", "params": {"session_id": "...", "message": "续聊消息", "resume_token": "/..."}}
{"id": 3, "method": "interrupt", "params": {"session_id": "..."}}
```

### 事件帧（适配器 → 宿主，无 id）

```json
{"event": "ai_event", "type": "assistant_message", "content": "...", "is_delta": true, "session_id": "..."}
{"event": "ai_event", "type": "session_end", "session_id": "..."}
```

### 响应帧（适配器 → 宿主，带 id）

```json
{"id": 1, "result": {"session_id": "...", "resume_token": "..."}}
```

## 验证步骤

1. 将插件安装到 Polaris 插件目录
2. 在引擎选择器中选择 "OMP Adapter (test)"
3. 发消息 → 应收到 "Hello from adapter! This is a mock response."
4. 续聊 → 应收到 "Continuing session..."
5. 中断 → 引擎应正常停止

## 实现状态

| 组件 | 状态 | 位置 |
|------|------|------|
| PluginEngineAdapterDecl | ✅ 已定义 | `src-tauri/src/ai/traits.rs:253` |
| PluginEngineConfig.adapter | ✅ 已定义 | `src-tauri/src/ai/traits.rs:241` |
| PluginProcessEngine | ✅ 已实现 | `src-tauri/src/ai/engine/plugin_process_engine.rs` |
| 注册分流（adapter vs runner） | ✅ 已实现 | `src-tauri/src/ai/registry.rs:125` |
| 适配器插件包 | ⏳ 待创建 | 本文件为参考实现，需在 Polaris-plugin 仓库创建 |
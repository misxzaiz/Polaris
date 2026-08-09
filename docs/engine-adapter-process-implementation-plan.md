# 引擎适配器进程化 —— 实施方案

## 目标

加任何新 AI 引擎只需写一个插件包（引擎适配器进程），不改 Polaris 核心。

## 前置：已复审验证的结论

- 协议可行（`事件帧 + 响应帧` JSONL，已用独立 Rust 项目实测）
- AIEvent 不能直接 serde 往返（tuple-variant 重复 `type` 字段），需协议层 `"event":"ai_event"` 标记 + 手动构造
- 生命周期复用 `SessionManager`，事件依赖 `AIEvent` 标准格式

## 方案架构

```
Polaris Core                         插件包 (omp-engine/)
  PluginProcessEngine  ←stdin/stdout→  engine.js (适配器)
    │                                    │
    └── SessionManager                   └── spawn 引擎 CLI (omp/pi/xxx)
    └── event_callback → 前端
```

## 阶段拆解

### Phase 0：协议验证（已完成 ✅）

独立 Rust 项目 `/tmp/aievent_probe` 已验证：
- 事件帧/响应帧/错误帧解析
- struct-variant 事件直接反序列化
- tuple-variant 事件手动构造

### Phase 1：Polaris 核心一次性基建（约 350 行）

**[1] 新增 `PluginEngineAdapter` 声明**（`traits.rs`）

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PluginEngineAdapterDecl {
    /// 适配器入口（相对插件 installPath）
    pub entry: String,
    /// 运行 runtime（node / python3 / deno / 空=直接执行）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    /// 协议版本（"engine-v1"）
    pub protocol: String,
}
```

在 `PluginEngineConfig` 加字段：`pub adapter: Option<PluginEngineAdapterDecl>`。

**[2] 新增 `adapter` 到 manifest**（`models/plugin.rs` + `types.ts` + `pluginDiscoveryService.ts`）

**[3] 新增 `PluginProcessEngine`**（`ai/engine/plugin_process_engine.rs`，~250 行）

实现 `AIEngine`：
- `start_session`：spawn 适配器 → 发 `start_session` 请求 → 读事件流 → 转发 AIEvent
- `continue_session`：发 `continue_session` 请求（带 resume_token）
- `interrupt`：发 `interrupt` 请求 + `SessionManager::kill_process` 兜底
- `send_input` / `active_session_count` / `has_active_session`：复用 `SessionManager`
- 事件解析：reader 循环，按 `"event":"ai_event"` / `id` 分发

验证：`cargo check --lib`（见 [[rust-lib-test-env-limit]]）

**[4] registry 分流**（`registry.rs`）

```rust
pub fn register_plugin_engine(&mut self, config: PluginEngineConfig) -> Result<()> {
    // adapter 声明 → PluginProcessEngine；否则 → PluginEngineRunner（向后兼容）
    if config.adapter.is_some() {
        self.engines.insert(engine_id, Box::new(PluginProcessEngine::new(config)));
    } else {
        self.engines.insert(engine_id, Box::new(PluginEngineRunner::new(config)));
    }
}
```

### Phase 2：样例适配器插件（验证全链路）

**在 `Polaris-plugin` 新增 `omp-engine-adapter` 插件**（不动旧 omp-engine）：

```
omp-engine-adapter/
├── plugin.json          # 声明 adapter + engines
├── engine.js            # 适配器进程（node）
```

`plugin.json`：
```json
{
  "id": "omp-engine-adapter",
  "contributes": {
    "engines": [{
      "id": "omp-adapter-test",
      "name": "OMP Adapter (test)",
      "adapter": {
        "entry": "engine.js",
        "runtime": "node",
        "protocol": "engine-v1"
      },
      "cli": { "command": "omp", "installGuide": "..." }
    }]
  }
}
```

**`engine.js` 骨架**（先在开发机上用 mock 引擎验证协议，不接真 omp）：
```javascript
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const req = JSON.parse(line);
  if (req.method === 'start_session') {
    // mock: 立即回事件 + 响应
    process.stdout.write(JSON.stringify({event:'ai_event',type:'assistant_message',session_id:'mock',content:'hello',is_delta:true}) + '\n');
    process.stdout.write(JSON.stringify({event:'ai_event',type:'session_end',session_id:'mock'}) + '\n');
    process.stdout.write(JSON.stringify({id:req.id,result:{session_id:'mock',resume_token:'/mock'}}) + '\n');
  }
});
```

### Phase 3：端到端验证

1. `cargo check --lib` 通过
2. 安装样例插件，引擎选择器出现 "OMP Adapter (test)"
3. 发消息 → 收到 mock 回复（assistant_message + session_end）
4. 续聊 → continue_session 收到正确 resume_token
5. 中断 → interrupt 生效

### Phase 4（可选）：迁移 omp 到适配器

把真实 omp 的 `engine.js`（从 `pi_parser.rs` 移植翻译逻辑）写进插件包，替换旧 omp-engine 的 `PluginEngineRunner` 路径。

## 验证方法

| 阶段 | 验证 | 命令 |
|------|------|------|
| Phase 1 | 编译 | `cargo check --lib` |
| Phase 1 | 协议单测 | 新增 `#[cfg(test)]` 测事件帧解析 |
| Phase 2 | 插件加载 | 安装插件 → 引擎选择器出现 |
| Phase 3 | 全链路 | 发消息 → 收回复 → 续聊 → 中断 |

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| AIEvent 重复 type 字段 | 协议用 `"event":"ai_event"` 标记 + 手动构造（已验证） |
| adapter runtime 缺失 | manifest 声明 runtime + `unavailable_reason` 提示 |
| 进程树清理（适配器+引擎双层） | `SessionManager::kill_process` 的 `taskkill /T` 覆盖 |
| 旧 omp 受影响 | 分流：旧走 `PluginEngineRunner`，新走 `PluginProcessEngine`，互不影响 |
| 协议不稳定 | Phase 2 用 mock 适配器先行验证，再实现真实引擎 |

## 工作量估算

| 阶段 | 内容 | 量级 |
|------|------|------|
| Phase 1 | 核心基建（声明+引擎+分流） | ~350 行 Rust |
| Phase 2 | 样例适配器插件 | ~80 行 JS + JSON |
| Phase 3 | 端到端验证 | — |
| Phase 4 | 迁移 omp（可选） | 插件包 ~150 行 JS |

**Polaris 核心一次性改动 ~350 行，之后加引擎零改核心。**
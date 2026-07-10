# 内嵌代理 ConnectionRefused 修复方案

## 问题描述

在 `continue_chat_inner` 中，代理被先于 claude.exe 进程杀死，导致
in-flight 的 claude.exe 请求收到 `ConnectionRefused`。

## 根因

执行顺序：
1. `start_proxy()` → `old.shutdown()` → 旧代理端口关闭
2. `registry.continue_session()` → `kill_process()` → 旧 claude.exe 被杀
3. 新 claude.exe 启动

问题：步骤 1 和 2 之间，旧 claude.exe 还在等上游响应（可能长达 180s），
但代理端口已被关闭 → `ConnectionRefused`。

## Phase 0: 补丁 — 调整 kill 顺序

**`src-tauri/src/commands/chat.rs`** — `continue_chat_inner` 中：
- 在 `apply_model_profile_options`（含 start_proxy）之前
- 先调用 `registry.terminate_session(&session_id)` 杀掉旧进程
- 这样杀代理时已经没有 in-flight 请求

**`src-tauri/src/ai/engine/mod.rs`** — EngineRegistry 加方法：
```rust
pub fn terminate_session(&mut self, session_id: &str) -> bool {
    for engine in self.engines.iter_mut() {
        if engine.interrupt(session_id).is_ok() {
            return true;
        }
    }
    false
}
```

## Phase 1: 架构重构 — 代理生命周期归引擎所有

- 代理启动/停止移入 ClaudeEngine / CodexEngine 内部
- `chat.rs` 只传递 ProxyConfig 给引擎
- 引擎在 kill 旧进程后、启动新进程前创建代理

## Phase 2: 健壮性 — 优雅停服 + 健康检查

- ProxyHandle 加 active_requests 计数器，shutdown 时 drain in-flight 请求
- ProxyManager 后台健康检查，代理意外死亡时自动重启

## 当前状态

- Phase 0: 待执行
- Phase 1: 待执行
- Phase 2: 待执行

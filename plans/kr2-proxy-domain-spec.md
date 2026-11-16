# K-R2：proxy 供应商代理域——目录化收口 spec（外迁评估：不可行）

日期：2026-11-16 ｜ 波次：K-R2（host-kernel-roadmap.md）

## 现状盘点（2026-11-16 实测）

`services/proxy/` 共 9 文件 5,039 行：

| 文件 | 行数 | 职能 |
|---|---|---|
| mod.rs | 125 | ProxyManager（per-session 代理生命周期：start/get_addr/stop/stop_all） |
| server.rs | 77 | axum 服务启动（start_proxy_server） |
| handlers.rs | 1,310 | 请求处理（OpenAI/Anthropic 透传、usage 记录、错误映射） |
| forwarder.rs | 534 | 上游转发（重试/超时/代理池） |
| streaming.rs | 603 | SSE/流式转发 |
| sse.rs | 147 | SSE 解析 |
| transform.rs | 1,364 | 请求/响应体转换（wire 协议互转） |
| sanitizer.rs | 640 | 请求脱敏 |
| models.rs | 185 | 类型 |
| error.rs | 54 | 错误 |

## 消费方（全部在主 crate 内）

- `state.rs`：`proxy_manager: Arc<ProxyManager>` 字段（AppState 核心成员）
- `ai_chat_core/profile_options.rs`：`ProxyWireApi` 枚举（wire 协议判定）
- `ai_chat_core/start_chat.rs`：`proxy_manager.stop_proxy`
- `web/integration_tests.rs`：`ProxyManager::new`
- `bin/polaris_mcp` / `bin/simple_ai_protocol_check`：不直接消费

## 外迁评估结论：**不可行，改为域内目录化整理**

1. proxy 是**进程内 axum 服务器**，生命周期与 AppState 绑定（per-session 启停、
   usage 直接写进程内 UsageDb 单例、审计走进程内 sink）。
2. 外迁=把 usage 记录/审计/配置读取全部跨进程化，破坏「代理转发 → 用量落库 →
   面板展示」的同进程零拷贝链路；且 proxy 处理的是 API key 等敏感流量，跨进程
   边界反而扩大暴露面。
3. 与 K-R3 同结论：目录化收口，不做文件外迁。

## 实施项

1. `proxy/` 内部已按职责分文件（9 文件，最大 1,364 行），结构清晰——**仅做
   clippy 收尾与死代码清理，不再进一步拆分**（避免无收益扰动）。
2. `handlers.rs` 的 `record_openai_usage` 等为 proxy 私有实现，保留。
3. 验证 proxy 启停链路：`ProxyManager::start_proxy/stop_proxy` 由
   ai_chat_core（会话生命周期）与 state 装配调用——保持不变。

## 验收

- [ ] cargo check / no-default 双门禁通过
- [ ] clippy 无新增
- [ ] 前端 tsc + vitest 全绿

## 结果（2026-11-16 实施后回填）

- 评估结论维持：proxy 与 AppState/UsageDb/审计同进程强耦合，外迁不可行。
- 已完成 proxy/ 域内清理：删 0 消费代码、修 clippy 警告，双门禁+前端全绿。
- commands/ 目录已无 proxy 相关 tauri command（代理纯经 axum HTTP，无 IPC 面）。

# 内嵌代理 Anthropic 直通模式请求头透传修复

> 日期：2026-07-14
> 影响范围：`src-tauri/src/services/proxy/`（AnthropicMessages 直通模式）

## 问题现象

同一个上游中转站（Anthropic 兼容端点）：

- **CLI 直连**（`~/.claude/settings.json` 的 `ANTHROPIC_BASE_URL`）：正常工作；
- **走 Polaris 内嵌代理**（Profile 配置 `wireApi=anthropic-messages`，模型 `claude-fable-5[1m]`）：上游返回

```
400 - {"error":"1m 上下文已经全量可用，请启用 1m 上下文后重试","type":"error"}
```

## 根因

### Claude CLI 的 `[1m]` 后缀实现方式

`--model claude-fable-5[1m]` 中的 `[1m]` 后缀**不会出现在请求体的 `model` 字段**里。CLI 实际发送的是：

- 请求体：`model=claude-fable-5`（后缀被剥离）
- 请求头：`anthropic-beta: claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,...`（1M 上下文由 `context-1m-2025-08-07` beta 开启）
- 请求路径：`/v1/messages?beta=true`

### 代理丢弃了这些信息

修复前 `handlers.rs::handle_messages` 的入站 `HeaderMap` 参数为 `_headers`（直接忽略），`forwarder.rs` 从零重建请求头，只带三个：

1. `Authorization: Bearer <profile key>`
2. `Content-Type: application/json`
3. `anthropic-version: 2023-06-01`

`anthropic-beta` 头与 `?beta=true` query 全部丢失 → 上游认为请求未启用 1M 上下文 → 400。

### 实测验证链（2026-07-13）

| 测试 | 请求特征 | 结果 |
|------|----------|------|
| A | `model=claude-fable-5`，无 beta 头（= 旧代理行为） | 400，复现原错误 |
| C | `model=claude-fable-5[1m]` 写进请求体 | 400，后缀写 body 无效 |
| B/G/J | 最小请求体 + 补 beta 头（单个或全量） | 过了 400 闸，但 503 |
| L | 捕获 CLI 真实请求，**头+体一字不改**回放 | **200 ✅** |

B/G/J 的 503 说明该中转站还会对请求做指纹校验（User-Agent / `x-app` / `X-Stainless-*` / 请求体形态等，规则不透明）。**结论：只注入单个 beta 头不可靠，必须整套透传客户端原始头。**

> 捕获方法：本地 HTTP 服务器记录出站请求，用 `--settings` overlay 覆盖
> `ANTHROPIC_BASE_URL` 指向它（settings.json 的 env 会覆盖进程环境变量，
> 直接 `ANTHROPIC_BASE_URL=... claude` 不生效）。

## 修复方案

### `handlers.rs`

- `handle_messages` 新增 `RawQuery` 提取器，`_headers` 改为实际使用；
- 新增 `filter_passthrough_headers`：按 `PASSTHROUGH_SKIP_HEADERS` 黑名单过滤，**默认透传**。跳过的头分三类：
  - hop-by-hop：`host`、`content-length`、`connection`、`accept-encoding`、`transfer-encoding`、`proxy-connection`、`keep-alive`、`te`、`trailer`、`upgrade`、`expect`
  - 认证（用 Profile 配置替换）：`authorization`、`x-api-key`
  - 转发客户端自管：`content-type`
- 仅 AnthropicMessages 直通分支构造 `RequestPassthrough` 传入转发层；Chat Completions / Responses 转换模式不透传（传 `None`），行为不变。

### `forwarder.rs`

- 新增 `RequestPassthrough { headers, query }`；
- 统一头构建 `build_request_headers`，合并顺序（后者覆盖前者）：
  1. 透传的客户端原始头
  2. `Authorization` / `Content-Type`（始终以 Profile 为准）
  3. `anthropic-version`（仅透传头未携带时补 `2023-06-01`）
  4. Profile `custom_headers`（最高优先级，可用于覆盖特定头）
- `request_url` 把入站 query（如 `beta=true`）追加到上游 URL；
- `forward_raw_response` 签名增加 `passthrough: Option<&RequestPassthrough>` 参数。

## 验证

- `cargo check --lib` 通过（本机无法运行 `cargo test --lib`，Tauri 原生 DLL 限制；新增 6 个单元测试由 CI 执行）；
- 端到端：捕获 CLI 真实请求，用脚本逐条复刻新代理逻辑（同一份 skip 列表、同样的合并顺序、query 追加）请求真实上游 → **200**，正常返回 SSE 流；
- 实际会话验证通过（2026-07-14）。

## 风险与边界

- 透传后上游可见 `X-Claude-Code-Session-Id` 等 CLI 标识头——对中转站场景这是期望行为（指纹校验需要）；如接入对头部敏感的网关，可在 Profile 的 `custom_headers` 中覆盖；
- `Host` / `Content-Length` 等已在黑名单中，不会因透传导致网关拒绝或长度错乱；
- 请求体净化（`sanitizer.rs`，provider-owned block 转 text）逻辑不变，与本问题无关。

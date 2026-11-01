# spec: cap.pluginDiscovery:install_remote 对已鉴权 Remote 放行

日期：2026-11-02
状态：已实施

## 目标

手机/Web（Remote）端在商城面板选择本地商城源（如 `http://127.0.0.1:8787/index.json`）后，
可直接点「安装到 User/Project」完成安装，不再被 `cap.plugin*` 通配 deny 挡住。

## 背景

- P1-h（2026-10-25）已把 cap.pluginDiscovery 拆为「只读动作放行 + 写动作 deny」。
- marketplace 1.4.0 已打通 Remote 浏览本地源（cap.mcp:call → proxy_fetch），但安装按钮仍被 deny。
- `install_remote` 的实际下载由宿主 reqwest 在桌面机内执行（`plugin_service.rs:1755`
  `download_plugin_source`），`127.0.0.1` 指向桌面机自身，本地源天然可达；
  manifest 相对 downloadUrl 经 `resolve_source_url`（`plugin_service.rs:1894`）解析为绝对 URL。
- AI 会话（Plugin 源）调用 install_remote 现已默认放行（审批名单 2026-10-26 停用）；
  已鉴权 Remote（持有效 token，与桌面同信任级）不应对安装能力低于 AI 会话。

## 改动（所有者：policy_permission.rs）

在 P1-h 只读放行数组旁新增一条精确动作级 allow 规则：

- `capability: "cap.pluginDiscovery:install_remote"`（特异性 2，胜过 `cap.plugin*` 通配 deny）
- `source: Remote`、`verdict: Allow`、`require_auth: true`

语义边界（不变）：

- 未鉴权 Remote：require_auth 规则被 best_match 跳过，回落通配 deny（X9 零回归）。
- 其余写动作（uninstall_local / uninstall_with_cleanup / force_uninstall / apply_update /
  dev_link / install_local）维持 deny。
- Plugin/Bootstrap 来源行为不变。

## 风险与接受理由

- SSRF 面：install_remote 接受任意 http(s) URL，放行后持 token 的 Remote 可让宿主任意 GET。
  接受理由：token 即桌面信任级（可调 cap.mcp:call / cap.kv 等），且该能力 AI 会话已默认拥有；
  下载内容经 manifest 校验 + zip 提取，落地为插件目录而非任意写。
- 不改 PolicyPermission 结构、无热 reload 需求（随宿主启动构造）。

## 验收

1. `cargo check` 通过；`cargo check --no-default-features --bin polaris-web --bin polaris-mcp` 通过。
2. 单测：已鉴权 Remote 调 `cap.pluginDiscovery` + payload.action=install_remote → Allow；
   未鉴权 Remote 同参数 → Deny；uninstall_local 对已鉴权 Remote 仍 Deny。
3. 前端 humanizeError 文案同步（安装不再列入"远程需桌面端操作"清单）。

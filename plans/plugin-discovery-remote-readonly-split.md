# cap.pluginDiscovery 远程只读拆分（移动端/Web 插件识别修复）

- 日期：2026-10-25
- 状态：已实施
- 前置：`ddc179c3`（P1-f Web 插件管理放行 token 分级）、`plans/router-governance-hardening-spec.md`

## 问题

移动端 App / Web（HTTP 传输，`Source::Remote`）打开插件页完全无法识别插件，
插件商城（`polaris.marketplace` 本身是经 discover 出现的已安装插件）入口也消失。

根因：`policy_permission.rs` 内置规则 `cap.plugin*`（通配）对 Remote 一律 Deny。
P1-f 只给 `cap.pluginServiceManager` 开了已鉴权 Remote 放行，`cap.pluginDiscovery`
无豁免——只读的 `discover` / `list` 与写动作（install/uninstall）被一刀切。
前端 `PluginTab` 的 `refreshInstalledPlugins` → `cap.pluginDiscovery.discover`
被 gate 拒绝 → 列表空 + Discovery failed；商城可见性 = 列表里有无
`polaris.marketplace`，故商城同样消失。

## 方案（读写拆分，P1-f 同款思路）

| 动作 | 已鉴权 Remote（token 匹配） | 未鉴权 Remote | Bootstrap/Plugin |
|---|---|---|---|
| `discover` / `list` / `install_locations` / `validate_manifest` / `adapters_list` / `check_update` | **Allow（新增）** | Deny（不变） | Allow（不变） |
| `install_local` / `install_package` / `install_remote` / `uninstall_*` / `force_uninstall` / `apply_update` / `discover_adapter` | Deny（不变） | Deny（不变） | 不变 |

实现：`from_config` 在 `cap.plugin` 通配 deny 之后追加 6 条
`cap.pluginDiscovery:<action>` 精确 allow 规则（`require_auth: true`）。
匹配语义复用 P1-g 动作级匹配：dispatch 注入 `payload.action` →
`check` 先试 `capId:action`（精确，特异性 2）后回退 bare id（通配 deny，特异性 1）。

- 已鉴权：精确 allow 胜出通配 deny → 放行。
- 未鉴权：`require_auth` 规则被 `best_match` 跳过 → 回落通配 deny（X9 零回归语义不变）。
- `discover_adapter` 不放行：调试用强制刷新入口（绕缓存/熔断 + one-shot MCP 网络调用），UI 无消费方，保守关死。
- 写动作保持 deny：安装/卸载=文件系统变更，`router-governance-hardening` 收紧基调不变；移动端装插件走桌面端（Bootstrap 源）完成。

## 验收

- 未设 `web.token` 时行为与改前完全一致（Remote 全 deny）。
- token 匹配的 Remote 可 discover/list 插件与商城；安装/卸载仍被拒。
- Bootstrap（桌面 IPC）不受影响。
- 用户 config 精确规则的覆盖语义（特异性 2 > 1、同特异性后者覆盖）不因内置规则追加而改变。

## 关联文件

- `src-tauri/src/services/router/policy_permission.rs`（规则 + 测试 + 模块文档）
- `src-tauri/src/services/router/plugin_discovery_capability.rs`（describe 注释同步）

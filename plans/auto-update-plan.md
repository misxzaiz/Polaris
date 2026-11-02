# 桌面端自动更新 spec

> 目标：手机 / Web 触发后，电脑端 Polaris 自己完成「检查 → 下载 → 安装 → 重启」，
> 重启后新版立即可用，全程无需用户回到电脑前确认。
> 优先电脑端；移动端仅作为遥控触发入口，本期不做 APK 自更新。
> 范式样板：`cap.app.autolaunch`（宿主级幂等操作、意图走 cap.config、执行走 RouterBus、
> Remote 内置 deny 但 config 精确 allow 可放行）。

## 一、现状症断（已核实）

| # | 问题 | 根因 |
|---|---|---|
| 1 | 自动更新从未生效 | `tauri.conf.json` `createUpdaterArtifacts: false`，CI 不产 `latest.json`/`.sig` |
| 2 | updater endpoint 写死 | `plugins.updater.endpoints` 硬编码 GitHub latest.json（文件不存在） |
| 3 | 源写死 GitHub | `updateService.ts` 硬编码 `api.github.com/repos/misxzaiz/Polaris`，无本地/自建源 |
| 4 | 两步手动确认 | `AppUpdateTab` 先「检查」→显示可用→再点「安装并重启」，无触发即自动完成 |
| 5 | 移动端零接入 | `checkAppUpdate` 开头 `currentMode !== 'tauri'` 直接 throw |
| 6 | CI secrets 已配 | `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` ✅ |
| 7 | updater plugin 已装 | `lib.rs:616` `tauri_plugin_updater::Builder::new().build()` ✅ |
| 8 | releaseDraft=true | `release.yml` 产物落草稿，latest.json 不公开，客户端拉不到 |

## 二、目标（本期范围）

1. **可配置更新源**：GitHub / Local / Custom，设置里持久化，默认 GitHub 零配置可用
2. **触发即自更新**：一旦触发（手动按钮 / 远程下发 / 启动自检）→ 自动跑到底，不弹二次确认
3. **手机/Web 远程触发**：新增 `cap.app.update`，已鉴权 Remote 放行，手机点一下电脑自己升级重启
4. **桌面体验改造**：`AppUpdateTab` 重构为「源选择 + 单按钮触发 + 进度贯穿 + MSI 逃生口」

## 三、更新源模型

统一抽象 `UpdateSource`，配置存于 `Config.update`（走 cap.config 透传，与 autoLaunch 同链）：

```ts
interface UpdateSourceConfig {
  /** GitHub Releases（默认） / 本地 manifest / 自定义 URL */
  type: 'github' | 'local' | 'custom'
  /** GitHub: 仓库全名，默认 'misxzaiz/Polaris' */
  repo?: string
  /** Local: 本地 manifest.json 路径（同目录须有 MSI + .sig 或仅 MSI） */
  localManifestPath?: string
  /** Custom: manifest.json 的 URL */
  manifestUrl?: string
  /** 是否在桌面端启动时自检一次（默认 false，避免开机即更新打断用户） */
  checkOnStartup?: boolean
}
```

**manifest 统一为 Tauri updater 的 `latest.json` 格式**（version / platforms / signature / url），
三种源下游处理一致。

## 四、签名策略分档

| 源 | 校验方式 | 通道 | 理由 |
|---|---|---|---|
| GitHub | updater 原生 `.sig` | updater plugin | CI 开 `createUpdaterArtifacts` 自动产，零额外成本 |
| Custom | updater 原生 `.sig` | updater plugin | 自建源同样能产 `.sig`（同一 signing key） |
| Local | **免签名**，自实现 msiexec 静默安装 | 自实现通道 | 本地包=用户物理持有，信任链=物理访问；updater plugin 强制签名绕不开，故 Local 走独立通道 |

> Local 源不走 updater plugin（强制签名），改用 `msiexec /i <path> /qn` 静默安装 + relaunch。
> Local 源限定本机文件路径，不网络可达。

## 五、能力设计：cap.app.update

仿 `cap.app.autolaunch` 范式。`cap.app.update`（action: `status` / `run`）。

### 5.1 status（只读，Remote 可调）

返回当前版本 + 源配置 + 是否有更新（不安装）。

```json
{
  "supported": true,
  "currentVersion": "11.0.7",
  "source": { "type": "github", "repo": "misxzaiz/Polaris" },
  "latestVersion": "11.0.8",
  "updateAvailable": true
}
```

### 5.2 run（执行自更新，触发即跑到底）

```json
// 请求
{ "action": "run", "force": false }
// 返回（安装成功后会 relaunch，调用方通常收不到正常返回）
{ "started": true, "version": "11.0.8" }
```

- `force: true` 忽略版本比较（用于 Local 源重装同版本 / 修复损坏）
- 内部流程：读 source 配置 → 比较版本 → 有更新 → 下载安装 → relaunch
- **不弹任何确认 UI**，触发即跑到底
- 安装是异步长任务：进度经现有 EventBroadcaster 广播 `update.progress` 事件
  （下载字节数 / 总字节 / 阶段），前端订阅展示进度条
- relaunch 后进程重启，新版启动时发 `update.completed` 事件（带新旧版本号）

### 5.3 权限策略

仿 autolaunch：Remote 内置 deny，但**已鉴权 Remote 放行 `run`**（你的核心诉求=手机触发）。
参照 `cap.pluginDiscovery:install_remote` 放行先例（2026-11-02，commit 24b16029）：

```rust
// policy_permission.rs 内置规则追加：
// cap.app.update:run 对已鉴权 Remote 放行（手机/Web 触发桌面自更新）
rules.push(PermissionRule {
    capability: "cap.app.update:run".to_string(),
    source: SourceClass::Remote,
    verdict: Verdict::Allow,
    require_auth: true,  // token 匹配 web.token 才放行
    ..Default::default()
});
rules.push(PermissionRule {
    capability: "cap.app.update:status".to_string(),
    source: SourceClass::Remote,
    verdict: Verdict::Allow,
    require_auth: true,
    ..Default::default()
});
```

未鉴权 Remote 维持 deny；本地面板（Bootstrap）默认放行。
**同步更新 AGENTS.md §3.2 能力清单与两 bus 架构文档。**

## 六、实现分层（每层独立可验证）

### 层 0：产物层（一行配置 + 一项评估）
- `tauri.conf.json` → `createUpdaterArtifacts: true`
- CI secrets 已就绪，`tauri-action` 自动产 `latest.json` + `.sig` 并上传 release
- **评估** `release.yml` `releaseDraft: true` → 改 `false`（否则 latest.json 在草稿里拉不到）
- 验收：下个版本 release assets 出现 `latest.json` + `.sig`，且非草稿

### 层 1：源配置 + 持久化
- `src/types/config.ts` 加 `UpdateSourceConfig` 字段（`update?: UpdateSourceConfig`）
- configStore / SettingsPage buildPatch 透传（与 autoLaunch 同链）
- 设置 UI 加「更新源」选择器：下拉 GitHub / Local / Custom
  - Local 弹路径选择（复用现有文件选择）
  - Custom 填 URL
- 默认 GitHub，零配置可用

### 层 2：cap.app.update capability（核心后端）
- 新增 `src-tauri/src/services/router/app_update_capability.rs`
  - `status`：读 currentVersion + source 配置 + 比较最新版本
  - `run`：执行自更新流程
- GitHub/Custom 源：调 `tauri_plugin_updater`（`check()` + `downloadAndInstall()` + process relaunch）
- Local 源：读 manifest → 比较 version → `msiexec /i <path> /qn` 静默安装 → relaunch
- 进度广播：`update.progress` 事件（复用 EventBroadcaster，参照 dispatch 生命周期广播模式）
- `mod.rs` 装配注册（仿 autolaunch register_handle）
- `lib.rs` 无需额外 plugin（updater plugin 已装）

### 层 3：前端执行器 service
- 新增 `src/services/appUpdateService.ts`（仿 `autolaunchService.ts`）
  - `getUpdateStatus()` → dispatch `cap.app.update:status`
  - `runAutoUpdate(force?)` → dispatch `cap.app.update:run`
  - 订阅 `update.progress` / `update.completed` 事件
- **不弹确认**，触发即跑

### 层 4：AppUpdateTab 重构
- 顶部：源选择器（层 1）+ 当前版本 + 最新版本
- 单按钮「检查并更新」→ 直接 `runAutoUpdate()`，进度条贯穿下载+安装
- 安装中禁用按钮，显示阶段（下载中 → 安装中 → 即将重启）
- 保留「下载 MSI」链接作为逃生口（不强制走自动通道）
- 历史版本列表保留

### 层 5：远程触发入口（手机/Web）
- 手机/Web 设置页或专用「远程更新」入口 → 调 `runAutoUpdate()`
- 已鉴权 Remote 自动放行（层 2 策略）
- 进度经事件流回传手机/Web
- **重启后电脑端 Polaris 用新版本启动，手机/Web 重新连接即用新版**

## 七、风险与边界

| 风险 | 说明 | 对策 |
|---|---|---|
| 电脑关机 | 电脑端 Polaris 没运行时无法触发 | 物理限制，下次启动时若 `checkOnStartup=true` 自检补更新 |
| UAC | per-machine MSI 静默安装可能弹 UAC | updater plugin 走已安装权限上下文；Local msiexec /qn 需管理员；建议 per-user 安装 |
| 签名 key 丢失 | signing key 没了无法发可更新版本 | 备份 key（参照 keystore 备份习惯） |
| Local 源免签名 | 本地 MSI 被篡改风险 | 限定本机路径，trust = 物理持有 |
| 中断/断电 | 下载到一半中断 | updater plugin 自带断点；Local 通道需清理临时文件 |
| 重启时机 | relaunch 打断用户当前会话 | run 触发前广播 `update.willRestart`，前端可提示保存；远程触发时手机端可见进度 |
| 跨版本回滚 | 自动更新到坏版本 | manifest 可加 `minRequiredVersion` 字段（后续增强，本期不做） |

## 八、验证清单

### 后端（cargo check 代替 cargo test --lib，本机限制）
- [ ] `cargo check` 通过
- [ ] `cargo check --no-default-features --bin polaris-web --bin polaris-mcp`（动命令层/协议门控）
- [ ] capability 单测：status / run 各分支（仿 autolaunch 测试形态，mock 后端）

### 前端
- [ ] `pnpm exec tsc --noEmit` + `pnpm lint`
- [ ] `appUpdateService.ts` 单测（dispatch 调用形态，仿 autolaunchService.test）
- [ ] AppUpdateTab 交互测试

### 协议同步
- [ ] `cap.app.update` 加入 AGENTS.md §3.2 能力清单（28 个 → 29 个）
- [ ] `plans/two-bus-architecture.md` 同步
- [ ] 前端类型 + Rust 类型对齐

### 手动 E2E
- [ ] 桌面端：触发 run → 自动下载安装重启 → 新版启动
- [ ] 手机端：远程触发 run → 电脑自更新 → 重连用新版
- [ ] Local 源：指定本地 MSI → 静默安装重启
- [ ] release assets 含 `latest.json` + `.sig`

## 九、落地顺序（最简化路径）

1. **层 0**（改配置 + 评估 releaseDraft）→ 让自动更新产物真正存在
2. **层 2**（cap.app.update capability）→ 后端执行器
3. **层 3**（前端 service）→ 桌面可用
4. **层 5**（远程触发放行）→ 手机/Web 能触发（你的核心诉求）
5. **层 1 + 层 4**（源配置 + UI）→ 体验收尾

最小闭环 = 层 0 + 2 + 3 + 5：做完这四层，手机点一下，电脑 Polaris 自己升级重启，
重连即用新版。层 1 + 4 是体验补全（源可选 + UI 改造）。

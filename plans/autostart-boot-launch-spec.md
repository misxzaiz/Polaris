# 开机自启（Boot Autolaunch）实施 spec

> 日期：2026-10-30　状态：待评审
> 形态定案：核心实现（官方 tauri-plugin-autostart），不走 Polaris 插件。

## 0. 背景与定案

- 需求：Windows 登录后自动启动 Polaris 宿主进程。
- **名词澄清**：仓库既有 "autostart"（`pluginServiceManager:autostart`、`contributes.services[].autoStart`、`performance.pluginAutoStart`）均指**插件后台服务随宿主自启**，与 OS 开机自启无关。为避免撞名，新能力命名 **`cap.app.autolaunch`**（对齐 tauri-plugin-autostart 的 `app.autolaunch()` API）。
- **插件形态豁免理由**（对照 AGENTS.md 2026-10-30 功能路由原则，属"确需进核心"）：
  1. 开机时刻宿主未运行，插件是宿主子进程，物理上无法被触发；OS 只能直接拉起宿主 exe。
  2. 插件拿不到宿主 exe 路径（`argsTemplate` 仅注入 `pluginDir`/`port`/`appConfigDir`）。
  3. 插件服务进程直写注册表（node child_process）会绕开 cap 权限 gate + 审计面，属平台口子而非能力面。
  4. 启动项的生命周期（卸载残留、路径漂移、隔离环境护栏）是宿主级职责，不是业务插件的。
- 调研依据：主仓无任何 OS 自启实现；`cap.registry` 是动态能力注册表（非 Windows 注册表）；`tauri-plugin-single-instance` 已有且 multi-instance 默认开（`lib.rs:204-224`）；主窗程序化创建于 `lib.rs:733`；config 为扁平顶层字段风格（`config.rs:1358` / `config.ts:322`）。

## 1. 目标 / 非目标

**目标**
- G1 正式桌面版 设置 → 通用 Tab 提供「开机自动启动」开关，即开即用。
- G2 意图与事实分离 + 启动对账：config 存**意图**，OS 启动项是**事实真源**；每次启动 reconcile 纠偏，并顺带用 `current_exe` 重写注册值（升级/挪目录后的路径漂移自愈）。
- G3 `--minimized` 最小化启动（登录场景不抢焦点）。
- G4 dev/test 隔离环境（`POLARIS_DATA_ROOT` env 覆盖 / `test-profile` feature）下能力 `supported=false`，防止测试包注册污染真实开机项（productName 同为 `polaris`，Run 键会同名冲突）。

**非目标**
- 系统托盘 / 后台常驻（另行立项；v1 最小化到任务栏已够用）。
- macOS/Linux 实测（插件天然支持三端，本机仅验收 Windows）。
- 手机 / PWA（无 OS 开机概念，开关隐藏）。
- 卸载器清理 Run 键（WiX `RemoveRegistryValue` 列为后续可选项，见 §7）。

## 2. 所有权与事件顺序（宪法核心原则 2）

```
意图真源：Config.autoLaunch              事实真源：OS 启动项（Win: HKCU\...\Run）
唯一写路径：                              唯一写路径：
cap.app.autolaunch:set                   TauriAutolaunchBackend（ManagerExt）
（内部编排：先写 config 意图 → 再 ensure OS，     （enable/disable 均为幂等 ensure）
  前端不直改 config、不直调 OS）

开机链路：
OS Run 键 → polaris.exe --minimized
  → lib.rs setup：挂 plugin → 装配 backend + 注册 cap（AppHandle 在手）
  → 主窗创建（命中 --minimized 时 builder.minimized(true)）
  → spawn reconcile：意图开→ensure enable（顺带刷路径）；意图关→ensure disable
  → 前端 GeneralTab：status() 渲染事实
```

- **写入顺序定案**：`set` 先写 config 意图、再 ensure OS。OS 那步失败时报错返回、意图保留——drift 方向为「意图开/事实关」，status() 立即暴露 + 下次启动 reconcile 自愈。反序（先 OS 后 config）一旦 config 写失败会变成「事实开/意图关」→ 重启被 reconcile 静默关掉，不可接受。
- **幂等边界**：reconcile 可重复执行、崩溃重跑无害；不引入超时/轮询。
- **Windows 细节**：任务管理器「禁用」写的是 `StartupApproved` 标志、不动 Run 值；本方案 `enable()` 仅重写 Run 值 → 用户在任务管理器的手动禁用不会被对账覆盖（`is_enabled` 只查 Run 值存在性）。
- 不用超时掩盖同步问题：set 同步返回事实，前端以返回值回显。

## 3. 接口

### 3.1 cap.app.autolaunch（RouterBus 动作式 capability）

- `status` `{}` → `{ supported: bool, enabled: bool|null, exePath: string|null, reason?: string }`
  `supported=false`（web 构建、手机端、`test-profile`、`POLARIS_DATA_ROOT` 隔离）时 `enabled=null` + `reason`；前端据此隐藏开关。
- `set` `{ enabled: bool }` → `{ ok: true, enabled, exePath }`（事实回显）；`supported=false` → error。
- **policy**：本机前端/AI 源默认放行（对照 2026-10-26 审批名单全量停用决策；动作可逆、影响面=一个 HKCU Run 值）。**Remote 源显式 deny**——手机/Web 远端不应能改桌面机的登录行为；按 `policy_permission.rs` 既有 Remote 内置通配 deny 的同款机制追加一条。
- describe 走 `standard_describe`；审计随总线自带。

### 3.2 config 字段

- Rust：`Config` 顶层新增 `#[serde(default)] pub auto_launch: bool`（camelCase → `autoLaunch`，与 `language`/`workDir` 同级同风格，缺省 false 向后兼容）。
- TS：`Config` 顶层 `autoLaunch?: boolean`。
- **`autoLaunch` 不进 `cap.config` 的可写键清单**（`config_capability.rs:137` 区域）——意图唯一写路径是 `cap.app.autolaunch:set`，否则出现第二写路径违反单一权威。若该清单兼作可见键过滤，按其语义做成"可见不可经 cap.config 写"（实现时确认）。
- `AppAutolaunchCapability` 注入与 `ConfigCapability` 同源的 config store Arc（`state.rs:539` 同款），写路径物理收敛。

### 3.3 启动参数

- 插件初始化带参：`tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--minimized"]))`。
- 主窗 builder（`lib.rs:733`）命中 `std::env::args().any(|a| a == "--minimized")` → `.minimized(true)`。仅影响带参启动，用户正常双击行为不变。

## 4. 实施清单（文件级）

**Rust（src-tauri）**
1. `Cargo.toml`：`tauri-plugin-autostart = { version = "2", optional = true }`；`[features]` 加 `autostart = ["dep:tauri-plugin-autostart"]` 并把 dep 加入 `tauri-app` 数组（照 updater/process 的双写法）。
2. `services/autolaunch.rs`（新）：
   - `AutolaunchBackend` trait：`enable / disable / is_enabled / exe_path`（可 mock）。
   - `TauriAutolaunchBackend`（`cfg(feature = "autostart")`）：包 AppHandle + ManagerExt。
   - `reconcile(store, backend)`：读意图 → ensure，tracing 记录纠偏结果。
3. `services/data_root.rs`：新增 `pub fn is_isolated() -> bool`（env override OR `cfg(feature = "test-profile")`）——隔离判定的唯一权威点（沿用 legacy_storage_migrate"模块内部判定"先例，`lib.rs:795`）。
4. `services/router/app_autolaunch_capability.rs`（新）：纯逻辑能力，**不持 AppHandle**（仿 `config_capability.rs:67` 可测性原则），backend 经 trait 注入；`#[cfg(test)]` 用 mock backend 覆盖全动作。
5. `lib.rs`：`.plugin(tauri_plugin_autostart::init(...))` 挂 563 builder 链（`cfg(feature = "autostart")`，与 updater/process 同列同门控）；setup 内装配 backend + `register_handle(AppAutolaunchCapability::new(store_arc, backend))`（仿 583-605 装配点）；主窗 builder 加 `--minimized` 判定；setup 末尾 `tauri::async_runtime::spawn` 一次 reconcile。
6. `models/config.rs`：顶层 `auto_launch` 字段。
7. `services/router/config_capability.rs`：键清单按 §3.2 处理。
8. **治理同步（宪法强制）**：`AGENTS.md` §3.2 cap 清单 + `plans/two-bus-architecture.md` 追加 `cap.app.autolaunch`。

**前端（src）**
9. `types/config.ts`：顶层 `autoLaunch?: boolean`。
10. `services/autolaunchService.ts`（新）：仿 `dataRootService.ts`，router_dispatch → `cap.app.autolaunch`；`status/set` 两方法；cap 不存在 / web 端 dispatch 失败兜底为 `supported=false`。
11. `components/Settings/tabs/GeneralTab.tsx`：新增「开机自动启动」开关行；mount 时 `status()`；`supported=false` 隐藏；toggle → `set` → 以返回事实回显；**刻意不走 `onConfigChange`**（代码注释说明：OS 副作用 + 意图/事实需原子写入，唯一写路径在 cap）。
12. i18n 文案键（`settings` 命名空间，跟随既有 `t()` 结构）。

## 5. 门控与两方向检查

- web-only 构建：该 cap 仅在 tauri setup 注册（web 无 setup）→ web dispatch 未知 cap 报错 → service 兜底隐藏。纯逻辑文件不得引入 tauri 类型，否则 `--no-default-features` 方向挂（宪法 §3.4 双方向陷阱）。
- 门槛命令：`cargo check`；`cargo check --no-default-features --bin polaris-web --bin polaris-mcp`；`cargo clippy --lib` 无新增 warning；`pnpm typecheck`；`pnpm lint`。

## 6. 验收

**机器可证**
- cap 单测（mock backend）：`set` 调用序（config 先、ensure 后）、OS 失败时意图保留且报错、reconcile 三分支（开/关/已一致）幂等、`is_supported` 三分支（正常/test-profile/env 隔离）。
- dev 环境（Polaris-dev 数据根）：经 9829 HTTP dispatch `cap.app.autolaunch status` → `supported=false`（隔离护栏正向证明；dispatch 方法沿用既有 cap.http 测试法）。
- 前端 vitest：service 兜底与 GeneralTab 显隐逻辑（若可测）。

**人工冒烟（正式 release 包，如实记录环境与结果）**
- 开 → `reg query HKCU\...\CurrentVersion\Run` 见 polaris 项且值含 `--minimized`；关 → 项消失。
- 登录/重启 → Polaris 最小化启动；手动双击（无参）→ 正常窗口。
- 任务管理器手动禁用后重启宿主 → Run 值仍在（StartupApproved 未被对账覆盖）。
- 测试包（Polaris-dev MSI）设置页无该开关。

## 7. 风险与不做（显式）

- **卸载残留**：未先关开关即卸载 → Run 键残留（运行时注册方案共性，官方插件亦然）；Windows 对缺失目标静默忽略，仅任务管理器启动项列表挂一条。缓解（WiX `RemoveRegistryValue`）列后续可选，不进本次范围。
- **productName/identifier 同名**（`polaris` / `com.polaris.app` 不区分正式与测试包）：不做双值名改造，靠 `supported=false` 隔离护栏挡住测试包写入。
- **多开**（multi-instance 默认开）不受影响：自启仅拉起单实例，与既有实例身份隔离机制无交集。
- **AI/插件经总线 set**：默认放行（可逆动作，对照 2026-10-26 决策）；未来如需收紧，恢复 `policy_permission.rs` Plugin 源 prompt 名单机制即可，不加新审批 UI。

## 8. 实施阶段与规模

- P1 Rust 核心：1-8（依赖 / backend / capability / reconcile / 门控 / config / 治理同步）。
- P2 前端：9-12。
- P3 验收：单测 + dev 护栏冒烟 + 正式包人工冒烟。
- 规模估计：Rust ~300 行（含测试），前端 ~120 行。

---

## 2026-10-30 实施修订：意图写入改走普通设置流（关键设计变化）

实施时对 config 保存链做全链路核查（前端 configStore/SettingsPage → cap.config →
ConfigStore 落盘），定位出用户反映的「新增配置在设置里保存不成功」的**两类根因**：

1. **SettingsPage `topLevelKeysByTab`（SettingsPage.tsx:86）是每 Tab 硬编码的顶层键
   白名单**：「保存当前分组」只 patch 清单内按键 diff 出的键——新增配置字段若忘记往
   清单加键，分组保存**静默丢弃**该字段（保存并关闭走全键 diff，不受影响，故现象
   时好时坏更隐蔽）。
2. **cap.config 白名单 section（`config_schema()`）对未声明字段直接拒绝**：往
   `performance` 等已纳管 section 加新字段而忘改 schema → patch 报错。顶层自由 key
   则走透传整体替换（无校验，bool 标量安全）。

因此把 §3.2 的设计从「cap.app.autolaunch:set 内部编排写 config + OS」改为：

- **意图（`Config.autoLaunch`）走与其它设置字段完全相同的保存链**：GeneralTab 开关 →
  `onConfigChange` → SettingsPage `buildPatch` diff → `updateConfigPatch({ autoLaunch })`
  → cap.config 顶层透传 → ConfigStore 落盘。**已同步把 `'autoLaunch'` 加入
  `topLevelKeysByTab.general`**（根因 1 的防呆）。
- **cap.app.autolaunch 只有两个动作**：`status`（supported/enabled 事实/configured 意图）
  与 `apply`（读意图 → ensure OS 事实，幂等）。**能力自身零 config 写路径**——
  单一权威比"原子编排"更重要：意图唯一写路径 = 设置流，事实唯一写路径 = backend。
- **OS 同步时机**：configStore.updateConfigPatch 保存成功且 patch 含 autoLaunch →
  fire-and-forget 调 apply（失败仅 log.warn，不阻塞保存；下次启动 reconcile 兜底）。
  取消保存（不点保存）→ 不落意图也不碰 OS，无漂移。与 `syncPerfHotSwitch` 的
  "cap.config 写路径不广播事件、副作用手动补"既有模式同构。
- capability 意图源抽 `AutolaunchIntent` trait（生产 = `StoreIntent` 共享
  ConfigCapability 同一 store Arc；测试 = `FixedIntent`）——因 `ConfigStore::new()`
  触碰真实数据根，单测不构造真实 store。
- 漂移语义不变（§2）：OS 写失败只报错不改意图，方向恒为「意图开/事实关」，启动
  reconcile 自愈。Windows 任务管理器手动禁用（StartupApproved 标志）不被覆盖的结论不变。

落地文件：Rust 侧 `services/autolaunch.rs`、`services/router/app_autolaunch_capability.rs`、
`data_root::is_isolated`、`Config.auto_launch`、lib.rs 三处装配、policy_permission
Remote deny；前端侧 `services/autolaunchService.ts`、`configStore` apply 钩子、
`SettingsPage` 键清单、`GeneralTab` 开关（supported=false 整段隐藏）、`types/config.ts`。

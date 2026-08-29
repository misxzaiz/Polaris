# 新一代插件化通用应用平台 — 架构设计 v1

> 状态：研究定稿
> 定位：**全新重写**（非改造 Polaris），面向「通用能力 + 一切皆插件 + 核心可替换 + 远程控制 + 移动离线」
> 依据：5 轮外部研究（WASM/WIT 插件系统、Local-First/CRDT、ARC 远程控制、MSIX 上线、Zed host-guest）+
>      Polaris 全量工程经验（memory 30+ 条踩坑记录）

---

## 0. 产品定位（一句话）

> **一个「能力操作系统」：无头核心（Core）+ 任意形态前端（Shell）+ 一切皆插件（WASM 组件 + WIT 契约），核心本身也是可替换的插件。** 面向不限领域的通用应用，支持 Web/手机远程控制，手机端离线时仍可用部分功能。

**三条不可违背的第一性原则（从第一行代码遵守）：**
1. **核心不认识任何具体能力**——只认 WIT 契约（`CapabilityId + interface`），会话/权限/调度/存储/引擎全部是实现了契约的插件。
2. **远程是主路，不是旁路**——本地 Shell 与远程 Shell 走完全相同的传输协议。
3. **一切能力皆需授权**——插件默认零权限，一切系统能力（文件/网络/进程/设备）必须经宿主显式授予。

---

## 1. 关键决策：插件载体 = WASM 组件 + 进程隔离双轨

这是本轮研究最重要结论。核心依据是 Zed（`zed-industries/zed`）已生产验证的 host-guest 模型 + tartanllama 的 WASM 组件权威论述。

### 1.1 三种方案对比（为什么不用纯动态库/纯进程）

| 方案 | 安全 | 接口定义 | 二进制兼容 | 判定 |
|---|---|---|---|---|
| 动态库 dlopen | ❌ 与宿主同权限 | ❌ 限 C | ❌ ABI 一致 | 不采用 |
| 纯进程隔离 | ✅ | ✅ | ✅ | 重，仅引擎级用 |
| **WASM 组件** | ✅ 沙箱零权限 | ✅ **WIT 富类型** | ✅ 稳定跨语言 | **通用插件主选** |

### 1.2 双轨模型（新项目最大架构决策）

```
┌────────────────────────── 宿主 Host (Rust, Wasmtime) ──────────────────────────┐
│  capability_granter ── 按插件声明授权（WIT import 白名单 + 权限策略）            │
│  WasmHost ── 加载 .wasm 组件，按 manifest 声明选择 WIT 版本                       │
└───────────┬───────────────────────────────────────┬────────────────────────────┘
     轨道 A：WASM 组件（通用能力插件）        轨道 B：受控子进程（系统级引擎插件）
     · 文件/网络/设备全走宿主 WIT host API   · 直接访问本机 CLI/终端/进程
     · 默认零权限，逐项授权                 · 独立进程隔离，异常/崩溃不拖垮宿主
     · 语言无关（Rust/C/JS 都能编译）       · 通过同一套 WIT 契约暴露给上层
```

**为什么需要双轨**：纯 WASM 沙箱对「直接操作本机任意文件/进程」的插件（如 AI 引擎调 CLI、终端、桌面自动化）不友好。引擎类插件走进程隔离，通用插件走 WASM，**两者对外统一为 WIT 契约**，上层无感。

**工程化参考（Zed 已验证的细节）：**
- 目标：Rust → `wasm32-wasip2`，用 `wit-bindgen` 生成绑定
- 运行时：`wasmtime`，按插件 manifest 声明的 API 版本选 `Linker`
- **WIT 版本化**：`since_v0.1.0 ... since_v0.8.0` 多版本并存，向后兼容旧插件（Zed 实践，直接采用）
- 打包：插件 = `manifest.json + 编译产物(.wasm) + 资源`，archive 分发
- **capability_granter**：Zed 有独立的授权模块，这是「权限自由涉及」的落地机制，直接对应

### 1.3 核心可替换如何实现

> 核心不是一段代码，而是一组 WIT 契约。默认「核心插件」实现这些契约；换核心 = 换实现同一契约的另一个组件。

```
Bootstrap（唯一不可替换的薄壳，~几百行）
  └─ 加载插件 + 能力注册表 + 插件间总线
        ├── 核心契约（WIT）：plugin / capability / permission / session / scheduler / storage
        │     └── 默认核心插件（可替换）
        └── 功能插件（shell/fs/ai/network/ui…）
```

**防过度设计原则**：核心契约先只定 6 个（见 §3），其余全部后置。

---

## 2. 远程控制（手机遥控）— ARC Relay 三段式

参考 `axolotl-ai-cloud/arc` 已验证模型。远程控制做成**一个 Relay 插件**，不是桌面 App 内建逻辑。

```
Core(你的Agent) ──WS──► Relay Server ──WS──► Web/手机 Viewer
  · 推 trace             · 中继             · 实时看工具调用/消息/状态
  · 收命令               · 鉴权/限流         · 发消息/批准拒绝工具调用
```

**安全模型（ARC 6 条 + Polaris 教训修正）：**
| 项 | 措施 |
|---|---|
| Agent token | 注册会话，防未授权接入 |
| Session secret | 每会话生成，viewer 订阅凭证，仅分享可信方 |
| 角色隔离 | viewer 不能发 trace，agent 不能发命令 |
| 限流 | HTTP 60/min + WS 120 msg/min |
| TLS | 生产强制（`REQUIRE_TLS=true`），可选双向认证 |
| 审计 | 全程记录远程操作（Polaris 缺失项，必须补） |

**移动端 App 本身也是「一个迷你 Core + 插件子集」**（见 §4），在线连远程 Core，离线跑本地子集——同一套代码不同装配。

---

## 3. 核心契约草案（WIT）

先冻结这 6 个接口，其余后置。这是整个系统的骨架，**先评审再写实现**。

```wit
// world 插件：通用插件必须实现的导出
interface plugin {
    init: func(host: borrow<host>) -> result;
    name: func() -> string;
    version: func() -> string;
    capabilities: func() -> list<string>;   // 声明提供的能力 id
    required-permissions: func() -> list<permission-request>; // 声明需要的权限
}

// host 能力：宿主向插件提供（能力授权白名单）
interface host {
    capability: func(store: borrow<capability-store>, id: string) -> result<handle>;
    log: func(level: u32, msg: string);
}

// 权限模型（通用，不只 AI）
interface permission {
    record request { capability: string; resource: string; source: string; }
    // source: local | remote，远程操作须更高权限 + 审批
}

interface capability-store {
    get: func(id: string) -> result<capability-handle>;
    list: func() -> list<string>;
}

interface session { /* 会话生命周期，引擎无关 */ }
interface scheduler { /* 任务调度 */ }
interface storage { /* 统一持久化，插件可替换后端 */ }
```

**权限 = 能力 × 资源范围 × 来源(本地/远程) × 用户/设备**。手机遥控发来的操作自动判为「远程 + 需审批」。

---

## 4. 移动离线（Local-First）

参考 sujeet.pro 的 Offline-First 架构 + Kleppmann《Local-first software》。

| 模式 | 存储 | 同步 | 冲突解决 |
|---|---|---|---|
| 在线 | 连远程 Core（全功能） | 实时 WS | — |
| 离线 | IndexedDB + OPFS 本地优先 | 后台同步队列 | CRDT |

**选型**：
- 文本/结构化：**Yjs**（~27KB gzip 最轻）或 **Automerge 2**（Rust 核心转 WASM ~200KB）
- 大文件/二进制：**OPFS**（Worker 内同步读写）
- 一致性：**HLC 混合逻辑时钟**

**必须避开的坑（研究确认）**：
- ⚠️ **Safari 7 天驱逐**：纯 PWA 数据会被清空 → **手机离线功能必须用原生 App 壳（Tauri/APK），不用纯 PWA**
- ⚠️ 不信任 `navigator.onLine`，用真实 `/health` HEAD 探测
- ⚠️ IndexedDB 事务自动提交坑（await 间隙丢事务）
- ⚠️ `navigator.storage.persist()` 在 Safari 是 no-op

---

## 5. 上线基础要求（MVP 到发布门槛）

### 5.1 打包签名（桌面）
- **MSIX** 最安全现代；未签名被 SmartScreen 拦截
- 两条路：Microsoft Store（免首启警告，需签名证书）/ 自签名旁加载（便宜但有警告）
- 移动端：APK Android 签名，上架 Google Play / 国产商店

### 5.2 远程上线安全门槛（必做）
- token **默认开启**（修正 Polaris 默认关的教训）
- 生产强制 TLS + 可选双向认证
- 审计日志全程
- 限流 + 会话 TTL（ARC 的 `SESSION_TTL_HOURS=24` 借鉴）

### 5.3 自动更新
- Tauri 内置 updater + 签名；插件独立版本 + WIT 版本协商（Zed 版本化实践）

---

## 6. 技术选型总表

| 层 | 推荐 | 依据 |
|---|---|---|
| 插件载体 | WASM 组件(Wasmtime, wasm32-wasip2) + 引擎进程隔离 | Zed/tartanllama 验证 |
| 契约语言 | WIT（版本化） | 富类型、版本协商、天然可替换 |
| 远程协议 | WebSocket + JSON-RPC，Agent↔Relay↔Viewer | ARC 验证 |
| 离线存储 | IndexedDB + OPFS + CRDT(Yjs/Automerge) + HLC | Local-First 成熟方案 |
| 手机壳 | 原生 Tauri/APK（非纯 PWA） | 规避 Safari 驱逐 |
| 桌面分发 | MSIX + Store / 自签名 + 自动更新 | 上线安全门槛 |
| 核心语言 | Rust (Tokio + Wasmtime) | 性能 + 安全 + 复用生态 |

---

## 7. 落地路径（分阶段，不写 UI 先行）

- **Phase 0 — 契约 + Bootstrap**：定 6 个核心 WIT 契约 + 薄壳（加载插件/注册表/总线）+ 一个 demo WASM 插件。验证「Core 不认识任何能力也能跑」。
- **Phase 1 — 远程最小闭环**：WS 传输 + token 鉴权 + 事件推送 + 一个 Web Shell（会话列表→发起→流式→触发一个工具调用）。**这是「遥控」的生死线。**
- **Phase 2 — 桌面/移动 Shell**：Tauri 桌面壳 + 原生 APK，全部复用 Phase 1 协议。
- **Phase 3 — 移动离线**：同一 Core 的迷你装配 + CRDT 同步（Safari 驱逐规避用原生壳）。
- **Phase 4 — 插件生态 + 上线**：把 Polaris 的 28 个插件按 WIT 契约迁移；MSIX 签名 + Store + 自动更新 + 审计。

**建议 MVP 范围**：无头 Core + WASM 插件加载 + 一个 demo 插件 + 一个远程 Shell 最小闭环。其余全部后置。

---

## 8. 风险与关键决策点

1. **WASM vs 原生引擎两难** → 已定双轨（§1.2）。这是最大架构决策，需在 Phase 0 验证双轨都能跑通。
2. **「核心可替换」别过度设计** → 核心契约只定 6 个，先跑通默认实现再谈替换。
3. **离线功能别首版做** → 先在桌面把 Core + WASM 插件 + 契约跑通，离线是 Phase 3。
4. **范围控制** → MVP 只做四件事（§7 MVP），避免重蹈 Polaris 功能大而全的坑。
5. **WIT 契约冻结前多评审** → 接口决定整个骨架，先评审再写实现。

---

## 9. 生产级补充：插件生命周期健壮性（补充定稿）

在 Phase 0 之后、上线之前，必须补齐以下三项。它们是把「能跑」升级为「能上生产」的分水岭。

### 9.1 插件热启动 / 热更新（Hot Reload）

**目标**：安装/升级/替换插件不重启宿主、不中断正在运行的会话。

```
宿主运行中
  ├─ 文件监视器(watch plugin 目录)
  ├─ 版本/哈希变化 → 触发 reload
  ├─ 新组件实例化(新 WasmHost/新子进程)
  ├─ 迁移状态(会话/存储从旧实例导出→导入新实例)
  ├─ 原子切换注册表指针(旧实例 drain 后释放)
  └─ 失败 → 回滚到旧实例(保留现场)
```

**设计要点**：
- 插件 manifest 增加 `api-version`（WIT 版本协商）+ `content-hash`（变更检测）。
- **WIT 版本化天然支持热更新**：不同版本组件并存（Zed 的 `since_v0.x` 实践），旧插件用旧 Linker，新插件用新 Linker。
- 引擎级(进程)插件热更新 = 优雅重启子进程，replay 会话状态。
- 回滚策略：新实例初始化失败 → 保持旧实例运行并上报，不丢会话。
- 能力注册表需支持**原子的「替换提供者」**（`swap_provider`），避免热更新瞬间的竞态。

### 9.2 开发 / 生产环境隔离（Dev vs Prod Isolation）

**目标**：开发态可自由调试、加载本地/未签名插件；生产态只允许可信、签名、已验证的插件。

| 维度 | Dev | Prod |
|---|---|---|
| 插件来源 | 本地目录、允许未签名 | 签名 + 哈希校验 + 来源白名单 |
| 能力授权 | 宽松（远程也可放行/调试） | 严格（远程必审批 + 审计） |
| 日志 | 全量 trace | 脱敏 + 审计 |
| 失败处理 | 崩溃即停便于定位 | 兜底 + 降级 + 告警 |
| 打包 | dev 构建不签名 | MSIX 签名 + 自动更新 |
| 遥测 | 关闭 | 可选开启（脱敏） |

**落地机制**：
- 运行时显式 `profile: dev | prod`，由一个 `IsolationPolicy` 插件驱动（它本身也是插件，可替换）。
- 生产侧所有外部能力（网络/文件/进程/设备）都需**签名清单**背书，未签名插件默认拒绝。
- 状态存储隔离：dev 用 `data/dev`，prod 用 `data/prod`，互不污染。

### 9.3 插件异常兜底（Crash Containment / Fallback）

**目标**：任何单个插件崩溃/死循环/资源耗尽，都不拖垮宿主和其他插件。

**分层防线（由内到外）：**
1. **WASM 沙箱天然隔离**：内存/CPU 受限（wasmtime 配置 `max_memory`、fuel/epoch 中断防死循环）。这是第一道墙。
2. **宿主侧 watchdog**：监测插件心跳/超时，超时则终止该插件实例。
3. **能力调用兜底**：宿主对插件的能力调用包 try/catch + 默认值/降级响应，不让错误冒泡到 UI。
4. **错误分类**：可恢复(重试) / 可降级(返回降级结果) / 致命(卸载该插件 + 告警)，三级路由。
5. **进程级插件**：独立子进程，崩溃自动重启（带退避），异常不拖垮宿主。
6. **审计 + 上报**：所有兜底触发记录到审计日志。

```
[插件 A 崩溃] → ①WASM 沙箱拦截(内存/CPU) → ②watchdog 超时
   → ③能力调用降级 → ④致命则卸载A + 告警 → ⑤宿主与其他插件继续运行
```

**验证**：Phase 0 需加一个「恶意/有 bug 的 demo 插件」测试，证明其崩溃不影响宿主和其它插件。

---

## 10. Phase 0 复审结论（2026-08-27）

对 Phase 0 骨架做了严格自我复审，发现并修复 8 个真实问题（非粉饰）：

| # | 问题 | 严重度 | 修复 |
|---|---|---|---|
| 1 | 权限「本地沾光远程」漏洞：本地授权一次后远程永久放行 | 高(安全) | 拆本地/远程双独立 gate，`allow_remote()` 显式预授权 |
| 2 | hot_reload 假回滚：先覆盖旧 manifest 再互覆状态，失败时旧状态已污染 | 高 | 能力差集预检 + 单一 write 锁原子替换，失败零污染 |
| 3 | hot_reload 能力残留：旧能力未解除留幽灵 | 中 | `unregister_many` 精确解除 `old−new` 差集 |
| 4 | 全部 `.unwrap()` 锁中毒 panic | 中 | 换 `parking_lot`，消灭 PoisonError 路径 |
| 5 | Bootstrap 无容错：插件目录不存在即整个进程 Err 退出 | 中 | 目录缺失/单插件解析失败均降级继续 |
| 6 | 死依赖 `wasmtime=17` 编译 2 分钟零使用，无真实 WASM 执行链路 | 高(马虎) | 移除依赖，标注真实组件接入路径；demo-plugin 诚实标注 |
| 7 | WIT 语法错误：interface 不能 borrow、未定义类型 | 中 | 重写 plugin.wit / runtime.wit 为合法 WIT |
| 8 | demo-plugin 误导 ABI 骨架：手写 `#[no_mangle]` 宿主从不调用 | 中 | 重写为纯逻辑库 + 诚实文档 |

**复审后测试基线**：host 22 测试 + demo-plugin 3 测试，全绿 0 警告。

**遗留（下一阶段）**：
- 真实 WASM 组件实例化链路（wasm32-wasip2 + wit-bindgen 工具链未装）
- 引擎级插件进程隔离的 watchdog 真实实现（当前为状态机骨架）
- 传输层（Phase 1 远程闭环）

---

## 11. Phase 1+2 实施进度（2026-08-27）

### Phase 1 远程最小闭环（已交付）
- `src/transport/`：WS 传输 + token 鉴权 + 事件广播 + CmdHandler 插件式命令路由 + Web Shell
- 见 memory `new-app-phase1-remote-loop`：37 测试全绿

### Phase 2 WASM 组件宿主实例化（已交付，关键突破）
- **工具链**：wasm-tools + wit-bindgen-cli + wasm32-wasip2 target 全部装成
- **WIT 契约通过 wasm-tools 校验**（修 5 类语法错误：record 顶层/保留字 resource/list/stream/package 注释/result<tuple>）
- **demo-plugin 编译为真实 WASM 组件**（WASI 0.2.6，必须 `export!(Plugin)` 否则组件缺导出）
- **宿主完整实例化并调用导出**（wasmtime 45 匹配 WASI 0.2.6）
- **Runtime↔WASM 桥**：manifest→artifact→实例化→probe→能力对齐校验→注册
- **测试基线：43 全绿**（40 单元 + 3 集成），0 警告

**版本选择教训**：wasmtime 17=0.2.0、28=0.2.2、33=0.2.3 都不匹配组件 WASI 0.2.6；48 需 rustc 1.95；**45 精确匹配且兼容 rustc 1.93**。

### Phase 2.5 插件化加固（健康检查后实施）
- **WIT 加 `invoke` 执行接口**（`invoke(capability, params) -> result<string>`），插件能力可被真实调用
- **Runtime 持有已加载实例**：`loaded` + `attach_plugin` + `invoke_capability`（带权限裁决）
- **权限与执行打通**：远程未预授权拒绝 / 本地成功 / 预授权后远程成功
- **去臃肿**：删死代码（test_probe_dir/register_many/allow_unsigned）
- `with_profile` 统一返回 Arc；`host_state` 接 `PluginInvokeCmd`（WS `plugin.invoke` 命令）
- **测试基线：45 全绿**（42 单元 + 3 集成），0 警告
- 遗留（诚实）：hot_reload/on_plugin_crash/unload 状态机仍无生产驱动（需文件监视器/watchdog，后续阶段）

---

## 附：外部研究来源
- WASM 组件插件系统：tartanllama.xyz/posts/wasm-plugins（Sy Brand, 2025）
- Local-First/CRDT：sujeet.pro/articles/offline-first-architecture；Kleppmann《Local-first software》(Ink & Switch 2019)
- 远程控制：github.com/axolotl-ai-cloud/arc（ARC Relay）
- 插件 host-guest 先例：deepwiki.com/zed-industries/zed（WASM Extension API / capability_granter / WIT 版本化）
- 上线打包：learn.microsoft.com MSIX / Windows 应用发布

## 附：Polaris 经验映射（避免重蹈）
| Polaris 坑 | 新项目对策 |
|---|---|
| 引擎硬编码 + 双 EngineId | Core 从第一天就不认识任何引擎 |
| web-only-tauri-command-gate | Core 无头，与 UI 框架零耦合 |
| http/tauri 双传输后补 | 传输协议先行、插件化 |
| 插件卸载进程清理 | 进程生命周期 Core 原生管理 |
| token 默认关 | 安全默认开启 |

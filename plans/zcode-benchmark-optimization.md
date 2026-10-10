# ZCode 对标：Polaris 可优化点分析

> 状态：完整稿（四维度深度分析 + 现状核查已完成）
> 对照基准：`D:\space\base\Polaris\temp\ZCode`（AI 编程工作台 monorepo，v3.14.3，Electron + Web + Agent CLI/运行时）
> 生成方式：3 个并行 Explore 代理深度分析 ZCode 源（架构设计/服务端远程/Agent 运行时）+ 直接核查 Polaris 现状

## 背景

ZCode 是与 Polaris 同类的 AI 编程工作台，其工程治理体系（架构策略强制、受控上下文、spec 先行）明显比 Polaris 成熟。本文以 ZCode 为参照，结合 Polaris 现状（`src/` 前端 + `src-tauri/` Rust + `sky/` Node Core），给出可落地的优化点清单。

---

## 一、工程治理（最高杠杆，最易落地）

### 现状
- Polaris `package.json` scripts 仅：dev / build / tauri:* / test / lint / security:audit。
- **无 `typecheck` 脚本**（CI 里 `tsc --noEmit` 是唯一的类型门槛，本地无法一键跑）。
- **无 knip**（未使用依赖/导出检测）。
- **无 architecture-check**（依赖图/循环/深度/行数/公开方法数强制）。
- 无 `.husky` / lint-staged（提交前无门禁，CI 才跑 lint）。
- eslint 单一配置，`src-tauri/**` 整体 ignore（Rust 侧无 clippy 门槛）。

### ZCode 参照
- `scripts/architecture/architecture-check.mjs`：读 `architecture-policy.yaml`，检查 **maxFileLines(400) / maxContractLines(300) / maxPublicMethods(12) / layerOrder / forbidCycles / forbidDeepImports / managedOnly**，支持 `--changed`（只查变更文件）、`baseline`（容忍存量违规）、`context`（生成受控上下文）、退出码 1 阻断。
- `verify:pre-push` = lint + architecture:check --changed。
- 强制 `pnpm typecheck`（tsc -b 多包）+ `pnpm lint`，报告真实结果。
- knip 检测未使用依赖与导出。

### 建议（Polaris 可移植）
1. **加 `typecheck` script**：`tsc --noEmit`（前端）+ `cargo check`（Rust，见记忆 `rust-lib-test-env-limit.md`：本机 cargo test --lib 无法启动，用 check）。纳入 CI 与 `verify:pre-push`。
2. **引入轻量 architecture-check**：参照 ZCode 脚本，先做 maxFileLines 检测（Polaris 现有 browser.rs 3977 行、createConversationStore.ts 2535 行、ai_chat_core.rs 2547 行、ChatInput.tsx 2010 行），用 baseline 容忍存量、只查 `--changed`，渐进收紧。
3. **加 husky + lint-staged**：commit 前跑 eslint（仅暂存文件）。
4. **补 knip**：清理未使用导出/死依赖。
5. **Rust 侧**：CI 加 `cargo clippy -- -D warnings`（当前 CI 只 build，无静态检查）。

---

## 二、命令层 → cap 总线迁移未完（架构半迁移态）

### 现状
- `src-tauri/src/commands/` 仍有 40+ 文件（browser.rs 3977 行、dispatch.rs、nexus.rs、agent_corpus.rs、terminal.rs 等）。
- RouterBus 已建（`services/router/mod.rs`），`cap.data_root`/`cap.todo`/`cap.http`/`cap.bash` 等已上总线，权限 gate + 审计已通。
- 但大量命令仍走旧 tauri command 路径；`cap.form`（sky 有）主进程 RouterBus 未见装配；bus_dispatch 白名单仅 4 域（todo/http/bash/fs）。
- 前端 `dataRootService.ts` 是"命令层→总线"迁移的样板：业务签名不变、内部改走 RouterBus，获得统一权限 gate + 审计。

### 建议
- 排优先级，把高频命令（browser/terminal/dispatch）迁上 RouterBus，每迁一个砍一个旧命令。
- 补 `cap.form` 主进程装配，扩大 bus_dispatch 白名单（按管理面/普通面分级放开，参照 `form_flow.rs` 的 target_allowed 表）。
- 以 dataRootService 为范式，确立"业务层签名不变、内部走总线"的迁移模板。

---

## 三、巨型文件与状态层治理

### 现状
- `src/stores/` 约 60 个 Zustand store 平铺，`conversationStore/` 目录 3MB（createConversationStore.ts 2535 行）。
- Rust 侧 browser.rs 3977 行、ai_chat_core.rs 2547 行、ask_listener.rs 2384 行、plugin_service.rs 2046 行。
- vitest 覆盖率阈值只 `include: ['src/stores/eventChatStore/**/*.ts']`（只查一个目录）。

### ZCode 参照
- `architecture-policy.yaml` 强制 `maxFileLines: 400`，契约类 `maxContractLines: 300`，公开方法 `maxPublicMethods: 12`。
- ui 层通过 `packages/ui/src/hooks/` 访问服务，store 集中在 `ui/src/store/`，有分层。

### 建议
- 用 architecture-check 的 maxFileLines 逼出拆分清单，逐个拆（优先 conversationStore / browser.rs）。
- 覆盖率阈值放宽到全仓（或至少核心目录组），让测试治理有实际约束力。

---

## 四、启动性能（已分析未修复，见记忆 startup-performance-analysis.md）

### 待修清单（记忆已钉死）
1. health_check 同步串行 spawn 5 子进程（pi 3.6s 首因）→ 改异步+并行+缓存。
2. 假进度蒙板（ConnectingOverlay 固定 interval，与真实进度零关联）→ 改真实阶段进度。
3. 前端首帧 6.4MB（mermaid-core 静态引入 + Chat barrel 静态拉 444 模块 + i18n 36 JSON 内联）→ 真懒加载 + 拆 barrel。
4. Google Fonts 依赖外网 ~0.5s 固定阻塞 → 自托管。
5. HTTP_TIMEOUT_MS=600s → 网络故障可挂 10 分钟，需降。

### 建议
- 作为独立工作项，按收益排序执行；验证必须用 release 构建（dev 数字无参考意义）。

---

## 五、协议层：运行时校验缺失

### 现状
- 前后端 AIEvent/Task 类型已对齐（`ai_event.rs` ↔ `event.ts`，camelCase），设计良好。
- 但**无运行时 schema 校验**（zod/valibot/JSON Schema）——字段漂移时静默出错，无快速失败。

### ZCode 参照
- `packages/shared/src/zcode-protocol/index.ts`：协议改动同步更新，提供**严格类型 + 运行时校验**。

### 建议
- 为跨进程事件（AIEvent、RouterDispatchResponse、cap 总线 payload）加轻量运行时校验层，至少校验关键必填字段与枚举，防前后端漂移。

---

## 六、远程身份与持久化：workspaceKey 单一隔离键（可借鉴）

### ZCode 做法（高参考价值）
- **身份与路径分离**：`workspaceIdentity`（远程权威身份，如 `remote:ssh:<host>:<port>:<user>:<posixPath>`）与 `workspacePath`（远端绝对路径）分开；`resolveWorkspaceKey = workspaceIdentity?.trim() || workspacePath` 为唯一隔离键（SQLite 主键、认证作用域、去重键）。**同一物理目录经不同 host 打开 = 不同任务列表**。
- **单权威 + 被动观察者持久化**：写路径收敛到 `taskIndexRepo.enqueueWrite`（per-task 串行化写入链），杜绝多条写入路径竞争；必填 `broadcastReason` 区分「归属变更/纯配置/标题」，避免标题高频更新触发列表整刷；未读走 CAS 式保留。
- **恢复语义**：ACK-only 承认 + 首帧原子 apply 后才把水位当 resume base；暂存超限标记 recovery-needed 而非丢帧；每个 topic 独立记账 logEpoch/seq。
- **双级信任部署**：loopback = 无认证可信；对外 = token / TTL 一次性 host capability（未消费过期，抗泄漏累积）。
- **附件事务化**：强制 begin/chunk/commit/abort + 逐 request 大小证明 + 按 row 授权读。

### Polaris 现状与建议
- Polaris 已有 `session-v2` Reconcile（对账：日志即真相、前端只是缓存）——与 ZCode「CLI 权威投影」思想一致，方向正确。
- **可落地**：把 workspace 身份/路径分离与单一隔离键规则引入 Polaris 的远程/多 workspace 状态（`workspaceStore`），防止多路径写竞争。
- **可落地**：广播事件必填 reason 并分类，避免「输入框操作引发整刷」（Polaris 会话历史列表有同类性能风险，见记忆 session-history-performance-preview）。

## 七、服务分层与日志体系（规范级借鉴）

### ZCode 做法
- UI 只经 `hooks/` 访问服务（`useServices` → `IServiceAccessor` 聚合 ~40 个服务），平台能力只经 `usePlatform` → `IPlatformService`；**UI 禁止直连服务实现 / Repo / Runtime 实现细节**。
- 服务注册：`ServiceCollection.register/get`，按 channelName `exposeOnChannelServer`，ProxyChannel 镜像。
- 日志分级：`createServiceLogger(scope, {pid, sink, isDebugEnabled})`；**debug 生产不落盘**（门控），warn 限频，stdio 模式日志走 stderr（stdout 专用于 RPC 数据）。

### Polaris 现状与建议
- Polaris 前端约 60 个 store 平铺，组件部分直连 store/services，**无 hooks 访问层的强制边界**。建议参照 ZCode 引入 `useServices` 类 hooks 门面（成本中等）。
- Polaris 有 `utils/logger`，但缺「debug 生产不落盘」「warn 限频」的强制分级。建议补。

## 八、协议运行时校验 + 版本化（可借鉴）

### ZCode 做法
- `zcode-protocol` 用 **Zod 运行时校验**（discriminatedUnion + strict + superRefine 交叉校验），版本化（ZCODE_PROTOCOL_VERSION），显式删词治理（dead 词连根删、消费者清单）。
- clientMode（desktop-continuous / web-remote-replayable）握手期强制与 deliveryProfile 一致。

### Polaris 现状与建议
- Polaris AIEvent/Task 前后端类型已对齐但**无运行时校验**。建议为跨进程事件加轻量 schema 校验（不必全量 Zod，可先做关键枚举 + 必填字段）。
- Polaris 的「desktop-continuous」等价物是 `session-v2` 实时链路，远程/移动端恢复链路（记忆 polaris-mobile-android、sky）建议明确区分 delivery 语义。

## 九、Agent 会话协议 / 中断机制（待最后一个代理补全）

（占位——Agent 运行时代理分析中）

---

## 九、Agent 运行时：命令准入 / 中断 / 幂等（高价值护栏）

### ZCode 做法（apps/zcode-cli 核心亮点）
- **CommandInbox 串行准入**（`command-inbox.ts`）：per-command 幂等键 gate + per-session FIFO async gate（持锁直到 settle 写最终 ACK）+ 递增 admissionSeq + settled LRU 512/session。重复提交返回 `duplicate`（failed 保持 failed 不翻盘）。
- **运行时忙闲双门**（`prompt-admission.ts`）：busy = hasActiveOrQueuedTurnWork；busy+requireIdle → rejected，可 steer → 原地接管当前轮，否则排队；idle → reserveTurnStart。**客户端绝不猜测队列状态，全部以服务端事件/投影为唯一事实源**（reorder/sendQueuedNow 均由服务端权威标记）。
- **stop 安全护栏**：stop payload 带 `expectedForegroundExecutionId` 拒绝"晚到 Stop"误杀无关运行；idempotency key + expected id 双校验。
- **Owner/lease 路由**：`windowHostTaskAddress {remoteSessionId?, workspacePath, workspaceIdentity?}`（remote 必须有 identity），按 workspace 归属路由任务；一任务一 owner，`owned_by_other_host` 拒绝。
- **cap 上限常量表** `PROTOCOL_V4_LIMITS`：物理帧 1MiB / 逻辑帧 16MiB / 订阅缓冲 500 op+1MiB / 每会话事件留存 2000 / 附件 20MiB 块 512KiB——每个带中文注释踩坑记录。
- **超时分层**：逻辑帧 30s / 事件提交 25s / 查询 10s / 附件 TTL 30s。
- **流式工具组装**：`streaming-tool-call-assembler` 保证流式中断不产生半截工具调用。
- **错误归一化**：命令错误统一归一为 typed `reasonCode`，边界层不杂糅原始异常。

### Polaris 现状与建议
- Polaris AIEngine 接口设计合理（能力声明、流式、中断），session-v2 有 Reconcile 对账机制，方向正确。
- **缺失护栏**（对照 ZCode，按价值排序）：
  1. **stop 的 expected id / 幂等键**：防止晚到中断误杀无关会话运行（记忆 `ai-chat-interrupt-continue-root-cause`、`simpleai-interrupt-bug-confirmed` 已实证中断链路问题——这正是可借鉴 ZCode 的地方）。
  2. **串行准入 + 幂等表**：AI 任务提交目前缺 CommandInbox 式 FIFO 门与幂等去重。
  3. **超时分层**：记忆 `HTTP_TIMEOUT_MS=600s` 已指出单一大超时问题；建议按操作类型分档（对齐 ZCode 10s/25s/30s/5min）。
  4. **owner/lease**：Polaris 多实例/多端（multi-instance、mobile）时，任务所有权仲裁缺失，跨端同任务双驱动有竞态风险。

## 建议执行顺序（按 收益/成本）

| 优先级 | 工作项 | 收益 | 成本 |
|---|---|---|---|
| P0 | typecheck + cargo check 进 CI 与本地 | 类型安全兜底 | 低 |
| P0 | 启动性能修复（health_check 异步化 + 蒙板真实进度） | 首屏 1.5-5s→<1s | 中 |
| P1 | 轻量 architecture-check（maxFileLines + --changed baseline） | 防巨型文件恶化 | 中 |
| P1 | husky + lint-staged + knip | 提交前门禁 | 低 |
| P1 | 广播事件必填 reason + 分类（照搬 ZCode） | 防列表整刷性能事故 | 中 |
| P2 | 中断安全护栏（stop expected id + 幂等键，照搬 ZCode） | 防误杀/中断失效 | 中 |
| P2 | 命令层→cap 总线继续迁移 | 统一权限/审计 | 高 |
| P2 | 协议运行时校验层 | 防漂移 | 中 |
| P2 | 日志分级强制（debug 不落盘 / warn 限频） | 存储与可读性 | 低 |
| P3 | 巨型 store/文件拆分 | 可维护性 | 高 |
| P3 | UI hooks 访问层门面（useServices 类） | 隔离边界 | 高 |
| P3 | 远程身份 workspaceKey 单一隔离键 | 多端一致性 | 高 |

## 结论

ZCode 的核心优势不在功能多，而在**可执行的架构治理**：唯一事实源（architecture-policy.yaml）+ 受控上下文 + spec 先行 + 协议运行时校验 + 单权威持久化。Polaris 的功能面（cap 总线、session-v2、AI 事件协议）已在追赶，最缺的是**把规范变成脚本/门槛**（typecheck、architecture-check、husky、knip、日志分级）与**把存量巨型文件/平铺 store 纳入治理**。

建议以 P0+P1 起步（1-2 周），先立门槛，再逐步迁移命令与拆文件，避免治理工具一上来就满屏违规导致弃用。

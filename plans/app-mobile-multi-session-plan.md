# App 端体验对齐实施方案

> 目标：把 Polaris App 从“可连接的 companion 骨架”提升到“接近 Web 的多会话聊天主路径体验”。  
> 约束：保持 mobile companion 定位，不做桌面 IDE 全量压缩。  
> 优先级锚点：**多窗口对话必须可用**。

---

## 实施状态（2026-07-12）

### 产品决策更新（同日晚）

用户确认：**手机浏览器上完整 Web 体验已足够好，APK 应直接复用 Web `App`**，不再默认进入独立 `MobileApp` companion 壳。

| 入口 | UI |
|------|-----|
| 手机浏览器访问 polaris-web | 完整 `App`（compact） |
| **APK** | 完整 `App` + `MobileConnectionGate`（仅配服务地址/Token） |
| `?mobile=1` | 旧 `MobileApp` 壳（调试保留） |

代码：`platform.shouldRenderMobileApp()` 仅 `?mobile=1` 为 true；`main.tsx` 对 mobile Tauri 包一层 ConnectionGate。

### Phase 1 — 已落地（companion 壳路径，现为可选调试）

- `src/mobile/runtime/*` 多会话 Runtime（旧壳仍可用）
- React #185 selectTabSessions 缓存修复

### 后续（在「复用 Web」路线下）

- APK 首次连接 / Token 体验打磨（Gate 与 Web ConnectingOverlay 衔接）
- 小屏 Web compact 体验回归（APK WebView 视口、safe-area）
- 旧 MobileApp / Runtime 代码可择机归档或删除
- 不再以「把 companion 做成第二套聊天」为主线

---


## 0. 结论摘要

| 问题 | 结论 |
|------|------|
| App 为何弱于 Web | 独立移动壳能力浅；会话只有 Tab 切换，无真并行 Runtime |
| 能否迁全部 Web 功能 | 否。聊天主链路可迁；文件/LSP/终端/Git/插件安装不应迁 |
| 多窗口怎么做 | 不做桌面网格；做 **Tab + 全局 SessionRuntime 并行收事件** |
| 推荐路径 | 先 Runtime 并行，再补齐会话闭环，再做渲染与设置 |

**一句话策略：**

> 复用桌面的“事件路由 + 多会话状态”思想，不复用桌面 `MultiSessionGrid` UI；在 `src/mobile/` 内建设轻量 `MobileSessionRuntime`，把现有 Tab 骨架升级为真多会话。

---

## 1. 产品边界

### 1.1 In Scope（本方案必须交付）

1. **多会话并行**
   - 最多 8 个钉住 Tab
   - 非激活会话持续收 WS 事件
   - Tab 显示 running / waiting / error 状态
2. **会话闭环**
   - 列表续接
   - 新建会话
   - 发送 / 中断
   - Question / Plan / Permission 处理
3. **引擎覆盖**
   - 列表与续接覆盖：`claude-code` / `codex` / `simple-ai` / `mimo`
4. **连接与恢复**
   - 断线重连后对活跃 + 运行中会话做 history resync
5. **轻量设置**
   - 连接设置（已有）
   - 主题 / 默认引擎只读或轻改

### 1.2 Out of Scope（明确不做）

| 能力 | 原因 |
|------|------|
| 文件编辑 / LSP / Diff 大盘 | 手机交互与依赖体积不适合 |
| 终端 / Spring Boot 调试 | 依赖本机 PTY 与桌面布局 |
| 复杂 Git 工作流 | companion 只读状态即可 |
| 插件安装/卸载 | 管理面应在桌面 |
| 桌面式多会话网格并排 | 手机屏 ROI 低，体验差 |
| 完整设置中心 | 后置，不阻塞主路径 |

UI 原则：不可用能力显示“需在桌面端操作”，禁止静默 404。

---

## 2. 现状与根因

### 2.1 现状能力

```text
MobileApp
 └─ MobileConnectionGate
     └─ MobileShell（会话/任务/工作区/设置）
         └─ MobileSessions
              ├─ MobileSessionTabs（Tab 条，最多 8）
              ├─ MobileSessionList（仅 claude-code + codex）
              └─ MobileChatSession（仅 active 挂载）
                   ├─ 组件内 listen('chat-event')
                   └─ 卸载时 unlisten + persist 到 Map 缓存
```

### 2.2 根因

1. **事件监听绑在 UI 生命周期**  
   切走 Tab 即 `unlisten` → 后台会话事件丢失。
2. **无统一 Runtime**  
   只有 `mobileMultiSessionStore`（Tab 列表）+ `useMobileSession`（组件态缓存），没有 status / pending 聚合。
3. **会话生命周期残缺**  
   无新建、无中断、权限链路简化为发文本。
4. **历史服务不完整**  
   仅 claude-code / codex；simple-ai / mimo 不可见。

### 2.3 可复用资产

| 资产 | 用途 |
|------|------|
| `mobileMultiSessionStore` | Tab 钉住 / activeId |
| `MobileSessionTabs` | 横向 Tab UI |
| `useMobileSession` / `dispatchAIEvent` | 事件→状态归约逻辑可上提 |
| `httpTransport.COMMAND_ROUTE_MAP` | start/continue/interrupt/list 已映射 |
| 桌面 `EventRouter` 思想 | 全局 listen + 按 session 路由 |
| `contextId: mobile-${id}` | 已有会话隔离约定 |

---

## 3. 目标架构

### 3.1 分层

```text
┌─────────────────────────────────────────────┐
│ UI                                          │
│  MobileSessionTabs / MobileChatView         │
│  MobileSessionList / PendingBanner          │
└──────────────────▲──────────────────────────┘
                   │ selectors / actions
┌──────────────────┴──────────────────────────┐
│ mobileMultiSessionStore（视图层）             │
│  sessions[] / activeSessionId / max=8       │
└──────────────────▲──────────────────────────┘
                   │ open / close / activate
┌──────────────────┴──────────────────────────┐
│ MobileSessionRuntime（核心，新增）            │
│  Map<sessionId, SessionRuntimeState>        │
│  全局 1 个 chat-event listen                 │
│  route by contextId `mobile-${id}`          │
│  send / interrupt / answer / approve        │
│  status: idle|running|waiting|error         │
└──────────────────▲──────────────────────────┘
                   │ invoke / listen
┌──────────────────┴──────────────────────────┐
│ Transport (HTTP + WS)                       │
│  continue_chat / start_chat / interrupt...  │
└─────────────────────────────────────────────┘
```

### 3.2 关键不变量

1. **全局唯一 WS 订阅**  
   Runtime 初始化时 `listen('chat-event')` 一次；App 卸载才 unlisten。
2. **UI 可卸载，Runtime 不卸载**  
   切 Tab 只切换渲染目标，不 dispose 会话状态。
3. **关闭 Tab 才 dispose**  
   清理 messages/partial/pending，并取消该会话本地订阅副作用。
4. **contextId 稳定**  
   发送与路由统一使用 `mobile-${sessionId}`。
5. **只渲染 active 消息列表**  
   后台会话只更新状态与红点，控制内存。

### 3.3 SessionRuntimeState 最小模型

```ts
type MobileSessionStatus = 'idle' | 'running' | 'waiting' | 'error'

interface SessionRuntimeState {
  id: string
  engineId: EngineId
  title: string
  projectPath?: string
  messages: ChatMessage[]
  input: string
  sending: boolean
  status: MobileSessionStatus
  error: string | null
  pendingCard: PendingCard | null
  partial: { id: string; content: string } | null
  lastEventAt: number
}
```

`waiting` 定义：存在 `pendingCard`（question / plan / permission）。

---

## 4. 方案选型

### 方案对比

| 方案 | 描述 | 优点 | 缺点 | 决策 |
|------|------|------|------|------|
| A. 直接复用桌面 sessionStoreManager + MultiSessionGrid | App 挂载桌面会话体系 | 功能最全 | 依赖重、体积大、移动交互不适配 | 否 |
| B. 仅加强 useMobileSession 缓存 | 保持组件 listen | 改动小 | 仍绑 UI 生命周期，后台丢事件 | 否 |
| **C. 新增轻量 MobileSessionRuntime** | 移动专用运行时 + 现有 Tab | 对症、可控、可渐进 | 需维护一套精简状态机 | **采用** |

### 为何不直接复用桌面 Manager

- 桌面 Manager 绑定 workspace/profile/EventBus/toast/voice/LRU 等多系统
- 移动端当前走 HTTP companion，不需要完整 ConversationStore 能力面
- 风险是把 App 又拖回“桌面压缩版”

Runtime 只抽取桌面的 **路由思想**，不抽取 UI 与重依赖。

---

## 5. 分阶段实施

### Phase 1 — 多会话真并行（P0，核心）

**目标：** 多个会话可同时存活并收事件，Tab 可秒切。

#### 任务

1. 新增 `src/mobile/runtime/mobileSessionRuntime.ts`
   - zustand 或轻量 store + 模块单例均可
   - API：
     - `ensureRuntime()`
     - `openSession(detail)`
     - `closeSession(id)`
     - `setActive(id)`
     - `send(id, text)`
     - `interrupt(id)`
     - `dispatchEvent(contextId, event)`
2. 全局 `listen('chat-event')` 放入 Runtime
3. 将 `dispatchAIEvent` 上提为 Runtime reducer
4. 改造 `MobileChatSession`：
   - 只订阅 Runtime 中 active 会话状态
   - 删除组件内 listen/unlisten
5. 改造 `MobileSessionTabs`：
   - 显示 status 圆点（running 蓝、waiting 橙、error 红）
   - waiting 会话数字角标
6. `mobileMultiSessionStore` 与 Runtime 对齐：
   - open/close 同步
   - 关闭 Tab 调 `closeSession`

#### 文件改动

| 文件 | 动作 |
|------|------|
| `src/mobile/runtime/mobileSessionRuntime.ts` | 新增 |
| `src/mobile/runtime/types.ts` | 新增 |
| `src/mobile/hooks/useMobileSession.ts` | 重构：从缓存 hook 变为 Runtime selector 适配层，或删除后由 Runtime 取代 |
| `src/mobile/MobileSessions.tsx` | 改：UI 接 Runtime |
| `src/mobile/components/MobileSessionTabs.tsx` | 改：状态指示 |
| `src/mobile/stores/mobileMultiSessionStore.ts` | 改：与 Runtime 生命周期同步 |
| `src/mobile/runtime/*.test.ts` | 新增：路由/切 Tab 不丢事件单测 |

#### 验收

- [ ] 会话 A 流式中切到 B，A 事件继续写入 Runtime
- [ ] 回到 A 可见完整增量，无需整段空白
- [ ] A 出现 question 时，B 的 Tab 有 waiting 指示
- [ ] 关闭 Tab 后该会话状态释放，重开从历史重新加载
- [ ] 最多 8 Tab；超限淘汰最早且非 running/waiting 的会话（若全是 running，提示先关闭）

#### 预估

2–3 天

---

### Phase 2 — 会话闭环补齐（P0）

**目标：** 日常能新建、续接、停、答，不依赖桌面。

#### 任务

1. **全引擎列表**
   - `list_sessions` 并行拉取 4 引擎
   - 统一排序（updatedAt desc）
   - 引擎 badge 展示
2. **历史加载适配**
   - claude-code / codex：沿用现有 history service
   - simple-ai / mimo：走 `get_session_history` / 统一 API，必要时扩展 `unifiedHistoryService`
3. **新建会话**
   - 列表页 `+ 新建`
   - Sheet：选择 engine + workspace（默认当前 config workspace）
   - 调 `start_chat` 或 `create_session` + 首条消息
   - 成功后 `openSession` 并激活
4. **中断**
   - 聊天页发送中显示停止按钮
   - `interrupt_chat({ sessionId })`
5. **Permission 正规化**
   - 调研桌面 `resolvePermission` 对应 HTTP 能力
   - 优先正式 API；若 bridge 暂无，保留文本回退但标注 TODO，不得静默吞错

#### 文件改动

| 文件 | 动作 |
|------|------|
| `src/mobile/MobileSessions.tsx` | 列表/新建/中断 |
| `src/mobile/components/NewSessionSheet.tsx` | 新增 |
| `src/services/unifiedHistoryService.ts` | 扩展引擎（如需要） |
| `src/mobile/runtime/mobileSessionRuntime.ts` | send/start/interrupt |
| `src/mobile/MobileSessions.test.tsx` 等 | 单测 |

#### 验收

- [ ] 四引擎会话均能出现在列表
- [ ] 可新建会话并发出首条消息
- [ ] 运行中可中断，状态回到 idle
- [ ] Question / Plan 可完整提交
- [ ] Permission 至少有明确成功/失败反馈

#### 预估

2–3 天

---

### Phase 3 — 状态可见与重连（P1）

**目标：** 用户始终知道“谁在跑、谁在等、断线后是否恢复”。

#### 任务

1. 会话列表卡片显示 status（来自 Runtime 已打开会话 + 可选服务端状态）
2. 顶部 `PendingBanner`：
   - “N 个会话等待确认”
   - 点击跳到最近 waiting 会话
3. 断线重连：
   - 监听 transport `onStatusChange` / resume gap
   - 对 `status !== idle` 或 active 会话执行 `refreshHistory`
4. 发送失败可重试（保留 input，不清空草稿）

#### 验收

- [ ] 后台 waiting 可从 Banner 一键进入
- [ ] 模拟断网重连后，运行中会话历史不丢关键结果
- [ ] 发送失败有错误条 + 可重试

#### 预估

1–2 天

---

### Phase 4 — 聊天体验增强（P1）

**目标：** 消息可读性接近 Web 主路径，而非 1:1 桌面渲染。

#### 任务

1. 工具调用折叠卡片（只读摘要）
2. Plan 块移动友好展示
3. 图片 / Agnes markdown 图片正常显示
4. 长列表基础优化：
   - 仅 active 渲染全量
   - 超长会话可后续再引入虚拟列表（非本阶段硬性）

#### 验收

- [ ] 工具过程可折叠，不刷屏
- [ ] 图片消息可见
- [ ] 常见会话类型阅读成本明显下降

#### 预估

2 天

---

### Phase 5 — 设置与工程化（P2）

#### 任务

1. 设置页：主题、默认引擎、服务地址入口
2. 移动端 API 契约测试（首批 command 不 404）
3. smoke 清单文档：
   - 连接 → 列会话 → 开 2 个 Tab → 并行跑 → 处理 question → 中断 → 重连
4. APK 构建说明同步到 `plans/` / handoff（沿用现有手动 so 流程）

#### 预估

1–2 天

---

## 6. 实施顺序与依赖

```text
Phase 1 Runtime 并行  ──►  Phase 2 会话闭环
            │                    │
            └────────► Phase 3 状态/重连
                                 │
                                 ▼
                           Phase 4 渲染增强
                                 │
                                 ▼
                           Phase 5 设置/工程化
```

**硬依赖：**

- Phase 2 的新建/中断依赖 Phase 1 的 Runtime API
- Phase 3 Banner 依赖 Phase 1 的 status 字段
- Phase 4 可与 Phase 3 部分并行，但不阻塞 P0

**建议里程碑：**

| 里程碑 | 完成定义 |
|--------|----------|
| M1 | Phase 1 完成：多 Tab 真并行 |
| M2 | Phase 1+2 完成：日常可独立使用聊天 |
| M3 | +Phase 3/4：体验接近 Web 主路径 |
| M4 | +Phase 5：可回归、可发版 |

---

## 7. 关键设计细节

### 7.1 事件路由规则

优先级：

1. `contextId === mobile-${sessionId}` → 路由到该 session
2. 否则若 payload 含 backend sessionId 且 Runtime 有映射 → 路由
3. 否则丢弃并 debug log（避免串会话）

### 7.2 超限淘汰策略

```text
MAX_TABS = 8
close 候选优先级：
1. idle 且最久未访问
2. error 且最久未访问
禁止自动淘汰：running / waiting
若无法淘汰：addSession 失败并 toast「请先关闭空闲会话」
```

### 7.3 与桌面 contextId 隔离

- 桌面：`session-${id}`
- 移动：`mobile-${id}`
- 禁止混用，避免同一后端会话被两端错误抢路由（若未来支持同机双端，需另案设计 conversationId 映射）

### 7.4 内存策略

| 策略 | 值 |
|------|----|
| 最大 Tab | 8 |
| 仅 active 挂载消息 DOM | 是 |
| 关闭 Tab dispose | 是 |
| 后台保留 partial/pending | 是 |
| App 进后台 | 保持 Runtime；依赖 WS 重连 |

### 7.5 权限处理策略（Phase 2）

```text
if 存在正式 permission API:
  调正式 API
else:
  明确错误提示 + 可选文本回退（开关控制，默认关）
```

不把“发批准文本”作为默认长期方案。

---

## 8. 测试计划

### 8.1 单测

1. Runtime reducer：assistant delta / result / question / error
2. 路由：只派发到匹配 session
3. 切 active 不 dispose
4. close 清理状态
5. 超限淘汰规则

### 8.2 集成 / 手工 smoke

| 步骤 | 预期 |
|------|------|
| 连接服务器 | Gate 通过 |
| 打开会话 A，发送 | 流式显示 |
| 打开会话 B，发送 | A/B 均 running |
| 在 B 停留时 A 完成 | A Tab 变 idle，内容完整 |
| A 弹出 question | A Tab waiting，Banner 提示 |
| 中断 B | B 停止 |
| 断网再恢复 | 可 resync |
| 四引擎列表 | 均可见（有数据时） |

### 8.3 回归保护

- 不破坏桌面 `sessionStoreManager` / `EventRouter`
- 移动改动限制在 `src/mobile/**` + 必要 history/transport 扩展
- `pnpm exec tsc --noEmit` 零错误
- 相关 vitest 通过

---

## 9. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| simple-ai/mimo 历史 API 不一致 | 列表/续接失败 | Phase 2 先探测 API，做 per-engine adapter；失败显示引擎级错误而非整页挂 |
| 权限 API 移动桥缺失 | 工具审批不可用 | 正式 API 优先；无则显式降级提示 |
| 后台多会话内存涨 | 低端机卡顿 | MAX_TABS=8 + 仅 active 渲染 + 关闭 dispose |
| 与桌面同时操作同会话 | 状态冲突 | 文档声明 companion 优先续接；contextId 隔离；后续再做协作锁 |
| 改动 useMobileSession 引发回归 | 聊天不可用 | Phase 1 先加 Runtime 并行，UI 适配层兼容旧接口，分 PR 落地 |

---

## 10. PR 拆分建议

1. **PR1**：`MobileSessionRuntime` + 单测（无 UI 大改）
2. **PR2**：`MobileSessions` / Tabs 接入 Runtime（多会话并行可见）
3. **PR3**：全引擎列表 + 新建 + 中断
4. **PR4**：PendingBanner + 重连 resync
5. **PR5**：渲染增强 + 设置轻量页

每个 PR 可独立验收，避免大爆炸。

---

## 11. 成功标准（对用户可感知）

完成后用户应能：

1. 在手机上同时开多个对话 Tab
2. 一个会话跑工具时，切换去另一个会话继续聊
3. 被 question/plan 阻塞的会话有明确提示并可跳转处理
4. 新建会话、续接历史、中断生成
5. 看到四引擎历史（在服务端有数据的前提下）
6. 不需要桌面也能完成“聊天主路径”工作

仍需回桌面的：

- 改代码、看 LSP、用终端、复杂 Git、装插件

---

## 12. 建议执行选择

**默认推荐执行顺序：Phase 1 → 2 → 3 → 4 → 5**

若资源只够做一个冲刺：

> **只做 Phase 1 + Phase 2 的最小集（并行 + 新建/中断/四引擎列表）**  
> 这是体验跃迁最大、且直接满足“多窗口对话”诉求的路径。

---

## 13. 下一步行动（落地时）

1. 确认本方案边界（尤其 Permission 与四引擎历史 API 现状）
2. 开 PR1：实现 `MobileSessionRuntime`
3. 用 `?mobile=1` 桌面浏览器完成并行 smoke
4. 再打 APK 做真机验证

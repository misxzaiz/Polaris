# pet-overlay R2 spec：桌面悬浮宠物窗（实态对齐 · v0.5.0）

> 本文取代 `plans/pet-overlay-spike.md`（R1 spike 决策已通过，实态已远超原 spec）。
> 目的：把当前 1168 行单体 `OverlayApp.tsx` 的真实功能边界、跨进程契约、所有者、验收门槛固化下来，
> 作为后续模块化拆分与 R3 扩展的权威依据。
> 来源：对照 `src/petOverlay/OverlayApp.tsx`（VERSION_TAG v0.5.0）+ `src/main.tsx` 桥接 + `src-tauri/capabilities/default.json`。

---

## 一、范围与所有者

### 1.1 功能实态（R1 + R2a-R2e + 多开 + 通知）

| 阶段 | 能力 | 状态 |
|---|---|---|
| R1 | 透明置顶悬浮窗 + idle webm 循环 + 拖拽 + 位置记忆 + 点击回应 | ✅ |
| R1.5 | 原版效果对标：完整随机链 / 点击积分音效 / 拖拽挣扎 / 抛飞物理 / 自主走位 / 睡觉三连 / 碎碎念气泡 / 边界钳制 | ✅ |
| R2a | 定时掷骰随机链 + 播放看门狗 + 工作状态/余额联动（链循环段死锁 / play() 拒绝冻结 / boot 未起链 三 bug 修复） | ✅ |
| R2c | AI 碎碎念：cap.ai.chat 单一宠物会话复用，30s 超时回退离线文案，右键菜单开关 | ✅ |
| R2d/R2e | 宠物对话 UI（独立会话 + systemPrompt 人设 + 记忆续接）+ TTS 语音接线（cap.voice synthesize → convertFileSrc，默认关） | ✅ |
| 多开 | pet-overlay-2..8 槽位 / 独立位置记忆 / openNext 扫描 | ✅ |
| 通知 | AI 回话且失焦时 plugin:notification，60s 限频 / 菜单开关 | ✅ |
| continue 契约 | 经总线 start/continue 必须带 `options.engineId = 'simple-ai'`（HTTP 实测） | ✅ |

### 1.2 所有者与边界

- **悬浮窗生命周期所有者**：宿主前端 `src/petOverlay/OverlayApp.tsx`（页面内自管理：资源加载 / 拖拽 / 物理引擎 / 位置记忆 / AI 联动 / 多开 / 通知）+ `src/main.tsx` 桥（开窗 / openNext / close）。
- **零 Rust 命令层改动**：所有后端交互走既有 cap 总线（cap.ai.chat / cap.voice / cap.kv）+ 既有 `plugin_service_list` 命令。**不新增任何 Rust command。**
- **不做**：不改插件面板既有渲染逻辑；不引入新 cap 契约；不动 `whale-pet` 插件本体资源。

---

## 二、跨进程契约（不可漂移）

### 2.1 capabilities（`src-tauri/capabilities/default.json`）

- `webviews` 白名单：`main`、`floating`、`pet-overlay`、`pet-overlay-2` … `pet-overlay-8`（共 10 个 label）。
- 主 webview 权限集合（固定，面板无法注入任意参数）：
  `core:webview:allow-create-webview` / `allow-create-webview-window` / `allow-webview-close` /
  `allow-webview-hide` / `allow-webview-show` / `allow-set-webview-position` /
  `allow-set-webview-size` / `allow-set-webview-focus` / `allow-clear-all-browsing-data` /
  `allow-internal-toggle-devtools`。
- **安全面**：桥固定了 label/尺寸/标志位，面板同源非沙箱（既有事实），攻击面无增量。

### 2.2 桥（`src/main.tsx`，`window.__POLARIS_PET_OVERLAY__`）

| 方法 | 签名 | 行为 |
|---|---|---|
| `open(opts?)` | `{ slot?: number } → Promise<string>` | slot∈[2,8] → label `pet-overlay-${slot}`；slot 缺省/≤1 → label `pet-overlay`；window 配置 transparent/decorations:false/alwaysOnTop/skipTaskbar/resizable:false/shadow:false；slot 窗初始位置 `x=120+slot*56, y=120+slot*42`，主窗 center |
| `openNext()` | `→ Promise<string>` | 扫描 slot 0..8，首个不存在的 label 即开（复用 `open`） |
| `close(opts?)` | `{ slot?: number } → Promise<void>` | 按 label 关窗 |

- **启动分支**：`?petOverlay=1` 查询参数 → 动态 `import('./petOverlay/OverlayApp')`（不进主 bundle）；其余环境渲染 `RootApp`。
- **环境探测**：纯 Web / 移动环境经 `__TAURI_INTERNALS__` 探测不存在，桥不暴露。

### 2.3 资源通道（whale-pet 插件）

- 经 `invoke('plugin_service_list')` 解析 `pluginId='whale-pet' && serviceId='whale-pet-assets'` 的 port。
- 兜底端口：`FALLBACK_PORT = 9863`。
- `pickBase()` 双候选探测：`localhost` / `127.0.0.1`，`GET /__health` 2.5s 超时，首个 ok 即用。
- 资源 URL 规则：`${base}/asset/webm/${encodeURIComponent(anim)}.webm`。

### 2.4 cap 总线调用（经 `router_dispatch`）

| cap | 调用 | 用途 |
|---|---|---|
| `cap.kv` | `{ action:'get'/'set', key, value? }` | 位置记忆 / 各功能开关 / 会话 id |
| `cap.ai.chat` | start: `{ message, options:{ engineId:'simple-ai', systemPrompt, sessionId? } }`；continue: `{ message, options:{ engineId:'simple-ai', sessionId } }` | 碎碎念（单一会话复用）/ 对话（独立会话） |
| `cap.voice` | `synthesize` → `convertFileSrc` | TTS（默认关） |

- **continue 契约**（commit 5d1d98cc）：经总线 start/continue **必须**带 `options.engineId = 'simple-ai'`，否则 HTTP 通道实测不识别。
- **router_dispatch envelope 形状**：`{ ok?, result?: { value? } | unknown, error? }`，kv 取值须穿透 `result.value`。

### 2.5 KV key 字典（`src/petOverlay/OverlayApp.tsx` 常量）

| key | 含义 | 多开分槽 |
|---|---|---|
| `whale-pet.overlay.pos` | 物理像素位置 | slot≥2 时后缀 `.2`..`.8`（`posKeyRef` 动态拼接 `KV_POS_KEY + '.' + slot`，**分隔符是 `.` 非 `-`**） |
| `whale-pet.overlay.notify` | 系统通知开关 | 否（全局） |
| `whale-pet.overlay.sound` | 音效开关 | 否（全局） |
| `whale-pet.overlay.aiWhisper` | AI 碎碎念开关 | 否（全局） |
| `whale-pet.overlay.voice` | TTS 开关 | 否（全局） |
| `whale-pet.overlay.whisperSession` | 碎碎念会话 id（单一复用） | 否（全局） |
| `whale-pet.overlay.chatSession` | 对话会话 id（独立续接） | 否（全局） |

> **多开纪律**：仅 `pos` 按槽位分；功能开关与会话 id 全局共享，避免多开宠物各自碎碎念撞车。

---

## 三、内部架构（当前单体，待拆分）

### 3.1 当前 `OverlayApp.tsx`（1168 行）关注点分布

| 关注点 | 行区间（约） | 性质 |
|---|---|---|
| 常量（动画名/权重/物理/超时/KV key/persona/prompt） | 32-111 | 纯数据，可机械拆 |
| `pick` / `rollChain` 随机链骰子 | 113-134 | 纯函数，可测 |
| `resolvePort` / `pickBase` / `assetUrl` | 136-163, 269 | 资源解析，可拆 |
| `kvGet` / `kvSet` + envelope 类型 | 165-180 | cap.kv 适配，可拆 |
| `StatusPill` / `OverlayErrorBoundary` | 183-209 | 纯展示，可拆 |
| `PetOverlayInner` 主组件 | 213-1159 | 编排 + 7 个正交副作用 |

### 3.2 主组件内 7 个正交关注点（拆分目标）

1. **物理引擎**：重力 `GRAVITY=1400` / 反弹 `RESTITUTION=0.78` / 摩擦 `GROUND_FRICTION=2.5` / 抛飞阈值 `THROW_MIN_SPEED=0.45` / 轨迹采样窗 `TRAJ_WINDOW_MS=120`。状态 `modeRef: 'chain'|'drag'|'flight'|'walk'|'sleep'`，`motionRafRef` + `motionGenRef` 控制运动帧。
2. **动画状态机**：双缓冲 video（`videoA`/`videoB`/`front`/`videoGen`）+ `rollChain` 调度 + `chainRollTimer` 看门狗 + loadeddata 事件链。
3. **AI 碎碎念**：`whisperTimerRef` 定时 + `whisperSessionRef` 单一会话复用 + `WHISPER_PROMPT` + 30s 超时回退 `WHISPERS` 离线文案。
4. **AI 对话**：`chatSessionRef` 独立会话 + `PET_PERSONA` systemPrompt + `chatLog` UI + 45s `CHAT_TIMEOUT_MS` + 续接走 continue 契约。
5. **TTS 语音**：`voiceOnRef` + `cap.voice synthesize` + `convertFileSrc` + `TTS_VOICE_REF='mimo_default'`，默认关。
6. **多开槽位**：`slotRef` + `posKeyRef` 动态 key + `openNext` 桥调用。
7. **系统通知**：`notifyOnRef` + `lastNotifyRef` 60s 限频 + `sessionFlowRef` 计流动 + 失焦探测 `plugin:notification`。

### 3.3 时序（开机 → 稳态）

```
?petOverlay=1 → 动态 import OverlayApp → PetOverlayApp
  → resolvePort → pickBase（双候选 /__health）
  → kvGet(posKey) → 还原位置（slot 分槽）
  → idle webm 双缓冲加载 → chainRoll 启动随机链
  → setInterval: sleepTimer(60s 梦话) / sleepChecker(60s) / whisper(定时碎碎念) / balance(30min 余额)
  → listen('chat-event'): 8s 流动=busy / 12s 安静=庆祝 → 工作状态联动
  → 拖拽: pointerdown→startDragging / pointermove→traj采样 / pointerup→THROW_MIN_SPEED 判抛飞或回 chain
  → 右键菜单: sound / aiWhisper / voice / notify / chat 开关
  → chat: open→独立会话 start / send→continue(带 engineId) / TTS 合成
  → 失焦 + AI 回话 → plugin:notification（60s 限频）
```

---

## 四、模块化拆分蓝图（本次优化目标）

> 纪律（AGENTS.md §二.2）：**业务签名不变、外部契约不漂移**，纯内部重组。
> 拆分后跑 `pnpm exec tsc --noEmit` + `pnpm lint`，无 Rust 改动。

```
src/petOverlay/
├── OverlayApp.tsx          # 主组件：状态机内核 + 编排 + 生命周期（目标 ~600 行）
├── constants.ts            # 动画名/权重/物理常量/超时/KV key/persona/prompt/文案池
├── animationChain.ts       # pick/rollChain 骰子（纯函数，可测）
├── assetResolver.ts        # resolvePort/pickBase/assetUrl + KvEnvelope + kvGet/kvSet
├── useAiWhisper.ts         # AI 碎碎念 hook（cap.ai.chat + 超时回退 + 单一会话复用）
├── usePetChat.ts           # AI 对话 hook（独立会话/人设/续接/TTS 触发）
├── useMultiSlot.ts         # 多开槽位 + posKey 动态拼接
├── useSystemNotify.ts      # 失焦通知 hook（60s 限频 + sessionFlow 计流动）
├── useWorkStatus.ts        # 工作状态/余额联动 hook（busy/celebrate + 余额六档）
└── OverlayRender.tsx       # 纯展示层（video 双缓冲 DOM/气泡/pops/✕/菜单/聊天UI/StatusPill/ErrorBoundary）
```

> 物理引擎（`startFlight`/`planWalk`/`squash`/`clampPos`/`settleDrag`）与状态机内核强耦合，**不单独拆文件**，留在 `OverlayApp.tsx`（见 §4.1 复审校准）。

### 4.1 拆分边界与不拆项（复审校准 · 对照全文件 1168 行实测）

**强耦合确认（不可拆为纯函数）**：物理引擎与状态机共享 `modeRef`/`motionRafRef`/`motionGenRef`/`workAreaRef`/`winSizeRef`，且 `chain`↔`planWalk` 互递归（经 `chainRef`/`planWalkRef` 解开）、`startFlight`/`squash`/`settleDrag` 互相调用。`switchTo` 是双缓冲换源中枢（绑定 `front`/`videoA`/`videoB`/`videoGen`/`currentAnimRef`，被 7 处调用）+ videoGen 代际守卫 + 看门狗。**运动/换源/指针交互三块是状态机内核，必须留在主组件**，不为拆而拆（AGENTS.md §九）。

- **必拆为纯函数**（可加 vitest）：`animationChain.ts`（`pick`/`rollChain` 骰子，零依赖）。
- **必拆为纯数据**：`constants.ts`（动画名/权重/物理常量/超时/KV key/persona/prompt/文案池）。
- **必拆为适配模块**：`assetResolver.ts`（`resolvePort`/`pickBase`/`assetUrl` + `KvEnvelope` + `kvGet`/`kvSet`，纯 IO 适配，无状态）。
- **必拆为展示组件**：`OverlayRender.tsx`（video 双缓冲 DOM/气泡/pops/✕按钮/菜单/聊天面板/StatusPill/ErrorBoundary）。注意：`switchTo` 逻辑留主组件，展示层只接收 `videoA`/`videoB` ref 与 `onVideoError`。
- **必拆为 hook**（各自自包含 timer/ref/cap 调用，输入输出明确）：
  - `useAiWhisper` —— `aiWhisper`/`whisperSessionRef`/`whisperTimerRef`/`aiWhisperOnRef` + `WHISPER_PROMPT`/超时回退。返回 `{ aiWhisper, aiWhisperOn, toggleAiWhisper, whisperTimerRef }`。
  - `usePetChat` —— `sendChat`/`chatSessionRef`/`chatLog`/`chatBusy`/`chatInput`/`chatOpen` + `PET_PERSONA`/`CHAT_TIMEOUT_MS`。返回 `{ sendChat, chatLog, chatBusy, chatInput, setChatInput, chatOpen, setChatOpen, toggleVoice }`。
  - `useSystemNotify` —— `notifyOnRef`/`lastNotifyRef`/`sessionFlowRef` + 60s 限频 + `plugin:notification|notify`。
  - `useWorkStatus` —— `busyRef`/`lastEvtAtRef` + `BUSY_ACTIVE_MS`/`BUSY_QUIET_MS` + 工作状态/余额联动两 setInterval。
  - `useMultiSlot` —— `slotRef`/`posKeyRef` 动态拼接（slot≥2 后缀 `.${slot}`，**非 `-`**，实测 `KV_POS_KEY + '.' + slot`）。
- **保留主组件**：`switchTo`/`chain`/`beginLoop`/`planWalk`/`startFlight`/`squash`/`clampPos`/`savePos`/`stopMotion`/`settleDrag`/`enterSleep`/`wakeFromSleep`/指针三 handler + 初始化 effect + 诊断钩子 `__petOverlayDebug`。

**关键修正**：KV pos 分槽分隔符是 `.`（`whale-pet.overlay.pos.2`）非 `-`，capabilities label 才用 `-`（`pet-overlay-2`）。

### 4.2 拆分顺序（先机械后逻辑，每步跑 `tsc --noEmit`）

1. `constants.ts`（机械搬运，零逻辑）—— 把 32-111 行常量全部搬出
2. `animationChain.ts`（`pick`/`rollChain` 纯函数抽出，同步补 vitest）
3. `assetResolver.ts`（`resolvePort`/`pickBase`/`assetUrl` + `KvEnvelope` + `kvGet`/`kvSet`）
4. `OverlayRender.tsx`（纯展示层剥离，`switchTo` 逻辑留主组件，展示层只收 ref + `onVideoError`）
5. 逐个抽 hook：`useMultiSlot` → `useSystemNotify` → `useWorkStatus` → `useAiWhisper` → `usePetChat`
6. 主组件收敛为状态机内核 + 编排层

---

## 五、验收门槛

### 5.1 功能回归（手测，参照 R1 spike §11.5 + R2 实态）

- [ ] 悬浮窗透明无边框置顶，idle webm 播放无黑底/白框
- [ ] 拖拽顺滑；重启 Polaris 后位置还原（含多开各槽位独立还原）
- [ ] 点击播放随机回应动画后回 idle；积分音效
- [ ] 抛飞：松手初速 > THROW_MIN_SPEED 触发物理抛飞 + 边缘反弹
- [ ] 随机链：idle/turn/move/CLICKS 类别按权重出现；睡觉三连起承转
- [ ] AI 碎碎念：定时触发，30s 超时回退离线文案，右键可关
- [ ] AI 对话：开聊天 → start → send → continue（带 engineId）→ 续接记忆
- [ ] TTS：开关开后对话文本合成语音
- [ ] 多开：openNext 连开多个，各槽位独立位置/独立拖拽
- [ ] 通知：失焦时 AI 回话触发 plugin:notification，60s 内不重复
- [ ] 工作状态：chat-event 8s 流动=busy 冒泡，12s 安静=雀跃庆祝

### 5.2 门槛命令

- [x] `pnpm exec tsc --noEmit` 零新增告警（拆分全程复跑通过）
- [x] `pnpm lint` 零新增告警（`eslint src/petOverlay/` 通过）
- [x] 无 Rust 改动（`cargo check` 不受影响）
- [x] 新增 vitest：`animationChain.test.ts`（`pick`/`rollChain` 纯函数，9 用例全绿）

> 拆分实际产出（2026-11-03）：主组件 1168 → 936 行；新模块
> `constants.ts` / `animationChain.ts` / `assetResolver.ts` / `OverlayRender.tsx` /
> `useMultiSlot.ts` / `useSystemNotify.ts` / `aiChannel.ts` + `animationChain.test.ts`。
> `physics` 因与状态机内核强耦合（`modeRef`/`motionRafRef`/`switchTo`/`chain` 互递归）**不单独拆**，
> 留在 `OverlayApp.tsx`（见 §4.1 复审校准）；`aiWhisper`/`sendChat` 因参数噪音大、收益低保留组件内。

### 5.3 契约不漂移检查

- [ ] `window.__POLARIS_PET_OVERLAY__` 三方法签名不变
- [ ] capabilities `webviews` 白名单 10 个 label 不变
- [ ] KV key 字典（§2.5）字符串不变
- [ ] cap.ai.chat continue 必带 `options.engineId='simple-ai'`
- [ ] `?petOverlay=1` 启动分支行为不变

---

## 六、风险与回退

- **HMR 陈旧闭包**（记忆 `vite-hmr-memo-stale-closure`）：拆分后 hook 跨文件，验证须 reload 干净模块图，不能只靠 HMR 热更。
- **物理与状态机耦合**：若 `modeRef`/`motionRafRef` 强耦合拆不出纯函数，回退为保留在主组件（不强拆）。
- **双缓冲 video 时序**：`videoGen` 代际守卫与 `front` 切换逻辑敏感，拆 `OverlayRender` 时须保持 loadeddata 事件链顺序。
- **多开 KV 分槽**：`posKeyRef` 动态拼接是 slot≥2 才后缀，拆 `useMultiSlot` 时不能误改成全分槽（会破坏全局开关共享语义）。
- **回退策略**：拆分按 commit 粒度提交，任一 commit 跑不过 `tsc --noEmit` 即 revert 该步，不累积风险。

---

## 七、R3 展望（不在本次范围）

- 插件化迁移（落 `Polaris-plugin`，参照 AGENTS.md §五功能路由原则）
- 宠物情绪与对话内容联动（cap.context 注入工作状态）
- 多宠物个性（不同 persona / 不同 webm 资源集）
- 移动端形态（当前仅桌面 Tauri，移动端桥不暴露）

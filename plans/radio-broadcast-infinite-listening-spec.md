# 无限畅听电台（Infinite Listening Radio）— 总纲 Spec

> 四段式：目标 / 契约 / 验收 / 不做。本 spec 是**总纲（Program Spec）**：定定位、架构与分期边界；每期开工前在 `plans/` 拆独立子 spec（沿用本文件编号，如 `radio-broadcast-p0-quickwins-spec.md`）。
> 关联：`radio-broadcast-spec.md`（现状实现，继续有效）、`radio-broadcast-prod-upgrade-spec.md`（体验打磨，已落地）、`radio-broadcast-infinite-listening-prd.html`（交互原型，需求可视化）。
> 效力顺序：涉及「语音库 / cap.voice / 预生成 / 插话换台」等新增能力以本 spec 为唯一权威；既有播报实现的行为不变。

---

## 一、目标

### 1.1 定位（北极星）

**「想到什么听什么，永远有下一集。」**

本功能不是「语音播报工具」，而是**听的内容本身**：一个 AI 无限生成的个人电台。用户一句话开台，AI 连续创作并朗读；随时换台、插话、囤积、回听。

- 差异化：番茄畅听/懒人听书 = 有版权内容库的畅听；NotebookLM = 围绕上传文档的播客（有门槛）；Spotify AI DJ = 歌单主持。Polaris = **零内容门槛的即时无限电台**。
- **独有优势**：背后是真 AI 引擎而非录音——可随时**插话提问**，这是录音式产品做不到的（NotebookLM 互动模式为同类最高呼声需求）。

### 1.2 北极星指标

| 指标 | 定义 | 采集 |
|---|---|---|
| 人均单次收听时长 | 开台到停止的累计播放秒数 | 前端 localStorage 遥测（对齐 voiceCompanion 耗时统计先例） |
| 7 日回访开台率 | 首次开台后 7 日内再次开台的用户占比 | 同上 |
| 插话使用率 | 播报中插话次数 / 播报次数 | P2 埋点 |

### 1.3 用户场景

- **睡前**：讲个明朝那些事，无限续 → 定时 30 分钟 + 播完本段停 + 淡出。
- **通勤**：新闻早报连播 + 实时字幕（嘈杂）+ 锁屏控制。
- **学习陪伴**：经济学连播 + 插话「机会成本再讲讲」。
- **家务摸鱼**：后台连播 + 双主播闲聊感（P3）。

### 1.4 体验闭环

```
开台（一句话/点话题，秒出声）→ 畅听（字幕跟读·无限连播）
  → 随意（上滑换台不断声 · 插话 · 睡眠定时）
  → 沉淀（好听进内容库 · 喜欢音色进音色库）
  → 回来（续播 · 预生成囤积 · 订阅更新）
```

---

## 二、现状与差距（勘察结论摘要）

现状链路：`RadioBroadcastPanel → radioBroadcastController（前端单例状态机）→ kind='radio-broadcast' 后台会话 → 清洗切句 → voiceBroadcastPlayer（句级预取）→ mcpBridge → cap.mcp → mimo-tts 插件 → MiMo API`。工程质量良好（幂等停止/代际打断/lookahead/优雅停机，52 测试绿）。

**「玩具感」的五个根因**：

1. **单工直播模型**：生成→合成→播放实时链，播完即蒸发，无「内容资产」概念。
2. **插件 75% 能力闲置**：`voice_design`/`voice_clone`/`list_voices` 三个工具未被播报使用，设计结果一次性丢失。
3. **零存储层**：音频无库（时间戳堆插件目录，无索引/元数据/GC）、音色无库（前端硬编码 `VoiceId` 枚举 9 个预置）、稿件无库（只活在会话 JSONL）。
4. **无任务模型**：预生成/批量/定时不可能。
5. **绑死单一插件**：`mcpBridge.ts` 硬编码 `mcpServerId:'mimo-tts'`，换引擎要改功能代码。

---

## 三、目标架构（to-be）

### 3.1 分层

```
UI 层    RadioBroadcastPanel（畅听/内容库/音色库三页签）+ 交互原型对应屏
           │
控制层    radioBroadcastController（单例状态机，扩展：换台/插话/预生成 job）
           │
能力层    cap.voice（RouterBus，唯一权威）── 语义化语音能力
           ├─ 引擎适配：engineId 路由
           │    ├─ mimo-tts 插件（经 ctx.resolve_cap('cap.mcp') 委托，复用既有 client）
           │    └─ edge-tts 内置引擎（P3 免 Key 兜底）
           ├─ 存储层：<dataRoot>/voice/（单写路径）
           │    ├─ voices.json          音色库索引
           │    ├─ library/items.json   音频索引（元数据）
           │    ├─ library/audio/*.wav  音频资产
           │    └─ cache/               合成缓存（LRU+配额）
           └─ 任务层：预生成 job 队列（P2）
```

### 3.2 所有权（单写路径）

| 状态/数据 | 唯一所有者 | 说明 |
|---|---|---|
| 播报状态机 | `radioBroadcastController` | 既有，不变 |
| 音色库 / 内容库 / 缓存 / job | **cap.voice（后端）** | 前端只经 `router_dispatch` 读写；禁止前端直写文件 |
| 引擎 client 生命周期 | cap.mcp registry | cap.voice **委托不持有**，避免双拉起进程（AGENTS.md 唯一权威） |
| 预生成 job 运行 | 控制器 headless 模式（P2 v1） | 面板关闭仍跑；App 退出即停（如实交代，见 §6.4） |

---

## 四、cap.voice 契约

### 4.1 Actions

```ts
// synthesize：合成（带缓存）
{ action:'synthesize', text, voiceRef, style?, engine?, outputMode?:'file'|'base64' }
→ { ok, audioId, url|dataUrl, cached: boolean, format, durationSec?, sizeBytes }
// 缓存 key = hash(engine, voiceRef, style, text)；命中零 API 成本（重听/重复开场白场景量级优化）

// voices：音色库 CRUD
{ action:'voices.list' }                    → { ok, voices: Voice[] }   // preset + design + clone 合并
{ action:'voices.add', type:'design', name, description }                  // MiMo voicedesign 描述持久化
{ action:'voices.add', type:'clone',  name, samplePath }                   // 样本复制入 data root
{ action:'voices.update', voiceId, name?, description? }
{ action:'voices.delete', voiceId }         // 级联：仅删索引，不删预置
{ action:'voices.probe', voiceRef }         // 试听（合成 3 秒样本）
// Voice = { id, name, type:'preset'|'design'|'clone', engine,
//           description?, samplePath?, createdAt, usageCount }

// library：音频库 CRUD
{ action:'library.list', filter?: { topic?, voiceRef?, favorite?, since? } }
→ { ok, items: Item[] }
{ action:'library.get', itemId }            → { ok, item, transcript?: string[] }
{ action:'library.update', itemId, title?, tags?, favorite? }
{ action:'library.delete', itemId }         // 删索引 + 音频文件（pin 豁免除外）
{ action:'library.stats' }                  → { ok, totalBytes, count, cacheBytes }
// Item = { id, title, topic, engine, voiceRef, style?, createdAt,
//          durationSec, sizeBytes, favorite, tags[], source:'live'|'pregen'|'chat',
//          transcript: { text, audioId, startSec }[] }   // 句级索引 → 天然支持按句 seek

// jobs：预生成（P2）
{ action:'jobs.enqueue', topic, voiceRef, episodeCount, style? } → { ok, jobId }
{ action:'jobs.get' | 'jobs.cancel' | 'jobs.list' }
→ { ok, job: { id, topic, voiceRef, episodeCount, done, status:'running'|'done'|'cancelled'|'error', episodes: Item[] } }
```

### 4.2 权限与事件

- **Source gate** 对齐 `mcp_capability.rs` 范式：`Bootstrap`/`Plugin` 放行；`Remote` 仅携带有效 token（移动端 HTTP 鉴权链既有）。
- **破坏性动作**（`library.delete`/`voices.delete`）：AI 调用时需走审计日志；面板人工调用二次确认。
- **事件广播**：job 进度与库变更复用 `EventBroadcaster`（`plugin_events` 同通道），前端订阅刷新，不轮询。

### 4.3 关键技术边界（如实）

- MiMo voice design / clone 是**无状态 API**：每次合成重传描述文本/样本 data URL，API 不返回可复用 voiceId。**音色库的本质 = 持久化参数并命名**，合成时回放——这正是 cap.voice 存储层的价值（否则每个调用方自行保管参数）。
- 9861 端口硬编码 → P1 收敛：核心侧静态服务代理 `/voice/audio/*`（web 层路由），插件只管合成；一并解决手机可达性（`127.0.0.1` 对手机不可达的 file 模式遗留问题）。

---

## 五、分期计划

### P0 快赢（纯前端为主，数据已在，1-2 天/项）

| # | 项 | 关键文件 | 验收 |
|---|---|---|---|
| P0-1 | **实时字幕跟读**：播报中视图加全文滚动文稿 + 当前句高亮 | `voiceBroadcastPlayer.ts`（回调补句子列表/索引）、`radioBroadcastController.ts`（snapshot 扩展 `transcript`）、`RadioBroadcastPanel.tsx`、`types.ts` | 字幕自动滚动跟随当前句；点历史句可跳播该句（stretch） |
| P0-2 | **倍速**：0.75/1/1.25/1.5/2x 循环，prefs 持久化 | `voiceBroadcastPlayer.ts`（`playbackRate`）、`radioBroadcastPrefsStore.ts` | 切速对当前句即时生效；重开面板保留 |
| P0-3 | **睡眠定时**：15/30/60 分钟 + 「播完本段」+ 音量淡出 | `radioBroadcastController.ts`（复用 `maxSeconds` + `tryGracefulStop`，新增 fade）、`RadioBroadcastPanel.tsx` | 到点/播完本段优雅停止；淡出 3s 不截半句 |
| P0-4 | **MediaSession 锁屏控制**：标题/暂停/停止/下一集 | `voiceBroadcastPlayer.ts` | 锁屏显示话题名；耳机/锁屏按钮可用 |
| P0-5 | **合成缓存（轻量）**：hash key 命中复用；音频落 data root（经既有 `cap.data_root`，桌面 `convertFileSrc` 播放）；LRU 配额 500MB GC | `mcpBridge.ts` 或新 `voiceCache.ts`、`voiceBroadcastPlayer.ts` | 二次播放同句 0 API 调用；GC 后不超配额；**移动端 P0 不启用**（仍 base64 实时，P1 统一解） |
| P0-6 | **VoiceId 放开**：`VoiceId` 改 `string`，面板经 `mimo_tts_list_voices` 动态渲染（预置 fallback） | `types.ts`、`mcpBridge.ts`、`RadioBroadcastPanel.tsx` | 非硬编码音色可入播报 |

> P0-5 若评估发现 `cap.data_root` 写文件语义不合用（如仅限文本 JSON），降级为仅内存 LRU，持久缓存挪 P1——**不为此提前动 Rust**。

### P1 资产层（cap.voice + 两库，核心 cap）

| # | 项 | 说明 |
|---|---|---|
| P1-1 | **cap.voice 后端能力**（新文件 `src-tauri/src/services/router/voice_capability.rs`） | §四契约全量（jobs 除外）；存储经 `data_root.rs` 扩展 `voice_dir()`；synthesize 委托 `ctx.resolve_cap('cap.mcp')`；单测对齐 mcp_capability（gate 拒绝/放行） |
| P1-2 | **内容库 UI**：面板新增页签（历史单集/收藏/续播/删除） | `RadioBroadcastPanel.tsx` 扩展；续播 = 句级索引 seek |
| P1-3 | **音色库 UI**：预置/设计/克隆三分区 + 一句话设计向导（描述→试听→命名入库）+ 样本克隆上传 | 设计/克隆结果首次可持久化 |
| P1-4 | **9861 收敛**：核心静态服务代理音频；`buildAudioResult` 的 url 改核心代理路径 | 插件改动最小化（改 url 生成一行），手机 file 模式可达 |
| P1-5 | 播报接入 cap.voice（`mcpBridge.ts` 退役或退化为适配器） | 前端不再感知插件名 |

**P1 验收门槛**：`tsc --noEmit` / `pnpm lint` / `cargo check` / `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` 全过；cap.voice 单测绿（本机限制以 `cargo check` + 前端 vitest 代跑，如实记录）。

### P2 无限体验（质变点）

| # | 项 | 设计要点 |
|---|---|---|
| P2-1 | **换台（上滑岔题）** | `controller.switchTopic(newDirection)`：代际++ → 同一 kind 会话发岔题指令（AI 自然衔接）→ 播放队列清 pending 留 ready 播完 → 新题入队。**不断声** |
| P2-2 | **插话互动** | 播放暂停 → 语音/文本提问 → 发播报会话 → 回答经清洗合成**插队**队首 → 继续播。语音识别复用 `voiceStopWatcher` 独立实例模式；回声抑制沿用「播放时 pause 识别」半双工（插话场景可接受，与「停止口令」常开策略分场景配置） |
| P2-3 | **预生成囤积** | job = 控制器 headless 实例（无 UI 循环复用既有段循环）→ 产物入 library；面板/通知展示进度；**v1 前台 headless**（App 开着才跑，见 §6.4） |
| P2-4 | **AI 管家 tools** | 把 cap.voice 关键 action 包装为 AI 可调用工具（路径二选一，实施时定）：① 内置 `polaris-voice-librarian` MCP server（引擎自动注入，复用 gates）；② 引擎内置 tool 注入。用例：「设计说书人音色囤 5 集王阳明」「整理上周播报成合集」 |
| P2-5 | 节目/单集模型 + 埋点 | Program/Episode 落 items.json；北极星指标 localStorage 采集 |

### P3 生态（打磨，不承诺）

双主播对话（句带 speaker 标记路由多音色；stdio 串行成本 ×2 需评估）· 订阅式更新（cron 生成早报）· edge-tts 内置引擎兜底（免 Key）· 车机蓝牙深适配 · 多端同步。

---

## 六、关键设计决策与开放问题

### 6.1 为什么 cap.voice 而不是继续直调 cap.mcp
语义层（音色库/缓存/库/jobs）需要**状态归属**；`cap.mcp` 是无状态通用桥，让前端持有库逻辑会把「单写路径」撕到前端。cap.voice 薄委托 cap.mcp，引擎可替换。

### 6.2 音色库 = 参数持久化（非 voice id）
MiMo design/clone 无状态（§4.3），库存「名称 + 描述文本/样本文件」，合成时回放。**换引擎时 design 语义不跨引擎迁移**（描述文本可带过去，样本不可复用于不支持克隆的引擎）——如实交代。

### 6.3 缓存是成本护城河
MiMo 免费额度未知；hash(text+voice+style+engine) 命中即零成本。重听/重复收听/插话后重播场景覆盖率极高。

### 6.4 预生成的「后台」边界（开放问题，P2 实施前定）
App 关闭 job 即停（前端 headless）。真后台守护需 Rust 侧 tokio 任务 + 引擎调用链后端化（AI 生成目前依赖前端会话管道），成本高。**v1 接受前台约束**，UI 明示「保持应用开启」；真后台列为后续评估项。

### 6.5 插话的识别回声权衡
「停止口令」已论证常开监听（误停无害可恢复）；插话场景误触发成本高（打断收听流），采用**显式触发**（按钮/关键词「问一下」+ 半双工），与口令策略分治。

---

## 七、不做（非目标）

- 不做版权内容库、不做社交/评论/UGC 分享、不做主播形象虚拟人。
- 不做流式 TTS（句级预取流水线已消除断档，流式收益边际小、改动大）。
- 不在 P1 前动 `ttsService`（edge-tts 链路保持只读参考）。
- 不扩 `PROTECTED_SESSION_KINDS`（既有决策延续，广播会话 LRU 回收语义不变）。

## 八、总纲验收

- [ ] 每期开工前有独立子 spec（引用本文件编号），实施后回填验收记录。
- [ ] 全程遵守：前端 `tsc --noEmit` + `pnpm lint`；后端 `cargo check` + 命令门控检查；协议改动保持 Rust/前端类型同步（无运行时 schema 校验的既有缺口，契约保守）。
- [ ] 北极星指标埋点上线后，能用数据回答「用户是否真的在无限畅听」。

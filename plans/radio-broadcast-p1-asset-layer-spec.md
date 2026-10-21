# 无限畅听电台 P1 资产层 — 子 Spec（cap.voice + 两库）

> 父 spec：`radio-broadcast-infinite-listening-spec.md` §五 P1（P1-1 ~ P1-5）。四段式：目标 / 契约 / 验收 / 不做。
> 分支延续 `feat/radio-infinite-listening-p0`（P0 已落地）。

---

## 一、目标

把播报从「实时链玩具」升级为「有资产的手”台」：新增 **cap.voice**（RouterBus 能力，唯一权威），持有音色库 / 内容库 / 持久合成缓存三个存储；前端播报链改接 cap.voice，不再感知插件名；面板扩为**三页签**（畅听 / 内容库 / 音色库）。手机 file 模式可达性问题一并解决。

## 二、契约（含对总纲 §四的三处细化，实施权威以本文件为准）

### 2.1 契约细化（与总纲差异，均已论证）

1. **P1-4 落地形态 = 复用既有 `GET /api/files/*`，零新路由、插件零改动**。
   总纲原案「核心静态服务代理 /voice/audio/*」要新增 web 路由 + 插件改 url 生成；勘察发现 `/api/files/<绝对路径>?token=<md5>` 已具备鉴权、`?token` query 回退（`<audio>` src 无法带 header）、ServeFile Range 支持全套能力，且插件 `buildAudioResult` 本就返回 `file` 绝对路径（`mcpBridge` 此前只消费了 `url` 字段）。故：cap.voice 返回 `file` 绝对路径 → 前端按端构建播放 URL（Tauri → `convertFileSrc`；Web/移动 → `/api/files/?token=`，复用 `fileService.buildFilePreviewUrl`）。9861 url 不再被前端消费（仅诊断字段保留）。
2. **`voices.list` v1 只返回自定义音色**（design/clone）；预置音色不经后端逐次拉取（每次 list 拉起插件 stdio 进程不可接受），新增 `voices.presets` action 委托 `mimo_tts_list_voices`，由前端显式拉取 + 静态兜底（P0-6 机制不变，只是插件名收敛进 cap.voice）。
3. **补 `library.add`**（总纲 §4.1 漏列；无 add 则库永远为空，续播无从谈起）：`{ action:'library.add', title, topic?, engine, voiceRef, style?, source?, sentences: [{ text, audioId?, file? }] }` → 后端把 file 复制入 `<voice>/library/audio/<itemId>/<i>.wav`（cache 可被 GC，库资产必须自持）。

### 2.2 cap.voice actions（P1 全量；jobs 留 P2）

```
synthesize   { text, voiceRef, style?, outputMode?:'file'|'base64' }
             → { ok, audioId, cached, format:'wav', sizeBytes, file?, dataUrl? }
             # voiceRef = 预置名（透传）或自定义音色 id（展开参数回放）
             # design → 委托 mimo_tts_voice_design{description,text}; clone → mimo_tts_voice_clone{sample(绝对路径),text,style}
             # 缓存 key = FNV-1a(engine|voiceRef|style|text)；命中直接回文件
voices.presets   {} → { ok, voices:[{name,voiceId,language?,gender?}] }        # 委托 list_voices
voices.list      {} → { ok, voices: CustomVoice[] }                            # 仅自定义
voices.add       { type:'design', name, description } | { type:'clone', name, sampleBase64, sampleName? }
voices.update    { voiceId, name?, description? }
voices.delete    { voiceId }                                                   # 级联删样本文件
voices.probe     { kind:'preset'|'design'|'clone', voice?, description?, sampleBase64?, text? }
                 → { ok, file?/dataUrl? }                                      # 试听（固定欢迎语）
library.list     { filter?: { favorite? } } → { ok, items }
library.add      见 2.1-3 → { ok, item }
library.get      { itemId } → { ok, item }
library.update   { itemId, title?, tags?, favorite? }
library.delete   { itemId }                                                    # 删索引 + 音频目录
library.stats    {} → { ok, count, totalBytes, cacheBytes }
```

数据模型（`<dataRoot>/voice/`，经 `data_root.rs::voice_dir()` 实例层子目录）：

```
voices.json   CustomVoice[]  { id, name, type:'design'|'clone', engine, description?, sampleFile?, createdAt }
library.json  LibraryItem[]  { id, title, topic, engine, voiceRef, style?, createdAt, favorite, tags[], source, sentences:[{text,audioId?,file?}], sizeBytes }
library/audio/<itemId>/<i>.wav
cache/<fnv>.wav                                    # 持久缓存（P0-5 内存 LRU 的 L2）
samples/<voiceId>.<ext>                            # 克隆样本原件
```

### 2.3 关键实现约束

- **委托不持有**（AGENTS 唯一权威）：`VoiceCapability` 持 `Arc<dyn Capability>`（生产 = cap.mcp 同一实例，经 `RouterBus::register_handle_arc` 注册共享；单测注入 fake）。不持有 McpClient、不拉起进程。
- **权限 gate**：对齐 `mcp_capability.rs`（Bootstrap/Plugin 放行；Remote 须带 token）。破坏性动作（library.delete / voices.delete）经 bus dispatch 自动落 `dispatch.ok` 审计（mod.rs:513 既有通道）。
- **同步 invoke**：合成委托 `synth.invoke()` 本身同步（内部 block_on_async）；文件 IO 用 std::fs（wav 句级小文件）。JSON 写入 tmp+rename 防半写。
- **稳定 hash**：FNV-1a 64bit 手写（`DefaultHasher` 跨运行不稳定，不能做磁盘缓存 key）。
- **前端不感知插件名**：`mcpBridge.ts` 退役删除；新 `voiceService.ts` 是唯一 cap.voice 客户端。player 的内存 LRU（P0-5）保留为 L1，后端磁盘缓存为 L2。
- **命令门控**：voice_capability.rs 只依赖 std/serde_json/contracts，不引 tauri 类型（双构建通吃，发布前跑 `--no-default-features` 检查）。

### 2.4 前端改动

| 文件 | 改动 |
|---|---|
| `voiceService.ts`（新） | cap.voice 类型化客户端（全部 action）+ `buildAudioPlayUrl(file)` |
| `voiceBroadcastPlayer.ts` | 合成改走 `synthesizeVoice`；QueueItem 增 `audioId?/file?`；`onStart(text, meta?)`；`enqueuePrepared()`（续播就绪直插）；`takeDoneSentences()`（段完成收集，供入库） |
| `radioBroadcastController.ts` | 段完成自动入库（fire-and-forget，`source:'live'`）；`playLibraryItem(item)` 回听模式（replay：无 AI 会话，队列空即停，`stopReason:'finished'`） |
| `radioBroadcastPanel.tsx` | 三页签（畅听/内容库/音色库）；内容库（列表/收藏/删除/续播）；音色库（预置/设计向导/克隆上传三分区 + 试听 + 入库） |
| `radioBroadcastStore.ts` / `useRadioBroadcast.ts` | 透传 `playLibraryItem`、`stopReason:'finished'` |
| i18n | 新增 keys（双语） |

## 三、验收

- [ ] Rust：`cargo check` + `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` 通过；`#[cfg(test)]` 单测（gate 拒绝/放行、voices CRUD 往返、library add/list/update/delete/stats、synthesize 缓存命中走 fake synth、FNV 稳定性）随代码提交（本机 `cargo test --lib` 受 DLL 限制不跑，CI 跑——如实记录）
- [ ] 前端：`tsc --noEmit` / lint / vitest 全绿；播报合成链改走 cap.voice（mcpBridge 删除后无残留引用）
- [ ] 音色：设计向导 描述→试听→命名入库→播报可用（voiceRef=id）；克隆同型
- [ ] 内容库：播报段自动入库；续播零 AI 成本（enqueuePrepared 直播）；删除/收藏即时生效
- [ ] 移动端 file 模式可达：播放 URL = `/api/files/<abs>?token=`（同源可达）

## 四、不做（P1 边界）

- jobs 预生成（P2-3）、换台/插话（P2-1/2）、AI 管家（P2-4）、埋点（P2-5）
- 不动 ttsService（edge-tts）、不动 `PROTECTED_SESSION_KINDS`
- 缓存 GC 配额策略 v1 从简（超 500MB 时全清 cache 目录，items 不受影响）
- 双引擎路由表（engineId → plugin 映射）v1 单引擎常量，结构预留

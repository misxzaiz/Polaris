# 语音与播报域移除记录（2026-11-12）

> **决定**：用户裁定「可先直接移除，平时都不用」——不做插件化，直接从宿主删除整套语音与播报能力。
>
> **取代关系**：本文取代 `radio-broadcast-*.md` 系列（14 份）与 `global-voice-wake-analysis.md`、`mimo-tts-radio-400-fix.md` 中的**实施授权**。那些文档保留为历史记录（说明当时为什么这么设计），不再作为实施依据。

---

## 1. 为什么没选「插件化」

上一轮分析给出三条路径：完全移除 / 插件全承载 / 保留宿主。判据如下：

| 子系统 | 规模（有效行） | 插件化阻塞点 |
| --- | --- | --- |
| 电台 RadioBroadcast | ~4,600 | `radioBroadcastController` 走 `subscribeKernelSessionState` 自建 AI 会话；插件拿不到宿主 session kernel |
| 语音伙伴 VoiceCompanion | ~1,300 | 全局浮层（非席位），需拦 AI 流做流式 TTS；宿主无对应槽位 |
| TTS 基础层 | ~1,700 | `edge-tts-universal` 纯前端可移植，但需注入输入区/右键菜单/设置页三处槽位 |
| 语音输入 ASR | ~214 | 移动端 `SpeechBridge.kt` 是宿主 Android 工程代码，插件改不了 |
| cap.voice 资产层 | 1,044 | 可出仓，依赖 `cap.mcp` 合成 |

结论：插件化需要新增 **5 类宿主槽位**（输入区工具、设置页 tab、右键菜单项、全局 overlay、会话事件钩子）+ 移动端原生桥接无法迁移。成本高于收益，而用户明确不用，故直接删除。

## 2. 删了什么

两个提交，可分别 revert：

| commit | 范围 | 规模 |
| --- | --- | --- |
| `5869dd11` | 前端全域 + i18n + 依赖 + 移动端桥接 | 85 文件 / −13,578 行 |
| `7c7012bf` | 后端 `cap.voice` 出仓 | 6 文件 / −1,254 行 |

### 2.1 前端（`5869dd11`）

- **面板/浮层**：`components/RadioBroadcast/`、`components/VoiceCompanion/`、`Settings/tabs/SpeechTab.tsx`
- **服务层**：`services/voiceBroadcast/*`（10 文件）、`services/voiceCompanion/*`（2）、`ttsService`、`speechService`、`nativeSpeechService`、`voiceNotificationService`、`voicePackageService`、`voiceLatencyMeter`、`audioFocusManager`、`ttsTextFilter`、`cryptoPolyfill`
- **hooks**：`useTTS`、`useTtsVolume`、`useVoiceDictation`、`useVoiceCompanion`、`useRadioBroadcast`
- **stores**：`voiceInputStore`、`voiceCompanionStore`、`radioBroadcastStore`、`radioBroadcastPrefsStore`
- **types**：`types/speech`、`types/voiceCompanion`
- **i18n**：zh-CN/en-US 同步删 22 个 key 路径（−504 行），含 `radioBroadcast` 整个 50-key 命名空间
- **依赖/构建**：`package.json` 去 `edge-tts-universal`；`vite.config.ts` 去只为 `cryptoPolyfill` 存在的 `treeshake.moduleSideEffects` 特判
- **移动端**：`SpeechBridge.kt` 删除 + `MainActivity` 去掉 `addJavascriptInterface`；`mediaPlaybackRequiresUserGesture = false` **保留**（其他音频仍需要）

### 2.2 后端（`7c7012bf`）

- `services/router/voice_capability.rs` 整个删除（1,229 行文件 / 1,044 行有效代码）
- `state.rs` 去掉注册块；`cap.mcp` 的 Arc 包装随之简化
- `bus_mcp_server.rs` 的 `MODULE_DOMAINS` 去掉 `("voice", &["cap.voice"], None)`——**AI 工具面少一个 voice 域**
- `registry_capability.rs` 的 `OVERRIDE_L4_PREFIXES` 去掉 `"cap.voice"`
- `data_root.rs` 去掉 `voice_dir()`

## 3. 刻意保留的东西

| 项 | 理由 |
| --- | --- |
| `contracts/mod.rs` 三处提到 cap.mcp / cap.voice 的注释 | 2026-10-25 契约审计的历史记录，解释 describe 标准形状为何统一，删了丢审计依据 |
| `utils/toolConfig.ts` 的 `'mimo-tts': '语音'` | mimo-tts 插件仍在商城，这是工具名→分类标签映射 |
| `mediaPlaybackRequiresUserGesture = false`（移动端） | 服务其他音频播放，非 TTS 专属 |
| mimo-tts 插件及其 MCP 工具 | 已收录的独立插件，AI 仍可直调；只是失去宿主侧缓存与音色管理 |

## 4. 遗留待决

1. **插件仓 `radio-broadcast` 插件**（v1.0.0，未收录进 `index.json`）——宿主内置面板已删，该插件是同一功能的独立实现。要么删掉该插件目录、要么收录它作为「想用的人自己装」的出路。**需用户裁定。**
2. `src/stores/conversationStore/types.ts` 的会话 `kind` 已去掉 `'radio-broadcast'`；历史持久化数据里若存在该值，运行时不报错（纯类型约束）。
3. `public/ic-sound-test/` 两个声音测试页仍在（与语音域无关，测的是交互卡片音效，未受影响）。

## 5. 验收口径

- `npx tsc --noEmit` → exit 0
- `npx vitest run` → 133 文件 / 1,868 用例全通过（较移除前少 7 个测试文件，均为被删语音测试）
- `npx vite build` → 成功
- `cargo check --lib --tests` → exit 0
- 全仓 grep：`cap.voice` / `VoiceCapability` / `voice_dir` / `ttsService` / `speechService` / `voiceInputStore` 无活跃引用（注释性历史说明除外）

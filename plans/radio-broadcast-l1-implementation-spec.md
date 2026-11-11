# spec：B2-1 语音电台 L1 外移实施执行清单

> 状态：**实施中，步骤 1/7 已完成**（方案见 `plans/radio-broadcast-extraction-spec.md`，2026-11-10 用户定案；2026-11-11 获批起批） · 日期：2026-11-11 · 进度回填：2026-11-11
> 上游：`plans/core-slimdown-plugin-extraction-plan.md` §4.2 B2-1、`AGENTS.md` §五 / §九
> 边界：只做 **L1 前端外移**；`cap.voice`（`voice_capability.rs` 1229 行）阶段一保留在宿主；不改播报 / 合成 / 打断语义；不动 Chat 主链路。

## 1. 目标

主仓净删 ≈ 10.5k 行 → 插件仓新建 `plugins/radio-broadcast` 承接面板 + 控制器 / 播放器 / 服务 + stores；桌面 / Web 双端功能等价，发布解耦。

## 2. 前置状态（2026-11-11 复核，含三处口径更正）

| 项 | 真实状态 |
|---|---|
| §6-1 hostInvoke 白名单 | **部分落地**：`main.tsx:35` 宿主级全局 14 条命令，非插件级。B2-1 沿用现有桥，不新增攻击面；插件级裁剪另行 spec |
| §6-2 manifest 校验 | 本轮补齐 panel / services / chatCards / configSchema 四块（见 `plans/manifest-validation-completion-spec.md`） |
| §6-3 Web 服务管理放行 | ✅ **早已落地**（`policy_permission.rs:248-254` 以 `require_auth` Allow 放行整个 `cap.pluginServiceManager`），**不是阻塞项**；`im-integration-extraction-spec.md` D4 旧表述作废 |
| D1 `cap.voice` 归属 | 阶段一保留薄通道，插件经 `router_dispatch` 调用；`bus_dispatch` 可动态指定 target，字面 grep 无法证明零消费者，删除需独立审计 spec |
| D3 根层浮层 | `VoiceCompanionOverlay` 挂在 `App.tsx` 根层 → 改插件面板 + 宿主 slot / `cap.ui.render` 帧注入，宿主不留硬编码 |
| D4 打断 / 停播幂等 | `voiceStopWatcher` 逐项回归，迁移不改 stop / interrupt 语义（`AGENTS.md` §4.2） |

## 3. 提交序列（不混批，一次一个主题）

1. **插件仓 · 骨架**：✅ **已完成**（插件仓 commit `2b98ed9`，11 文件 / 417 行）。新建 `plugins/radio-broadcast`（`plugin.json` + `update.json` + `package.json` + `tsconfig.json` + build 脚本 + `.pluginignore` / `.gitignore` + `src/host.ts` + 占位面板 + 契约自检），`dist/panel.js` 可构建（esbuild ESM，react / react-jsx-runtime external）。参照 `ai-scheduler` 配方。验收：`npm run build` + `npm run typecheck` + `node --test` 4/4 + 插件仓 `node scripts/validate.js` 全绿。本地提交未推送，随步骤 7 发布链一并推。
2. **插件仓 · 迁入代码**：面板 / 控制器 / 播放器 / 服务 / stores 迁入；宿主依赖改走公共通道：`cap.voice`（RouterBus）、`cap.ai.chat`、`cap.kv`（偏好与资产索引）、`cap.ui.chat`（送到会话）、`__POLARIS_HOST_INVOKE__`。
3. **插件仓 · 验证与打包**：`node --test` 离线用例 + SSR 渲染冒烟 + `node scripts/validate.js` + 打包 zip；复用 `mimo-tts` 的 TTS 能力 / 约定，不新建第二个 TTS 引擎（D2）。
4. **主仓 · 摘壳**：`builtinPlugins.ts` 摘 `radio-broadcast.panel` view；`App.tsx` 摘 `radioBroadcastContent` / `VoiceCompanionOverlay`；ToolSwitcher 分组与 i18n 注册点同步摘。
5. **主仓 · 删码**：按 §4 清单全删，门禁全绿。
6. **文档同步**：总纲 §4.2 标 B2-1 完成、`AGENTS.md` §五（`cap.voice` 未动则清单不变）、本 spec 回填验收记录。
7. **插件仓发布链**：`index.json` 条目 + zip 入库 + tag `radio-broadcast-v1.0.0` + push。**注意 B1-6 踩过的三个坑**：`.gitignore` 放行 zip、`origin.updateUrl` 指 `update.json`、`downloadUrl` 用 tag 而非 `@main`（详见 `scheduler-plugin-extraction-spec.md` §8 发布记录）。

### 3.1 步骤 2 输入：宿主交界实测（2026-11-11）

扫描主仓待迁 **31 个 `.ts/.tsx` 文件**：

- **宿主命令只有 `router_dispatch` 一个**，且在 `main.tsx` `HOST_INVOKE_ALLOWLIST`（14 条）内 → L1 通道可行，无需新增白名单命令；`cap.voice` / `cap.ai.chat` / `cap.kv` / `cap.ui.chat` 全走 RouterBus，后端权限 gate 与审计不变。
- **宿主别名依赖 41 种 / 95 处 `@/` 引用** —— 步骤 2 不是简单复制，需逐项消除。
- 第三方：`react`×5、`zustand`×4（+middleware）、`lucide-react`×3、`clsx`×3、`react-i18next`×1、`edge-tts-universal`×2、测试侧 `vitest`×4。

| 硬交界（不能原样搬） | 处置方向 |
|---|---|
| `@/services/tauri/fileService`（`buildFilePreviewUrl`） | 音频播放 URL 构造（Tauri asset / Web `/api/files?token=`），需宿主薄通道或插件侧等价实现 |
| `@/stores/conversationStore/*`、`@/session-v2/hooks/useKernelSessionState` | 会话状态改走公共通道；`kind:'radio-broadcast'` 枚举保留宿主 |
| `@/components/Chat/session/SessionConfigSelector` | 宿主组件 → 插件自带最小选择器或宿主 slot |
| `@/stores/configStore` / `toastStore` / `workspaceStore` / `engineMetadataStore` | → `cap.kv` 与插件自有 store |
| `@/hooks/useTtsVolume`、`@/services/transport` | 宿主专有，需薄通道或插件内实现 |
| `@/utils/logger`（15 处） | 插件自带 logger |
| `@/types/*`（约 23 处，纯类型） | 整包搬入 `src/types` |
| `VoiceCompanionOverlay`（`App.tsx` 根层浮层，D3） | 改 `cap.ui.render` 帧 / 面板 slot，宿主不留硬编码 |

> 结论：步骤 2 之前建议先出一份「宿主交界替代方案」短 spec，把上述 8 类交界的通道归属定死，再迁代码；否则 10.5k 行搬完仍装不上。迁移须保留 `voiceService.ts` 的「`res.ok` + `result.error`」双重判定与 `voiceStopWatcher` 的 stop/interrupt 幂等（`AGENTS.md` §4.2）。

## 4. 主仓删除清单

- 组件：`components/RadioBroadcast/` 2,044、`components/VoiceCompanion/` 476
- 服务：`services/voiceBroadcast/` ~3,100（controller / player / voiceService / voiceStopWatcher / synthCache / constants / types）、`speechService.ts` 683、`ttsService.ts` 617、`services/voiceCompanion/`（streamingTts 309 + companionPrompt 71）、`voiceNotificationService.ts` 241、`voicePackageService.ts` 211、`voiceLatencyMeter.ts` 265、`nativeSpeechService.ts`、`audioFocusManager.ts`
- hooks：`useVoiceCompanion.ts` 620、`useVoiceDictation.ts` 238、`useRadioBroadcast.ts` 133
- stores：`radioBroadcastStore.ts`、`radioBroadcastPrefsStore.ts`、`voiceCompanionStore.ts` 149、`voiceInputStore.ts` 66
- 以上对应测试、i18n 节、`builtinPlugins.ts` view、`App.tsx` 三处接线、`hooks/useAppInit.ts` 初始化、`useAppEvents.ts` 事件接线（实施前逐个确认）
- **保留**：`conversationStore/types.ts:795-838` 的 `kind:'radio-broadcast'` 会话标记（插件经既有 `onSendToChat` / chatCards 机制标注）、`router/voice_capability.rs` + 注册行

## 5. 宿主交界清单

| 交界 | 处置 |
|---|---|
| 锁屏控制 / 媒体键 / 系统通知 / 音频焦点 | 实施前逐项确认属宿主能力还是可插件自接管；属宿主则留薄通道 |
| 根层语音浮层 | 改 `cap.ui.render` 帧 / 面板 slot，不在 `App.tsx` 留硬编码 |
| 会话标记 | 保留宿主枚举，插件用公共机制标注 |
| Web 模式 | 音频播放可用；TTS 若依赖本地能力需在插件描述显式声明降级 |

## 6. 验收

- 主仓：`pnpm typecheck` + `pnpm lint` + `pnpm test:run` + `cargo check` + `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` 全绿。
- 行数对账：净删 ≈ 10.5k（±20%）；无死 manifest / 死 i18n key / 孤儿 store。
- 插件仓：`node scripts/validate.js`；安装 → 启用 → 电台开播 → TTS 合成 → 断点续播 → 锁屏 / 媒体键 → AI 伴播 → 禁用；`update.json` 热更新验证一次。
- 双端（桌面 / Web）回归；三处同步（主仓 / 插件仓 / `AGENTS.md` §五若 cap 有增删）。

## 7. 主仓代码仍未动的原因

按总纲 §9 提交序列，步骤 4「摘壳」与步骤 5「删码」必须在步骤 3「插件 zip 可安装」之后，否则会出现「电台功能已消失、插件尚未发布」的断链窗口。前一轮完成的是**前置闭环**（B1-6 发布链 + §6-2 地基 + 本执行清单），本轮完成**步骤 1 插件仓骨架**（`2b98ed9`）与 B1-6 发布包的 manifest 缺陷修复（v1.0.1）；**主仓代码零改动**。下一步从步骤 2 开始，插件包完整就绪后再一次性摘壳删码，保证任意时刻功能可用。

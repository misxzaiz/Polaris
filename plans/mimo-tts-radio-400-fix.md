# mimo-tts 电台 400 Param Incorrect 修复

日期：2026-10-25。状态：已实施。

## 问题

电台启动预检失败，报 `mimo-tts 不可用：{"error":"MiMo API 调用失败: HTTP 400: Param Incorrect"}（请检查插件 API Key 配置）`，但插件 API Key 实际有效（实测无效 key 返回 401 Invalid API Key，与本错误无关）。

## 根因（已实测复现）

1. `src/services/voiceBroadcast/constants.ts` 静态兜底音色表把**显示名** `MiMo-默认` 当作 id（API 白名单是 `mimo_default`）。`RadioBroadcastPanel` 把静态表合并进动态下拉，两个"MiMo-默认"选项 label 相同无法区分；选错后 prefs/lastSession 持久化非法 voice，透传给 `mimo_tts_synthesize` → 上游 400 `Unknown voice: MiMo-默认`。
2. 插件 `mcp/server.js` 错误处理只读 `error.message`（"Param Incorrect"），丢弃 `error.param`（真实原因），错误串无信息量。
3. `radioBroadcastController.probeMimo` 对一切失败硬编码"（请检查插件 API Key 配置）"，参数错误被误导成 key 问题。
4. ~~潜伏 bug：voiceclone 传 data URL~~ **证伪**：实测 API 明确要求 voiceclone 的 `audio.voice` 为 DataURL（纯 base64 被拒 "audio.voice must be a DataURL for voice clone model"；真实 wav + DataURL 实测 200）。原实现正确；早先误判源于一个自造的损坏 wav 样本（报 "invalid audio format"）。本次仅补 10MB 样本上限校验与注释澄清。

## 改动点

- Polaris `src/services/voiceBroadcast/constants.ts`：`MiMo-默认` id → `mimo_default`；新增 `normalizeVoiceId()` 纠正历史存量值。
- Polaris `src/stores/radioBroadcastPrefsStore.ts`：persist v1 迁移，历史 voice=`MiMo-默认` → `mimo_default`。
- Polaris `src/components/RadioBroadcast/RadioBroadcastPanel.tsx`：lastSession 读入时 `normalizeVoiceId`。
- Polaris `src/services/voiceBroadcast/radioBroadcastController.ts`：仅当错误含 401/未配置 Key 才提示查 Key，其余原样透出。
- 插件仓库 `plugins/mimo-tts/mcp/server.js`（**同步改安装副本** `%APPDATA%\Polaris-dev\plugins\mimo-tts\mcp\server.js`）：① 错误串附带 `error.param`；② voiceclone 样本 10MB 上限校验 + 注释澄清 DataURL 语义（原 data URL 实现本就正确，保留）。

## 验收

- `pnpm exec tsc --noEmit` 通过；改动文件 eslint 通过；radioBroadcast 相关 vitest 通过。
- MCP stdio 实测（真实 key）：`mimo_tts_synthesize` 预置音色 200；非法 voice 报错包含 `Unknown voice: ...` 明细；`mimo_tts_voice_clone` 本地真实 wav 样本成功合成。

## 遗留

- 安装副本含未入库的 LAN audioHost 特性（手机经局域网听音频），仓库无此代码；本次两处修复同时打在两边，特性差异保持原样，发布打包时需先合并。
- 生产数据根未安装 mimo-tts 且 apiKey 为空，生产环境如需使用另行安装配置。

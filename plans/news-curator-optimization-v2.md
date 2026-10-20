# news-curator 插件优化迭代 spec（v0.2.0）

> 日期：2026-10-20
> 范围：修插件面板与主应用断点 + 真实语音 + 历史日报
> 相关仓库：主应用 `D:\space\base\Polaris`，插件仓库 `D:\space\base\Polaris-plugin\plugins\news-curator`，安装目录 `D:\app\polaris-s\plugins\news-curator`（数据根由 `D:\app\polaris-s\anchor.json` 指向）

## 背景 / 问题（诊断结论）

1. **发送链路全断（根因）**：`LeftPanel.tsx:296` 渲染外部插件面板 `PluginPanelHost` 时没传 `onSendToChat`；`main.tsx` 只挂 `__POLARIS_HOST_INVOKE__`，未挂 `__POLARIS_SEND_TO_CHAT__` / `__POLARIS_HOST_PANEL__`。→ news-curator 面板「生成日报 / 生成语音 / 听讲 / AI 提问」按钮静默无效。
2. **语音是占位**：`Voice.tsx` 播放条硬编码 `width:'55%'`，无真实 `<audio>`；合成依赖断掉的发送链路 → 完全没反应。
3. **无历史日报**：面板只 `loadDaily(today())` + 回退昨天，无日期选择；cap.kv 有 `list` 可枚举 `news.daily.*` 但未使用。
4. app 端播放：主应用已有完整连续播报设施（`services/voiceBroadcast`），但 news-curator 未接入。

## 目标 / 验收

- [x] 主应用把 `sendMessage` 透传到插件面板（`onSendToChat` props + 全局桥兜底），面板所有发送按钮生效
- [x] 语音真实可播：AI 合成后存 `news.voice.<date>.<section>`（dataUrl/url），面板 `<audio>` 播放，进度真实
- [x] 历史日报：新增「历史」Tab，枚举日期倒序，可回看任意一天
- [x] Today 加刷新按钮
- [x] 版本 0.2.0，仓库/安装目录同步，`node --check` 语法通过，主应用 `tsc --noEmit` 通过

## 改动清单

### 主应用（D:\space\base\Polaris）
- `src/components/Layout/LeftPanel.tsx`：`LeftPanelContent` 新增 `onSendToChat` prop，传给 `PluginPanelHost`
- `src/App.tsx`：`<LeftPanelContent onSendToChat={(msg)=>{void sendMessage(msg)}} />`；`useEffect` 里给 `window.__POLARIS_SEND_TO_CHAT__` 注入真实 sendMessage
- `src/main.tsx`：声明 `window.__POLARIS_SEND_TO_CHAT__`（空实现占位，避免插件在 App 挂载前调用崩溃）

### 插件仓库（Polaris-plugin/plugins/news-curator）
- `mcp/server.js`：
  - 新增 `news_save_voice`（AI 合成后存音频缓存，dataUrl/url 二选一）
  - 新增 `news_list_daily`（cap.kv list 枚举 `news.daily.*` 日期倒序）
  - 版本 0.2.0
- `src/model.ts`：新增 `loadVoice` / `loadDateKey` / `kvListKeys` / `listDailyDates` + `VoiceClip` 类型
- `src/Voice.tsx`：真实合成 + 播放（轮询缓存、`<audio>` timeupdate 进度、未合成点生成走 sendToChat）
- `src/Archive.tsx`：新增历史日报页（日期横滚 + 板块卡片 + 语音标记）
- `src/Panel.tsx`：Tab 加「历史」（第 4 个，index 3）
- `src/Today.tsx`：加刷新按钮
- `plugin.json` / `package.json`：版本 0.2.0，描述更新

### 安装目录（D:\app\polaris-s\plugins\news-curator）
- 同步 `dist/panel.js`、`mcp/server.js`、`plugin.json`

## 协议（cap.kv 键空间新增）

```
news.voice.<date>.<section>   # { section, dataUrl?, url?, title?, durationSec?, createdAt }
```

## 依赖与边界

- 语音合成依赖 mimo-tts（MCP 工具 + config 里 `plugins["mimo-tts"].apiKey`，已配 `sk-cj0...`）
- app 端 `<audio>`：优先 dataUrl（base64 内联跨端可靠），file 托管 url 需局域网可达（audioHost 配置）
- 发送按钮首路径 `onSendToChat` props，兜底 `window.__POLARIS_SEND_TO_CHAT__`
- 面板轮询合成：最长 ~100s（40 次 × 2.5s），超时提示重试

## 验证结果

- `pnpm exec tsc --noEmit`（主应用）：通过
- `npm run build`（插件）：产 dist/panel.js 73.8kb
- `node --check` server.js：通过
- eslint 改到文件：0 errors（8 个既有 no-explicit-any warning）
# 今日新闻视频：创建 + 自动发布 — 执行规划 v1

> 状态：In Progress ｜ 创建：2026-10-18 ｜ 关联插件：`animation-2d` + `mimo-tts` + `news-curator` + `douyin-publish`
> 内容源：**今日日报已确认存在**（2026-10-18，见 `news_get_daily`），用户偏好音色 **冰糖**。
> 前置 spec：`plans/douyin-auto-publish-plan.md`、`Polaris-plugin/plugins/douyin-publish/PLAN.md`

---

## 1. 目标

做一条 **15~25s 水墨风手绘「今日新闻快报」短视频**，用 2d 引擎绘制 + MiMo 冰糖配音 + 新闻日报内容，最后经 douyin-publish 全链路发布到抖音（幂等登记、声音收集归档）。

## 2. 链路与归属

```
news-curator                    mimo-tts                  animation-2d                    douyin-publish
news_get_daily → 选 2~3 条    mimo_tts_synthesize      scene js（PROJECT.duration）     douyin_prepare_publish
      │         → news_brief      │  冰糖+风格          │  与旁白时长对齐                douyin_pick_file
      │         → 旁白稿          → 旁白 wav             → render_video --audio=wav       douyin_record_result
      │                            → ffprobe 测时长      → vision_check 质检              douyin_collect_audio
      └──────────────────────────────────────────────────────────────────────────────────→ 发布 + 声音归档
```

- **内容（谁定）**：AI 从日报 sections 选 2~3 条最有画面感的（基金周复盘/AI 技术/时事），转旁白稿。
- **配音（谁产出）**：mimo-tts `冰糖`（用户偏好 voice=冰糖、speed=1）。
- **画面（谁画）**：2d 引擎水墨风，**无文字铁律**（内容全靠画面+旁白表达）。
- **发布（谁执行）**：AI 用内置浏览器 + douyin-publish MCP。

## 3. 内容脚本（分镜草案）

基于日报 sections：

| # | 源 section | 内容 | 画面构想（无文字） |
|---|---|---|---|
| A | summary | 周日一周复盘：权益回调、债市稳坐 | 水墨山景，K 线化作山峦起伏（下坡），一株小苗（债）稳稳立着 |
| B | fund | 011369 一周 -14.79% 领跌 | 主角（小铁 robot 或翠花）抱着一根大滑梯/下坠箭头，愁眉 |
| C | tech/news | DeepSeek 许愿编程 + 算力草原 | 主角在一张纸上"许愿"，星星/代码光点涌出，草原上风车转动 |
| D | 收尾 | 周一看算力情绪 | 主角望向日出，挥手，iris 收尾 |

> 具体角色/镜头在分镜 STORYBOARD.md 细化；严格遵循 ANIMATION_GUIDE（事件/转场/收尾呼应）。

## 4. 技术要点（已核实）

- 2d `render.mjs --audio=xxx.wav` 支持混入**任意音频**（`-map 0:v -map 1:a -shortest`），wav 直接可用。
- **顺序必须先配音再定动画时长**：ffprobe 测 wav 时长 → `config.js PROJECT.duration` 对齐（留片头片尾 ~1s）。
- 渲染产物默认 `out/video.mp4`；配音 wav 在 mimo-tts `<pluginDir>/audio/`。
- 发布走 douyin-publish 6 工具（幂等按 sha256，声音收集 `douyin_collect_audio` 自动标记有音轨）。

## 5. 验收标准

- [ ] 一条 15~25s 水墨手绘视频，有冰糖配音，画面无文字、有转场、有完整故事弧
- [ ] `douyin_prepare_publish` 登记 → 上传 → 发布成功（管理页可见「已发布」）
- [ ] `douyin_collect_audio` 记录 hasAudioTrack=true + voiceId=冰糖
- [ ] 产物落 `temp/claude-animation-base/out/` 或动画 out/，有文件名记录

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 日报内容偏基金，画面难表现 | 选有画面感的（DeepSeek/流星雨/机器人），基金用抽象山峦 |
| 配音时长与动画不齐 | 先测 wav 时长再定 duration，宁可动画稍长用 `-shortest` |
| 2d 渲染慢 | 先 `--sheet` 看静帧，再 `--frames --workers=4` 并行 |
| 抖音发布风控 | 走已跑通的 douyin-publish 流程，间隔发布 |

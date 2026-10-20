# 抖音视频自动发布 — 规划 v1

> 状态：Proposed ｜ 创建：2026-10-18 ｜ 来源：手工跑通一次发布（duyu.mp4 → 抖音创作者中心「已发布」）
> 目标：把「内置浏览器 + 原生文件对话框注入 + 页面自动化」的发布流程固化为可复用、可验收的半自动发布程序。
> 约束：AGENTS.md §2「spec 优先」；涉及外部平台行为，所有步骤必须基于已实测事实，不臆造接口。
> 实现落地：**`Polaris-plugin/plugins/douyin-publish/`**（MCP 工具插件，见其 PLAN.md/README.md），
> 声音信息收集已随插件实现（`douyin_collect_audio`）。

---

## 1. 背景与问题

2026-10-18 手工发布 `duyu.mp4`（29M / 24.0s / 1920x1080）到抖音成功：`create_v2` 接口 200，管理页刷新后作品「水墨动画测试 · 已发布」。全程约 10 分钟、踩坑 2 个（按钮视口外点击失效、点击被浮层遮挡）。

现状问题：
1. **流程全靠 AI 现场摸索**：无固化 SOP，每发一条都要重新踩一遍坑。
2. **脚本是硬编码的一次性文件**（`temp/enumwin.ps1`、`setfile2.ps1` 里 hwnd 写死），不可复用。
3. **无幂等记录**：发完就丢，不知道哪些视频已发、item_id 多少。
4. **候选视频堆积**：`out/` 下已有 5 个成片（duyu/sprout/tengwang_v1/video + 后续产出），缺批量发布管线。

## 2. 已实测事实（本 spec 的依据，均验证过）

| # | 事实 | 验证方式 |
|---|---|---|
| F1 | 上传入口：创作者中心上传页点「上传视频」→ 弹出**原生文件对话框**（class `#32770`），非页面内 input 可填 | browser_click + 桌面 inspect |
| F2 | 对话框 hwnd **每次不同**，须实时枚举；文件名 Edit 用 `SendMessageW(WM_SETTEXT)` 写入，打开按钮 `SendMessage(BM_CLICK)` | PowerShell Win32 API |
| F3 | **bash 直接执行含 `$_` 的 ps1 会被膨胀破坏** → 必须先 `write_file` 落盘再执行 | 实测踩坑 |
| F4 | 上传完成后控制台打印 `isUploading false`，视频元数据（时长/分辨率）解析成功 | browser_console_log |
| F5 | 发布按钮初始可能**在视口外**（y=691 > 视口 620），`browser_click` 按坐标点会落空 → 先 `scrollIntoView` | browser_diagnostics rect |
| F6 | `browser_click` 会被页面浮层遮挡 → 发布按钮用 **JS `element.click()`** 最可靠 | 实测对比 |
| F7 | 标题输入框用 `browser_fill` 直接填 | 实测 |
| F8 | 发布成功 → 页面跳转 `creator.douyin.com/creator-micro/content/manage?enter_from=publish` | 实测 URL |
| F9 | 管理页列表**有缓存**，刚发布的视频不会立即出现 → 须 `browser_reload` 后再读取 | 实测（刷新前第一条是旧作品） |
| F10 | 网络日志可见 `create_v2` 接口返回 200（含作品数据） | browser_network_log |
| F11 | 浏览器 tab 已登录创作者中心，cookie 持久 | 会话复用 |

## 3. 技术路线对比

| 路线 | 形态 | 可控性 | 风险 | 判定 |
|---|---|---|---|---|
| A. MCP browser + 桌面注入（当前路径固化为 playbook + 参数化脚本） | AI 半自动执行 | 高（可逐步确认） | 低（保留人肉复核） | ✅ **主选** |
| B. 抖音开放平台 API（`video.create` 等） | 全自动 | 高 | **需企业主体 + 应用审核**，个人号不可用；审核周期不可控 | ❌ v1 不做 |
| C. 独立 RPA（Playwright/Selenium 直连 WebView2） | 全自动 | 中 | 登录态维护复杂、易被风控、与 Polaris 内置浏览器能力重复 | ❌ |

**结论：v1 采用路线 A**——把已跑通的手工流程参数化 + 状态化，AI 按 playbook 执行，发布点前强制人工确认（AGENTS.md 精神：不把外部不可逆动作做成静默自动化）。

## 4. 目标与非目标

### 4.1 目标
- G1 一条命令/一段 SOP 发布任意 `out/*.mp4`，标题/描述/话题可参数化
- G2 每步可断点恢复：上传完中断 → 下次从填表继续，不重传
- G3 幂等：已发布记录 item_id，重复执行不二次发布
- G4 结果可追溯：发布日志落 `temp/douyin-publish/state.json`（或 cap.kv）

### 4.2 非目标
- 不做无人工的无人值守批量发布（风控 + 审核不可控）
- 不做定时发布（平台「定时发布」功能可后续走 UI 勾选，不自行调度）
- 不做 B 路线 API 申请
- 不做数据/统计抓取（播放/点赞分析另议）

## 5. 架构与归属

```
temp/douyin-publish/
├── README.md            # playbook（AI 执行指南，含每步验证断言）
├── pick_file.ps1        # 参数化：按标题枚举 #32770 对话框并注入路径+点打开
├── fill_meta.sh?        # 无 —— 标题/描述/话题走 browser_fill，见 playbook
├── state.json           # 幂等记录 [{file, title, status, item_id, url, ts}]
└── log/<date>.log       # 每步结果
```

- **所有者**：AI 会话（按 playbook 执行）；人类负责「发布前确认」与「登录态维护」。
- **状态所有权**：`state.json` 单点写入，禁止双写路径（AGENTS.md §2.2）。

## 6. 发布状态机（时序图）

```
[输入] file + title + desc + topics
   │
   v
待发布 ──校验文件(ffprobe 时长/尺寸)──▶ 就绪
   │                                    │
   │  ① 打开上传页 / 复用已登录 tab       │
   v                                    v
上传中 ◀─pick_file.ps1 注入原生对话框──── 上传页
   │
   │  ② 轮询 console：isUploading false + 元数据出现（超时 120s）
   v
填写中 ──③ browser_fill 标题/描述/话题──▶ 可发布
   │
   │  ④ 人工确认「发布」？（半自动保留点）
   v
发布中 ──⑤ scrollIntoView + JS element.click()──▶ 等待跳转 manage
   │
   v
待确认 ──⑥ 管理页 reload，轮询 find 标题文本 + 抓 item_id/URL
   │
   v
已发布 ✅（写 state.json：status=published, item_id, url）
   │
   [可选] 审核中 → 平台侧异步，不轮询（写 status=under_review 结束）
```

### 关键断言（每步失败即停止，不盲目重试）
1. `pick_file` 后 5s 内控制台出现该文件名 → 否则重枚举对话框（hwnd 失效是 F2 常态）
2. 上传轮询 120s 无 `isUploading false` → 失败，保留页面供人工检查
3. 发布点击后 30s 无 URL 跳转 manage → 查网络日志 `create_v2` 状态码；200 但无跳转 → 手动刷新确认
4. 管理页 reload 后 `hasTitle:false` 两次 → 记为「疑似已受理但列表未更新」，人工确认，**不重复点发布**

## 7. 关键实现细节（复用已踩坑结论）

1. **ps1 参数化**：`pick_file.ps1 -DialogTitle 打开 -FilePath D:\...\duyu.mp4`
   - 枚举 `EnumWindows` + `GetClassName = "#32770"`（可见）→ `EnumChildWindows` 找 `Edit`（写入）与 `Button` 文本「打开(O)」（点击）
   - 找不到 Edit/Button 时输出 `ERR_NO_EDIT` 便于 AI 分支处理
2. **脚本落盘再执行**：永远先 `write_file` 写 `.ps1` 再 `bash powershell -File`（F3）
3. **发布按钮**：`browser_evaluate_script` 内 `scrollIntoView({block:'center'})` 后 `element.click()`（F5/F6）；点击后断言 URL 变化（F8）
4. **结果确认**：跳转后 `browser_reload` + 等 `network_idle` + 抓卡片文本匹配标题（F9），并从 `work_list`/`create_v2` 响应提取 item_id（F10）
5. **幂等**：开跑前读 `state.json`，`file 的 sha256` 已存在且 status=published → 直接跳过
6. **tab 归属**：每次发布用独立 tab（`browser_acquire create`），结束后关闭，避免污染手动浏览

## 8. 风险与边界（如实交代）

| 风险 | 等级 | 对策 |
|---|---|---|
| 登录态过期 / 风控（频繁自动化上传） | 中 | playbook 第一步断言登录态；发布间隔建议 ≥ 2 分���；异常先人工 |
| 抖音 UI 改版（selector/对话框结构变化） | 高 | 断言全部基于**可见文本 + 控制台日志**，selector 变化时 AI 现场适配（本方案的抗性就在于此） |
| 原生对话框自动化被系统安全策略拦截 | 低 | 已实测通过；失败时回退「人工选文件」分支 |
| 重复发布 | 低 | sha256 幂等（§7.5） |
| 审核不通过 | 中 | 只记录状态，不做自动申诉/重发 |

## 9. 验收标准

- [ ] 发布 `out/sprout.mp4`（34M）一条：标题/描述可参数化，全程按 playbook 无需现场摸索
- [ ] 中途断点恢复：上传完成后杀掉会话，重新跑能从「填写中」继续，不重传
- [ ] 幂等：同一文件连续跑两次，第二次直接跳过
- [ ] 管理页能查到该作品（标题 + 已发布），`state.json` 含 item_id/url
- [ ] 全流程含人工确认点，发布前无静默动作

## 10. 下一步行动项

1. [ ] 写 `temp/douyin-publish/pick_file.ps1`（参数化版，替换硬编码脚本）
2. [ ] 写 `temp/douyin-publish/README.md` playbook（含 §6 断言与恢复点）
3. [ ] 用 `sprout.mp4` 跑通验收 1–5
4. [ ] （后续）如需长期高频使用 → 固化为 Polaris 插件（参照 `plugins/sim-paper-trading`），本轮不立项

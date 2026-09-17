# edit_file 可靠性：业界最佳方案调研与升级设计

> 状态：**调研完成，暂不实施**
> 创建：2026-09-17
> 关联：plans/simpleai-tools-fix-plan.md（行级编辑改造，P0 已完成）、docs/simple-ai-issues-analysis.md
> 触发问题：SimpleAI 使用 edit_file 时"行号错位"（读旧快照 → 按旧行号编辑 → 改错位置）

---

## 一、调研结论（一句话版）

业界共识（Claude Code / OpenAI Codex / Cursor / 多篇 2025-2026 实测文章）一致认为：
**行号只是 read 输出中的展示辅助，不能作为编辑锚点；编辑必须基于精确字符串匹配，配合
read-before-write、mtime 冲突检测、唯一匹配校验、串行执行等确定性保护。**

当前 SimpleAI 的 `edit_file`（start_line/end_line 区间替换）正是业界明确规避的反模式——
虽然代码本身健壮（边界校验齐全、read 与 edit 行号口径一致），但**行号漂移是模型侧固有风险**，
工具层应把"防呆"做足。

---

## 二、调研来源

| 来源 | 类型 | 关键内容 |
|------|------|----------|
| labuladong.online《A Reliable File-Editing Tool》（2026-09） | 教程 | 把朴素 agent 工具升级为 Claude Code 设计：readFileState + 四道可靠性检查 |
| ceaksan.com《Why AI Agents Break Files: Practical Strategies and Tests》（2026-01） | 20 场景实测 | 5 种编辑策略 benchmark；三大失败点；edit-guard 防腐钩子；策略选择规则 |
| 知乎《Claude Code Agent分析七：文件编辑》（2025-07） | 逆向分析 | Claude Code 文件编辑管线完整拆解：FileState / LineNumberHandler / EditTool / MultiEditTool / WriteTool / 五层校验 |

---

## 三、业界方案细节

### 3.1 labuladong：Claude Code 设计移植（四道可靠性检查）

1. **read-before-write**：文件必须先被 read_file 读过（登记进共享 `readFileState`），否则拒绝编辑
2. **mtime conflict detection**：编辑时对比文件当前 mtime 与上次读取时记录的 mtime，不一致 = 外部修改 → 拒绝并提示重读
3. **unique-match**：编辑锚点（字符串/行）必须唯一命中，防止误替换
4. **serial execution**：多个编辑串行执行，不做并发

### 3.2 ceaksan：5 策略实测（20 场景）

**三大失败点**：
- **line drift**：插入/删除使后续行号全部漂移 → 顺序编辑错位
- **lost-in-the-middle**：大文件中间行被模型静默丢失
- **match failure**：格式化器跑过后，旧文本/行号对不上

**策略与成本实测**（1053 行文件、10 处改动）：

| 策略 | 说明 | 成本 |
|------|------|------|
| Sequential Edit | 每次改一处，行号漂移风险 | ~25K tokens / 65s |
| **Script Generation** | 生成 sed/脚本，不喂文件全文 | **~7K tokens / 10s（最优）** |
| Atomic Write | 整文件重写 | ~43K tokens（最贵，仅适合 <200 行） |
| Unified Diff | 统一 diff 格式应用 | 3-5 处改动时好 |

**策略选择规则**：1-2 处 → Edit；3-5 处 → Script Generation 或 Unified Diff；6+ 处 → Script Generation。

**edit-guard**：Claude Code PostToolUse 钩子，每次 Edit/Write 后自动做 3 项确定性检查：
连续编辑计数、行数校验（增删行数与预期一致）、lost-in-the-middle 检测。

### 3.3 知乎：Claude Code 文件编辑管线（最完整）

- **FileState 缓存**：`{content, hash, mtime, encoding, lineEndings, isBinary, size}`，write 时保留原行尾与编码
- **LineNumberHandler（专治行号问题）**：
  - 检测 `old_string` 是否误带行号前缀（`^\d+\t`，模型常把 read 输出里 `2 console.log(...)` 直接当锚点）→ 报错并给出剥离建议
  - 剥离行号后重新在文件中匹配，找不到时提示"是否把行号当成了内容"
- **EditTool**：`old_string → new_string` 精确匹配 + `expected_replacements` 必须与实际出现次数一致（0 次或次数不符都拒绝）
- **MultiEditTool**：先在内存副本上模拟全部编辑 → 冲突检测（依赖 / 重叠 / 矛盾三类）→ 全过才一次性写盘（原子）
- **WriteTool**：覆盖已有文件必须先读过 + mtime 校验；文档类文件需显式允许
- **五层 ValidationPipeline**：路径边界 → 权限 → 文件状态 → 内容 → 安全
- **失败恢复**：外部修改时 three-way merge，冲突打标记，再退化为询问用户
- **反馈闭环**：每次编辑后生成 unified diff + 上下文 snippet，让模型确认改对了

---

## 四、与 Polaris 现状的差距

| Polaris 现状（src-tauri/src/ai/engine/simple_ai/tools/fs.rs） | 业界最佳 | 差距 |
|------|------|------|
| `edit_file` 用 start/end 行号区间替换 | 精确字符串匹配 `old_string` + `expected_replacements` | **架构性差距（错位主因）** |
| 无 read-before-write 强制 | 强制先读（FileState 缓存） | 缺状态管理 |
| 无 mtime 冲突检测 | 外部改动即拒绝 | 缺争用保护 |
| 无唯一匹配 / 期望次数校验 | 次数不符拒绝，强制更精确锚点 | 误替换无拦截 |
| `.lines()` 切分 + `\n` join，不保留原行尾 | 保留 lineEndings / encoding | CRLF 风险 |
| `apply_patch` 部分锚点匹配但无冲突检测 | MultiEdit 原子 + 冲突检测 | 半套 |
| 前端 `diffExtractor` 不认 `edit_file` 入参 | 编辑后必回 unified diff 反馈 | 显示层错位 |
| 折叠摘要 `+N -M` 按 replacement 行数推算 | 从真实 diff 统计 | 视觉错位 |

---

## 五、推荐升级方向（供后续决策，暂不实施）

按"投入产出比"排序，三档可选：

### 档位 A：最小修复（显示层，半天内）
- `src/utils/diffExtractor.ts` 兼容 `edit_file` 的 `path/start_line/end_line/replacement_text`，让 DiffViewer 能正确对位旧内容
- `src/utils/toolSummary.ts` 修正 `+N -M` 推算（处理 replacement 尾换行、删除行数差 1）

### 档位 B：核心可靠性（工具层，2-3 天）
- `edit_file` 增加可选 `old_string` 锚点参数：行号 + 锚点双校验，行号对不上但锚点唯一命中时，以锚点为准并回显修正后的行号
- 错误信息增强：失败时回显"实际文件该位置内容 vs 模型期望内容"，供模型自纠（对齐 Codex/Claude 的失败反馈标准）
- CRLF 感知：行切分后按原行尾 join，编辑后保留编码/换行风格
- 文件状态登记：read_file 记录 mtime，edit 前校验外部修改

### 档位 C：全面对齐业界（架构级，1-2 周）
- `edit_file` 改为字符串匹配语义（`old_string / new_string / expected_replacements`），行号仅作 read 展示
- `MultiEditTool`：内存模拟 + 冲突检测 + 原子写盘
- 编辑后统一回 diff + snippet 反馈闭环
- read-before-write / mtime / 唯一匹配强制
- LineNumberHandler：锚点误带行号前缀的自动识别与剥离提示

---

## 六、给使用者的即时规避建议（在实施前缓解错位）

1. 编辑前**重新 read_file** 拿最新行号，不要用几轮前的旧快照
2. 大文件用 `offset/limit` 读目标片段，别全量读后凭记忆估行号
3. 多处/多文件改动优先用 `apply_patch`（锚点匹配，容错性优于裸行号）
4. 编辑失败时按错误信息里的"实际内容"提示修正，不要盲目重试同一行号

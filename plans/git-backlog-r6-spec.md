# spec：git 欠账总清偿（round-6 worktree `feat/git-backlog-r6`）

> 基线：main `c0a0a594`。审计源：master-plan §十一（11 项）。
> 纪律：每项独立单主题提交 + 门禁（tsc / 相关 vitest / cargo check + web-gate）；运行时单测受 DLL 限制以编译门代替（如实标注）。

## 实施顺序与验收

### A 组 · 前端快赢（先做，UI 闭环）
| 项 | 内容 | 验收 |
|---|---|---|
| A1 AI-7 危护 v1（AI 可缺席） | 危险操作确认卡增强：discard/reset-hard/drop/force-push/分支删除 增加「将失去什么」确定性预报（文件数/提交数/未合流提示）+ 安全网建议（先行 stash 或备份分支入口） | 5 类危险操作均有损失预告；纯本地 0 token；组件测试 |
| A2 风险卡跳转 diff | CommitRiskCard 明细条目点击 → 打开该文件 diff（复用 onOpenDiffInTab / 内部 diff 视图） | 点击落 diff；测试 |
| A3 Undo toast 联动 | 危险操作成功后 toast 携「撤销」按钮（快照存在时），点击触发 undoSlice.restore | toast 有按钮、恢复路径走 undoSlice；测试 |

### B 组 · 协议/后端（PR-2a 补全）
| 项 | 内容 | 验收 |
|---|---|---|
| B1 C1 Reply 结构化错误 | 错误载荷 `{code, kind, stderrSnip}`；router Reply 扩展 + 前端 transport 映射；cap.git 内错误分类 | 双边同步 + 字段级测试 |
| B2 读无限/写 1 队列完整版 + progress ≤4Hz 合流 + 取消分级语义 | 把 WRITE_GATE 最简互斥升级为队列结构；长任务 progress 合流；git2 只读任务不承诺即时取消（写路径维持 kill）——注释明示 | 队列串行单测；合流节流测试 |
| B3 C9 自抑制 | 序列操作（merge/rebase/cherry-pick/revert）任务活动窗口内 suppress .git 副监听引发的 status 刷新风暴；rebase 中刷新预算放宽 ≤3s | 抑制窗口单测（前端 subscriber 层） |

### C 组 · Interactive Rebase 增量
| 项 | 内容 | 验收 |
|---|---|---|
| C1 reword | 不走 GIT_EDITOR 二层编排：todo 中 pick→reword 不稳定，改用 `exec git commit --amend -m <msg>` 注入（纯文本组装，无编辑器交互） | 注入脚本单测；真实 rebase 手测说明 |
| C2 拖拽 reorder | RebaseTodoDialog 行拖拽排序（HTML5 DnD），与上下移按钮并存；组约束 live 校验不变 | 拖拽测试（act 驱动） |

### D 组 · 工具与性能
| 项 | 内容 | 验收 |
|---|---|---|
| D1 bench-git.mjs | 本地 bench 脚本：log 首页/翻页/热开（缓存命中）时延；实测数字回填 master-plan §预算表 | 脚本可运行 + 数字归档（标注机器环境） |
| D2 graph.c 四数组 lane 收缩 | Rust 端移植 mapping/new_columns/old_columns 算法（围绕 graph.c 语义）；契约用例 5 拓扑 | 契约用例全绿；视觉语义不变 |

### E 组 · 视进度（如实汇报，不硬凑）
- AI-6 LLM 归纳层（⚡⚡）：依赖引擎会话编排，若时间内做不完 → 明确标注未做。
- AI-5 agentic 冲突求解：探索项，若做 → 只做降级 per-hunk 卡形态。
- #6 P4 插件示例：在插件仓（`D:\space\base\Polaris-plugin`）实施，**不在本 worktree 仓库**；如时间允许另行处理并在记录中注明。

## 明确不做（本 spec 边界）
- 不拆既有巨型文件；不动无关 WIP；不引入跨进程锁。

## 交付物
- 每项 ≥1 单主题提交；最终在 master-plan/handoff 增第七轮执行记录与剩余项重盘点；分支 `feat/git-backlog-r6` 待合并（不自行并入 main，等用户指令）。

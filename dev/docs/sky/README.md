# sky 重构 · 文档索引

> 本目录记录 Polaris 参照 sky（`D:\space\base\do\sky`）的渐进式重构规划与实施。
> 原则：**先实现新骨架，再一块块替换，不着急**。旧数据不迁移，旧系统照常运行。

## 规划

| 文档 | 内容 |
|---|---|
| [step1-contracts.md](step1-contracts.md) | **第一步：契约冻结** 完整实施规划（交付清单/边界/影响面/验收） |
| [step2-storage.md](step2-storage.md) | **第二步：存储实现** 规划（借 sky 骨架 + 补全生产能力） |
| [prototype-storage.html](prototype-storage.html) | 第二步可视化交互原型（按域分库 / Filter 查询 / 事务审计 / 仓库替换） |
| [step3-dispatch.md](step3-dispatch.md) | **第三步：转发 dispatch** 规划（复用已有 EventBroadcaster + 补统一 dispatch 骨干） |
| [prototype-dispatch.html](prototype-dispatch.html) | 第三步可视化交互原型（dispatch 全链路 / 能力注册表 / 权限 gate / 事件过滤） |
| [step4-migration.md](step4-migration.md) | **第四步：闭环替换（持续迁移主文档）** 迁移 playbook + 摘旧复盘 + backlog（cap.todo / cap.prompt_snippet 已闭环） |
| [step5-permission-audit.md](step5-permission-audit.md) | **第五步：权限与审计生产化** ✅ 已实施（Source 收紧 / FileAuditSink 哈希链 / PolicyPermission / domain_audit 同事务） |
| [step6-ai-streaming.md](step6-ai-streaming.md) | **第六步：AI 流式能力上总线** 规划（流式平行表 + 泵任务 / cap.ai.chat 薄包装 / chat-event 兼容通道 / token 真实注入） |

## 关联

- **借鉴分析**（全景）：`plans/sky-refactor-borrow-analysis.md`（仓库根）
- **插件可见性治理**（摘旧复盘衍生的独立修复）：`plans/plugin-visibility-plan.md`（仓库根）
- **sky 项目**：`D:\space\base\do\sky` —— 架构级复刻实验，本重构的思想来源
- **sky 契约原版**：`do/sky/src/contracts/mod.rs`（Phase 0a 冻结版）

# sky 重构 · 文档索引

> 本目录记录 Polaris 参照 sky（`D:\space\base\do\sky`）的渐进式重构规划与实施。
> 原则：**先实现新骨架，再一块块替换，不着急**。旧数据不迁移，旧系统照常运行。

## 规划

| 文档 | 内容 |
|---|---|
| [step1-contracts.md](step1-contracts.md) | **第一步：契约冻结** 完整实施规划（交付清单/边界/影响面/验收） |
| [step2-storage.md](step2-storage.md) | **第二步：存储实现** 规划（借 sky 骨架 + 补全生产能力） |
| [prototype-storage.html](prototype-storage.html) | 第二步可视化交互原型（按域分库 / Filter 查询 / 事务审计 / 仓库替换） |

## 关联

- **借鉴分析**（全景）：`plans/sky-refactor-borrow-analysis.md`（仓库根）
- **sky 项目**：`D:\space\base\do\sky` —— 架构级复刻实验，本重构的思想来源
- **sky 契约原版**：`do/sky/src/contracts/mod.rs`（Phase 0a 冻结版）

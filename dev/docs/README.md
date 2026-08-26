# dev/docs — 开发维护说明

本目录存放 **实现/维护级** 开发说明（dev notes），与根目录 `docs/`（需求级规格/ADR/计划）区分：

| 目录 | 定位 |
|------|------|
| `docs/` | 需求规格（`docs/specs/`）、ADR（`docs/adr/`）、计划等跨模块文档 |
| `dev/docs/` | 具体模块的**实现细节、接口契约、维护约定**，供后续开发直接沿用 |

## 规则

1. **单一事实来源**：每份文档对应一个模块/机制，改动必须同步更新对应文档。
2. **结构对齐**：使用 frontmatter（`name`/`type`/`status`/`version`/`date`/`related`），正文按「背景 → 数据结构 → 接口 → 生命周期 → 变更清单 → 维护约定」组织。
3. **接口即契约**：涉及接收入口（如 `addContextBlock`）的文档，必须写明「禁止绕过入口直接操作」的约定。
4. **新增文档**：先与本目录索引（本 README）登记。
5. **命名**：`<kebab-case>-<topic>.md`。

## 文档清单

- [temp-context-block-entry.md](./temp-context-block-entry.md) — 输入框临时上下文块（TCB）统一接收入口与维护说明
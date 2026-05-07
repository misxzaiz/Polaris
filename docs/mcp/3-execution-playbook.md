# 3. 每次执行前的检查清单

## 每次开始前

1. 先读 `docs/mcp/INDEX.md`。
2. 如果是继续开发，读 `docs/mcp/2-roadmap.md` 中对应阶段。
3. 执行 `git status --short`，确认工作区是否干净。
4. 查找相关文件时优先用 `rg`。

## 推荐执行顺序

1. 先确认目标阶段和当前缺口。
2. 小范围实现，不做无关重构。
3. 优先保持 Todo 插件行为不变。
4. 补测试或更新已有测试。
5. 跑验证命令。
6. 提交 git。
7. 更新本目录文档中的进度。

## 常用验证命令

前端：

```powershell
npx tsc --noEmit
npx eslint <changed-ts-files>
npx vitest run src/plugin-system/mcp.test.ts src/stores/pluginStore.test.ts
```

Rust：

```powershell
cargo check --lib
```

注意：当前机器运行 Rust 单测二进制时可能出现 `STATUS_ENTRYPOINT_NOT_FOUND`。如果 `cargo test` 已经完成编译但启动测试 binary 失败，应记录为本机运行时问题，不要误判为当前代码编译失败。

## 提交规范

建议提交粒度：

- `feat:` 新能力
- `refactor:` 结构调整但行为不变
- `fix:` 修复 bug
- `docs:` 文档更新

每次完成后更新 `docs/mcp/INDEX.md` 的当前结论或下一步建议。


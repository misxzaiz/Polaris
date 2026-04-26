# Knowledge MCP 并发支持设计

> 日期: 2026-04-23
> 状态: Draft
> 范围: `crates/polaris-knowledge-mcp/`

## 问题

Claude Code 并行调用同一 MCP server 的多个 tool 时，第二个请求返回 "Not connected"。

根因：
1. 工具没有声明 `readOnlyHint` 注解 → Claude Code 无法判断哪些工具可安全并行
2. 服务端是单线程同步模型 → 无法同时处理多个 in-flight 请求

## 方案: 注解驱动 + 线程池

### 1. 工具注解分类 (tools.rs)

14 个工具按读写分类：

| 工具 | 类型 | readOnlyHint |
|------|------|-------------|
| list_modules | 只读 | `true` |
| get_module | 只读 | `true` |
| get_module_dependencies | 只读 | `true` |
| get_architecture_overview | 只读 | `true` |
| search_modules | 只读 | `true` |
| list_stale_modules | 只读 | `true` |
| get_assertions_health | 只读 | `true` |
| compile_context | 只读 | `true` |
| get_structure | 只读 | `true` |
| update_module | **读写** | `false` (默认) |
| create_module | **读写** | `false` (默认) |
| mark_modules_stale | **读写** | `false` (默认) |
| clear_stale_marker | **读写** | `false` (默认) |
| validate_assertions | **读写** | `false` (默认) |
| extract_structure | **读写** | `false` (默认) |
| seed_assertions | **读写** | `false` (默认) |

实现方式：在 `get_tools_list()` 的每个工具定义中加 `annotations` 字段：

```json
{
  "name": "list_modules",
  "description": "...",
  "inputSchema": { ... },
  "annotations": {
    "readOnlyHint": true
  }
}
```

写入工具不加 `annotations` 字段（默认 `readOnlyHint: false`）。

### 2. 服务端线程池模型 (server.rs)

将同步事件循环改为线程池调度：

```
当前:
  main thread: read → process → write → read → process → write → ...

改后:
  main thread: read ─→ dispatch to pool ─→ collect from channel ─→ write
                  ↓                         ↑
              pool thread: process request → send response to channel
```

关键设计：

**a. 请求分发**
- 主线程持续从 stdin 读请求
- 每个请求分发到线程池（`std::thread` + 固定大小线程池）
- 使用 `crossbeam-channel` 或 `std::sync::mpsc` 收集响应

**b. 响应汇聚**
- 所有线程的响应通过统一 channel 发回主线程
- 主线程从 channel 读响应，写入 stdout
- 响应按完成顺序写入（JSON-RPC 用 `id` 字段匹配，不需要按请求顺序）

**c. 线程安全**
- `Rc<RefCell<KnowledgeCache>>` → `Arc<RwLock<KnowledgeCache>>`
  - 读操作用 `read()` 锁（可并行）
  - 缓存更新用 `write()` 锁（独占）
- 写入工具使用专用 `Mutex<()>` 令牌串行化（同一时刻只有一个写入操作）

**d. stdout 写入保护**
- 只有主线程写 stdout（通过 channel 汇聚）
- 避免 JSON 交叉输出

### 3. 缓存线程安全改造 (handler.rs)

```rust
// Before
pub type SharedCache = Rc<RefCell<KnowledgeCache>>;

// After
pub type SharedCache = Arc<RwLock<KnowledgeCache>>;
```

调用点变化：
- `cache.borrow()` → `cache.read().unwrap()`
- `cache.borrow_mut()` → `cache.write().unwrap()`

### 4. 写入操作串行化

新增 `WriteGuard` 机制：

```rust
/// 全局写入锁。同一时刻只允许一个写入操作执行。
pub struct WriteLock {
    mutex: Arc<Mutex<()>>,
}
```

写入工具（update_module、seed_assertions 等）在执行前 acquire 写入锁。
只读工具不需要写入锁。

### 5. 线程池参数

- 池大小：4 线程（Knowledge MCP 是 I/O 密集型，4 足够覆盖并发）
- channel buffer：16（防止背压阻塞）
- 线程创建：启动时一次性创建，不动态伸缩

## 不变的部分

- `protocol.rs`：不需要改。JSON-RPC 的 `id` 字段已支持乱序响应匹配
- `error.rs`：不需要改。错误类型只包含 String，天然 `Send + Sync`
- `models.rs`：不需要改。数据模型是纯数据结构
- `migrate.rs`、`compiler.rs`、`validator.rs`、`seeder.rs`、`extractor.rs`、`parsing.rs`：不需要改

## 依赖变化

Cargo.toml 新增：
- 无。使用 `std::thread`、`std::sync::{Arc, RwLock, Mutex, mpsc}` 全部来自标准库。

## 测试策略

1. 单元测试：`SharedCache` 的 `Arc<RwLock<>>` 并发读写测试
2. 管道测试：通过 stdin 管道发送多个并发 JSON-RPC 请求，验证全部成功返回
3. 读写冲突测试：一个写入请求 + 多个读取请求并发，验证无数据损坏
4. 回归测试：现有 103 个测试全部通过

## 风险

| 风险 | 缓解 |
|------|------|
| `RwLock` 写锁饥饿（读操作太多导致写操作等不到） | Knowledge 写入频率极低（人工触发），风险可忽略 |
| stdout 并发写入导致 JSON 交叉 | 只有主线程写 stdout，channel 汇聚 |
| 死锁（写入锁 + 缓存锁互相等待） | 锁获取顺序固定：先写锁 → 再缓存锁 |
| `RefCell` → `RwLock` 的 `.unwrap()` panic | 使用 `unwrap_or_else` + 错误日志，不 panic |

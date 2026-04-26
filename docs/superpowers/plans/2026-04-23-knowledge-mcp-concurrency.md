# Knowledge MCP 并发支持 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Knowledge MCP server 支持并行 tool call，消除 "Not connected" 错误。

**Architecture:** 只读工具加 `readOnlyHint: true` 注解让 Claude Code 放心并行发送；服务端从单线程同步改为线程池调度（`std::thread` + `mpsc`），主线程读请求分发到线程池，收集响应后写回 stdout；缓存从 `Rc<RefCell<>>` 改为 `Arc<RwLock<>>` 支持并发读写。

**Tech Stack:** Rust std library only（`std::thread`, `std::sync::{Arc, RwLock, Mutex, mpsc}`）

**Design spec:** `docs/superpowers/specs/2026-04-23-knowledge-mcp-concurrency-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `crates/polaris-knowledge-mcp/src/tools.rs` | Modify | 9 个只读工具加 `annotations.readOnlyHint: true` |
| `crates/polaris-knowledge-mcp/src/handler.rs` | Modify | `SharedCache` 从 `Rc<RefCell<>>` 改为 `Arc<RwLock<>>`；新增 `WriteLock` |
| `crates/polaris-knowledge-mcp/src/server.rs` | Modify | 事件循环改为线程池模型；`handle_request` 适配新签名 |
| `crates/polaris-knowledge-mcp/Cargo.toml` | No change | 无新依赖 |

---

### Task 1: 只读工具加 readOnlyHint 注解

**Files:**
- Modify: `crates/polaris-knowledge-mcp/src/tools.rs`

只读工具列表（9 个）：`list_modules`, `get_module`, `get_module_dependencies`, `get_architecture_overview`, `search_modules`, `list_stale_modules`, `get_assertions_health`, `compile_context`, `get_structure`

写入工具列表（7 个）：`update_module`, `create_module`, `mark_modules_stale`, `clear_stale_marker`, `validate_assertions`, `extract_structure`, `seed_assertions`

- [ ] **Step 1: 给 9 个只读工具加 annotations 字段**

对每个只读工具，在 `inputSchema` 后面加 `annotations` 块。示例（`list_modules`）：

```rust
{
    "name": "list_modules",
    "description": "列出项目所有知识模块...",
    "inputSchema": {
        "type": "object",
        "properties": {},
        "additionalProperties": false
    },
    "annotations": {
        "readOnlyHint": true
    }
}
```

对以下 9 个工具重复此操作：
1. `list_modules` (line ~16)
2. `get_module` (line ~25)
3. `get_module_dependencies` (line ~41)
4. `get_architecture_overview` (line ~57)
5. `search_modules` (line ~66)
6. `list_stale_modules` (line ~184)
7. `get_assertions_health` (line ~224)
8. `compile_context` (line ~233)
9. `get_structure` (line ~286)

写入工具（`update_module`, `create_module`, `mark_modules_stale`, `clear_stale_marker`, `validate_assertions`, `extract_structure`, `seed_assertions`）**不加** annotations 字段。

- [ ] **Step 2: 编译验证**

Run: `cd D:/space/base/Polaris/crates/polaris-knowledge-mcp && cargo check 2>&1`
Expected: 编译成功，无错误

- [ ] **Step 3: 运行测试**

Run: `cd D:/space/base/Polaris/crates/polaris-knowledge-mcp && cargo test 2>&1 | tail -20`
Expected: 103 tests passed

- [ ] **Step 4: 管道测试验证注解生效**

Run:
```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n' | cargo run --manifest-path D:/space/base/Polaris/crates/polaris-knowledge-mcp/Cargo.toml -- --workspace D:/space/base/Polaris 2>/dev/null | python3 -c "import sys,json; tools=json.loads([l for l in sys.stdin if '\"tools\"' in l][0]); read_only=[t['name'] for t in tools['result']['tools'] if t.get('annotations',{}).get('readOnlyHint')]; print(f'Read-only tools ({len(read_only)}): {read_only}')"
```
Expected: `Read-only tools (9): ['list_modules', 'get_module', ...]`

- [ ] **Step 5: Commit**

```bash
git add crates/polaris-knowledge-mcp/src/tools.rs
git commit -m "feat(knowledge-mcp): add readOnlyHint annotations to 9 read-only tools"
```

---

### Task 2: 缓存从 Rc<RefCell<>> 改为 Arc<RwLock<>>

**Files:**
- Modify: `crates/polaris-knowledge-mcp/src/handler.rs`
- Modify: `crates/polaris-knowledge-mcp/src/server.rs`（`use` 引用）

- [ ] **Step 1: 修改 handler.rs 的 SharedCache 类型定义**

将 line 3-8 的 imports 和 line 104-108 的类型定义改为：

```rust
// 替换 imports
use std::sync::{Arc, RwLock, Mutex};
// 移除: use std::cell::RefCell; 和 use std::rc::Rc;

// 替换 SharedCache 类型
/// Shared reference to the cache.
///
/// Uses `Arc<RwLock<>>` for thread-safe shared access.
/// Multiple read operations can proceed in parallel;
/// cache updates acquire a write lock exclusively.
pub type SharedCache = Arc<RwLock<KnowledgeCache>>;
```

- [ ] **Step 2: 修改 load_index_cached 的缓存访问**

将 `cache.borrow()` 改为 `cache.read().unwrap()`，`cache.borrow_mut()` 改为 `cache.write().unwrap()`：

```rust
pub fn load_index_cached(index_path: &PathBuf, cache: &SharedCache) -> Result<KnowledgeIndex> {
    let mtime = std::fs::metadata(index_path)
        .and_then(|m| m.modified())
        .ok();

    {
        let c = cache.read().unwrap();  // was: cache.borrow()
        if let Some((ref idx, ref cached_mtime)) = c.v1 {
            if Some(*cached_mtime) == mtime {
                return Ok(idx.clone());
            }
        }
    }

    let index = load_index(index_path)?;
    if let Some(mtime) = mtime {
        cache.write().unwrap().v1 = Some((index.clone(), mtime));  // was: cache.borrow_mut()
    }
    Ok(index)
}
```

同样修改 `load_v2_cached` 函数中的 3 处 `.borrow()`/`.borrow_mut()` 调用。

- [ ] **Step 3: 修改 server.rs 中的 cache 创建**

将 line 104 从：
```rust
let cache: SharedCache = std::rc::Rc::new(std::cell::RefCell::new(KnowledgeCache::new()));
```
改为：
```rust
let cache: SharedCache = Arc::new(RwLock::new(KnowledgeCache::new()));
```

同时更新 server.rs 顶部的 imports：
```rust
use std::sync::{Arc, RwLock};
// 移除不需要的: use std::io::{self, BufRead, BufReader, Write}; 保留
```

- [ ] **Step 4: 新增 WriteLock 类型到 handler.rs**

在 `SharedCache` 定义后添加：

```rust
/// Global write serialization lock.
/// Only one write operation (update_module, seed_assertions, etc.) may execute at a time.
/// Read-only tools do not acquire this lock.
pub type WriteLock = Arc<Mutex<()>>;
```

- [ ] **Step 5: 编译验证**

Run: `cd D:/space/base/Polaris/crates/polaris-knowledge-mcp && cargo check 2>&1`
Expected: 编译成功

- [ ] **Step 6: 运行全部测试**

Run: `cd D:/space/base/Polaris/crates/polaris-knowledge-mcp && cargo test 2>&1 | tail -20`
Expected: 103 tests passed（behavior 不变，只改内部类型）

- [ ] **Step 7: Commit**

```bash
git add crates/polaris-knowledge-mcp/src/handler.rs crates/polaris-knowledge-mcp/src/server.rs
git commit -m "refactor(knowledge-mcp): replace Rc<RefCell<>> with Arc<RwLock<>> for thread-safe caching"
```

---

### Task 3: server.rs 事件循环改为线程池模型

**Files:**
- Modify: `crates/polaris-knowledge-mcp/src/server.rs`
- Modify: `crates/polaris-knowledge-mcp/src/handler.rs`（handle_tools_call 签名加 write_lock）

这是最关键的改动。将同步循环改为：

```
main thread: stdin → read line → dispatch to thread pool
thread pool: parse request → handle → send response to channel
main thread: channel → receive response → write to stdout
```

- [ ] **Step 1: 在 server.rs 添加线程池 imports**

```rust
use std::sync::mpsc;
use std::thread;
```

- [ ] **Step 2: 重写 run_event_loop 函数**

完全替换 line 85-152 的 `run_event_loop` 函数：

```rust
/// Worker pool size for concurrent request processing.
const WORKER_POOL_SIZE: usize = 4;

fn run_event_loop(
    index_path: &PathBuf,
    modules_dir: &PathBuf,
    workspace_root: Option<&std::path::Path>,
) -> Result<()> {
    // Pre-flight: verify index.json exists before entering the event loop.
    if !index_path.exists() {
        return Err(KnowledgeError::Validation(format!(
            "知识索引文件不存在: {}。请确保 .polaris/knowledge/index.json 存在",
            index_path.display()
        )));
    }

    let cache: SharedCache = Arc::new(RwLock::new(KnowledgeCache::new()));
    let write_lock: WriteLock = Arc::new(Mutex::new(()));

    // Channel: workers → main thread (responses)
    let (response_tx, response_rx) = mpsc::channel::<String>();

    // Spawn worker threads
    let mut workers = Vec::with_capacity(WORKER_POOL_SIZE);
    let (work_tx, work_rx) = mpsc::channel::<String>();
    let work_rx = Arc::new(Mutex::new(work_rx));

    for _ in 0..WORKER_POOL_SIZE {
        let work_rx = Arc::clone(&work_rx);
        let response_tx = response_tx.clone();
        let cache = Arc::clone(&cache);
        let write_lock = Arc::clone(&write_lock);
        let index_path = index_path.clone();
        let modules_dir = modules_dir.clone();
        let workspace_root = workspace_root.map(|p| p.to_path_buf());

        let handle = thread::spawn(move || {
            loop {
                // Receive work (blocks if no work available)
                let line = match work_rx.lock().unwrap().recv() {
                    Ok(l) => l,
                    Err(_) => break, // Channel closed, exit worker
                };

                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                let response = match serde_json::from_str::<JsonRpcRequest>(trimmed) {
                    Ok(request) => handle_request(
                        request,
                        &index_path,
                        &modules_dir,
                        workspace_root.as_deref(),
                        &cache,
                        &write_lock,
                    ),
                    Err(error) => error_response(
                        Value::Null,
                        -32700,
                        format!("Parse error: {}", error),
                    ),
                };

                let response_str = serde_json::to_string(&response).unwrap_or_else(|e| {
                    format!("{{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{{\"code\":-32603,\"message\":\"{}\"}}}}", e)
                });

                if response_tx.send(response_str).is_err() {
                    break; // Main thread gone, exit worker
                }
            }
        });
        workers.push(handle);
    }
    drop(response_tx); // Drop the extra sender so response_rx sees EOF when workers exit

    // Main thread: read from stdin, dispatch to workers, collect responses
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = stdout.lock();

    let mut line = String::new();
    let mut pending_count: usize = 0;

    loop {
        line.clear();

        // Use a simple strategy: read a request, dispatch it, then drain any
        // available responses before reading the next request.
        let bytes_read = match reader.read_line(&mut line) {
            Ok(n) => n,
            Err(e) => {
                eprintln!("[knowledge-mcp] stdin read error: {}", e);
                break;
            }
        };
        if bytes_read == 0 {
            break;
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Dispatch to worker pool
        if work_tx.send(trimmed.to_string()).is_err() {
            eprintln!("[knowledge-mcp] worker pool shut down");
            break;
        }
        pending_count += 1;

        // Drain available responses (non-blocking)
        while pending_count > 0 {
            match response_rx.try_recv() {
                Ok(response_str) => {
                    pending_count -= 1;
                    if let Err(e) = writer.write_all(response_str.as_bytes())
                        .and_then(|_| writer.write_all(b"\n"))
                        .and_then(|_| writer.flush())
                    {
                        eprintln!("[knowledge-mcp] stdout write error: {}", e);
                        break;
                    }
                }
                Err(mpsc::TryRecvError::Empty) => break, // No responses ready yet
                Err(mpsc::TryRecvError::Disconnected) => {
                    eprintln!("[knowledge-mcp] workers disconnected");
                    break;
                }
            }
        }
    }

    // Drain remaining responses
    drop(work_tx); // Signal workers to stop
    while pending_count > 0 {
        match response_rx.recv() {
            Ok(response_str) => {
                pending_count -= 1                ;
                let _ = writer.write_all(response_str.as_bytes());
                let _ = writer.write_all(b"\n");
                let _ = writer.flush();
            }
            Err(_) => break,
        }
    }

    // Wait for workers to finish (they should exit quickly after work_tx is dropped)
    for handle in workers {
        let _ = handle.join();
    }

    Ok(())
}
```

- [ ] **Step 3: 更新 handle_request 签名，加入 write_lock 参数**

修改 `handle_request` 函数签名和内部调用：

```rust
fn handle_request(
    request: JsonRpcRequest,
    index_path: &PathBuf,
    modules_dir: &PathBuf,
    workspace_root: Option<&std::path::Path>,
    cache: &SharedCache,
    write_lock: &WriteLock,
) -> JsonRpcResponse<'static> {
    let id = request.id.unwrap_or(Value::Null);

    if request.jsonrpc != "2.0" {
        return error_response(id, -32600, "Invalid Request: jsonrpc must be 2.0".to_string());
    }

    let result = match request.method.as_str() {
        "initialize" => Ok(tools::get_initialize_response()),
        "notifications/initialized" => Ok(json!({})),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(tools::get_tools_list()),
        "tools/call" => handle_tools_call(
            request.params, index_path, modules_dir, workspace_root, cache, write_lock,
        ),
        _ => Err(KnowledgeError::Validation(format!(
            "不支持的方法: {}",
            request.method
        ))),
    };

    match result {
        Ok(result) => JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        },
        Err(error) => error_response(id, -32000, error.to_message()),
    }
}
```

- [ ] **Step 4: 更新 handler.rs 的 handle_tools_call 签名和写入工具调用**

修改 `handle_tools_call` 函数签名，加入 `write_lock: &WriteLock` 参数。
对写入工具（update_module, create_module, mark_modules_stale, clear_stale_marker, validate_assertions, extract_structure, seed_assertions），在执行前 acquire 写入锁：

```rust
pub fn handle_tools_call(
    params: Value,
    index_path: &PathBuf,
    modules_dir: &PathBuf,
    workspace_root: Option<&std::path::Path>,
    cache: &SharedCache,
    write_lock: &WriteLock,
) -> Result<Value> {
    let tool_name = params
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let arguments = params.get("arguments").cloned().unwrap_or(json!({}));

    match tool_name.as_str() {
        // Read-only tools (no write lock needed)
        "list_modules" => execute_list_modules(index_path, cache),
        "get_module" => execute_get_module(arguments, index_path, modules_dir, cache),
        // ... other read-only tools ...

        // Write tools (acquire write lock)
        "update_module" => {
            let _guard = write_lock.lock().unwrap();
            execute_update_module(arguments, index_path, modules_dir, cache)
        }
        "seed_assertions" => {
            let _guard = write_lock.lock().unwrap();
            execute_seed_assertions(arguments, index_path, cache)
        }
        // ... other write tools ...
    }
}
```

- [ ] **Step 5: 编译验证**

Run: `cd D:/space/base/Polaris/crates/polaris-knowledge-mcp && cargo check 2>&1`
Expected: 编译成功

- [ ] **Step 6: 运行全部测试**

Run: `cd D:/space/base/Polaris/crates/polaris-knowledge-mcp && cargo test 2>&1 | tail -20`
Expected: 103 tests passed

- [ ] **Step 7: 并发管道测试**

Build release binary and test with pipelined requests:

```bash
cd D:/space/base/Polaris/crates/polaris-knowledge-mcp && cargo build --release 2>&1
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_modules","arguments":{}}}\n{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_architecture_overview","arguments":{}}}\n{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"search_modules","arguments":{"query":"engine"}}}\n' | ./target/release/polaris-knowledge-mcp --workspace 'D:\space\base\Polaris' 2>/dev/null | grep -c '"jsonrpc":"2.0".*"id":[0-9]'
```
Expected: 4 (initialize + 3 tool calls all return responses)

- [ ] **Step 8: Commit**

```bash
git add crates/polaris-knowledge-mcp/src/server.rs crates/polaris-knowledge-mcp/src/handler.rs
git commit -m "feat(knowledge-mcp): add thread pool for concurrent request processing"
```

---

### Task 4: 部署并端到端验证

**Files:**
- Binary: `crates/polaris-knowledge-mcp/target/release/polaris-knowledge-mcp.exe`

- [ ] **Step 1: Build release binary**

Run: `cd D:/space/base/Polaris/crates/polaris-knowledge-mcp && cargo build --release 2>&1`

- [ ] **Step 2: 部署到所有位置**

```bash
cp target/release/polaris-knowledge-mcp.exe D:/app/polaris/polaris-knowledge-mcp.exe
cp target/release/polaris-knowledge-mcp.exe D:/space/base/Polaris/src-tauri/target/debug/polaris-knowledge-mcp.exe
cp target/release/polaris-knowledge-mcp.exe D:/space/base/Polaris/src-tauri/target/release/polaris-knowledge-mcp.exe
```

- [ ] **Step 3: 并行 MCP tool 调用验证**

在 Claude Code 中并行调用两个只读 tool：
```
mcp__polaris-knowledge__list_modules
mcp__polaris-knowledge__get_architecture_overview
```
Expected: 两个都成功返回数据，不再出现 "Not connected"

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit --allow-empty -m "chore(knowledge-mcp): deploy concurrent binary to all locations"
```

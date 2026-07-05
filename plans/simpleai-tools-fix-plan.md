# SimpleAI 工具链最佳调整方案

> 状态：**规划中**
> 创建：2026-07-05
> 参考：plans/simpleai-tools-fix-plan.md（初版，已作废，本文件替代）

---

## 一、问题诊断（基于代码通读）

### 1.1 真正导致"完全不可用"的根因

**问题 A：edit_file 用子串计数 + 不处理 CRLF（致命）**

- `tools/fs.rs:227` `content.matches(old).count()` 是子串级别计数，非行级匹配
- Windows 文件多为 CRLF，`read_to_string` 保留 `\r\n`，模型生成的 `old_string` 是 `\n`，匹配必败
- 错误信息只有 `old_string not found in file`，零线索
- 同一文件多次编辑必须把前面所有旧文本复述进 context，极易触发 `not unique`

**问题 B：bash 在 Windows 上硬编码 `cmd /C`（致命）**

- `tools/bash.rs:60-68` Windows 下强制 `cmd.exe`
- 模型 90% 训练语料是 POSIX 语法（`&&`、`||`、`$()`、`grep`、`sed`、`rm -rf`）
- `cmd` 下这些命令和语法几乎全不可用 → `[exit code: 127]` 堆砌，错误输出无解读
- 退出码非零直接 `ToolOutcome::fail`，模型无纠正路径

**问题 C：read_file 无行号、无行范围（严重）**

- `tools/fs.rs:52` 整文件读 + `truncate_chars(64KB)`，无 `offset/limit`
- 输出无行号前缀，模型无法定位修改位置
- 截断时只写 `(... truncated)`，没提示用 `search_files` 或行范围

### 1.2 工程性不足（影响可靠性）

- `search_files` 用裸 `walkdir` + `String::contains`，无 regex、无 `.gitignore`、无二进制过滤
- 项目已有 `ignore::WalkBuilder` + `regex` 成熟搜索封装（`file_explorer.rs`），SimpleAI 未复用
- `apply_patch` 行匹配用 `trim_end()` 比较，比 edit_file 好一档，但仍不处理 CRLF
- MCP 环境变量传空 HashMap，插件常因缺 API key 启动失败
- Agent 白名单字段存在但不生效（`with_allowed_tools` 未实现）
- Subagent 中断独立 watch channel，父中断不会传播

---

## 二、行业对标分析

### 2.1 Claude Code（Anthropic CLI）

| 维度 | Claude Code 做法 |
|------|------------------|
| 文件编辑 | `write` 整文件覆盖 + 大文件行号提示；不做细粒度行级编辑 |
| 文件搜索 | ripgrep 集成，支持 regex / case-insensitive / 二进制过滤 / .gitignore |
| Shell 执行 | 用 sh/bash，exit code ≠ 0 标 failure 但仍返回 stdout/stderr |
| 错误反馈 | 明确 "file not found" / "command not found" 提示，无模糊失败 |
| 上下文管理 | 大文件默认截断，返回总行数/字节数，提示用 search 定位 |

### 2.2 OpenAI Codex CLI

| 维度 | Codex 做法 |
|------|------------|
| 文件编辑 | `apply_patch` 多文件/多 hunk，context 行带空格前缀，失败时提示 "re-read file" |
| 文件搜索 | ripgrep + `.gitignore` 感知，输出带行号 |
| Shell 执行 | 用 sh，exit 127 时明确提示 "command not found" |
| 错误反馈 | patch 失败时报 "could not locate lines" + 文件实际内容预览 |
| 提示词 | 详细描述 apply_patch 格式、edit_file 注意事项、失败重试策略 |

### 2.3 Cursor（编辑器集成）

| 维度 | Cursor 做法 |
|------|------------|
| 文件编辑 | diff 格式编辑，行级匹配，失败时高亮实际文件内容对比 |
| 文件搜索 | 实时 glob + 内容搜索，带行数/行号/预览 |
| 错误处理 | 失败时不静默，返回 "实际内容 vs 期望内容" 对比 |
| 性能 | 大文件懒加载，只读取可见区域 |

### 2.4 共性规律（必须遵循）

1. **行号是标配**：任何文件输出必须带行号，任何编辑失败必须关联到具体行
2. **失败必须有线索**：错误信息告诉模型"实际文件长什么样"，不是"失败了"
3. **搜索是编辑的前提**：先 search/glob 定位，再 edit，不允许盲编
4. **大文件必须支持行范围**：offset/limit 参数，不整文件加载
5. **平台兼容性**：Windows 上 POSIX 命令不可用，应明确告知模型用专用工具

---

## 三、最佳调整方案（基于对标 + 项目现状）

### 3.1 核心策略

**不盲目照搬 Codex 的 apply_patch 格式，不照抄 Claude Code 的整文件覆盖，走"行级精确编辑 + 搜索优先"路线。**

理由：
- Codex 的 apply_patch 信封格式对模型不友好（`*** Begin Patch`、`+`/`-` 前缀、空格前缀），模型经常记错格式导致解析失败
- Claude Code 整文件覆盖在文件较大时容易丢失未提及的代码段
- **行级精确编辑（类似 Claude Code search+edit 组合）最稳健**：先 search 定位 → 再按行号/行内容精准编辑

### 3.2 工具集重构方案

| 工具 | 现状 | 目标 | 说明 |
|------|------|------|------|
| `read_file` | 整文件 + 截断 | **行号输出 + offset/limit** | 每行前加 `{n:>5}\t`，返回时附总行数 |
| `edit_file` | 子串匹配 | **行级行号范围编辑** | 传起始行号 + 替换文本，避免 context 匹配问题 |
| `search_files` | walkdir + contains | **复用项目 ripgrep 封装** | `ignore::WalkBuilder` + regex + .gitignore + 二进制过滤 |
| `apply_patch` | 信封格式 | **保留但增强错误信息** | CRLF 归一化 + 失败时返回实际内容预览 |
| `bash` | cmd.exe 硬编码 | **Git Bash 优先 + 友好提示** | 探测 Git Bash / pwsh / cmd 顺序，description 明确限制 |
| `glob` | 自研 glob | **保留（已可用）** | 已有完整实现，无需大改 |

---

## 四、具体实施计划

### Phase 1：edit_file 从子串匹配升级为行级编辑（P0，最高 ROI）

**目标**：彻底解决 edit_file 在 Windows 下"完全不可用"的问题

**改动文件**：
- `tools/fs.rs`（edit_file 实现）
- `prompt.rs`（系统提示词引导）

**新 edit_file 接口**：

```json
{
  "type": "function",
  "function": {
    "name": "edit_file",
    "description": "Replace lines in a file by line range. First read the file with read_file to get line numbers, then specify the exact range to replace.\n\nParameters: path, start_line (1-based), end_line (inclusive), replacement_text.\nExample: read_file shows 5 lines, use start_line=3, end_line=3, replacement_text='new line here' to replace line 3.\n\nIMPORTANT: Always read the file first to verify line numbers before editing. Do NOT guess line numbers.",
    "parameters": {
      "type": "object",
      "properties": {
        "path": { "type": "string", "description": "Absolute or relative file path" },
        "start_line": { "type": "integer", "description": "1-based starting line number" },
        "end_line": { "type": "integer", "description": "1-based ending line number (inclusive)" },
        "replacement_text": { "type": "string", "description": "Text to replace the specified line range with (may span multiple lines)" }
      },
      "required": ["path", "start_line", "end_line", "replacement_text"]
    }
  }
}
```

**实现要点**：
```rust
fn edit_file_by_lines(content: &str, start: usize, end: usize, replacement: &str) -> Result<String, String> {
    let lines: Vec<&str> = content.lines().collect();
    let (total_lines, had_trailing_newline) = detect_line_count_and_trailing(content);
    
    if start == 0 || start > total_lines || end > total_lines || start > end {
        return Err(format!(
            "Invalid line range: start={}, end={}, total_lines={}. Check line numbers and try again.",
            start, end, total_lines
        ));
    }
    
    let mut new_lines = lines[..(start - 1)].to_vec();
    let replacement_lines: Vec<&str> = replacement.lines().collect();
    
    if replacement.is_empty() {
        // 空替换 = 删除行
    } else {
        new_lines.extend(replacement_lines);
    }
    new_lines.extend(lines[end..].iter());
    
    let mut result = new_lines.join("\n");
    if had_trailing_newline {
        result.push('\n');
    }
    Ok(result)
}
```

**read_file 同步改造**：
- 输出加行号前缀：`     1\tfn main() {`
- 加 `offset` 和 `limit` 参数
- 返回附带 `Showing lines X-Y of Z (total N bytes)` 元信息
- 超过截断阈值时明确提示 "Use offset=N to continue reading"

---

### Phase 2：search_files 升级为 ripgrep 级（P0）

**目标**：复用项目已有 `ignore::WalkBuilder` + `regex` 封装，达到真实搜索工具的水准

**改动文件**：
- `tools/search.rs`（重构搜索实现）
- `Cargo.toml`（确认 ignore 依赖已存在）

**新 search_files 接口**：

```json
{
  "type": "function",
  "function": {
    "name": "search_files",
    "description": "Search file contents using regex pattern. Respects .gitignore and .ignore files. Skips binary files and build/dependency directories.\n\nParameters: pattern (regex), path (dir, optional), file_ext (e.g. 'rs'), case_insensitive (default true).\n\nExamples: 'fn main' finds main functions; 'log\\.(error|warn)' finds log calls.\nUse this to locate code before editing. Returns file:line:context format with up to 200 matches.",
    "parameters": {
      "type": "object",
      "properties": {
        "pattern": { "type": "string", "description": "Regex pattern to search for" },
        "path": { "type": "string", "description": "Directory to search under (optional, defaults to working directory)" },
        "file_ext": { "type": "string", "description": "Optional file extension filter (e.g. 'rs', 'ts')" },
        "case_insensitive": { "type": "boolean", "description": "Case-insensitive matching (default true)" }
      },
      "required": ["pattern"]
    }
  }
}
```

**实现要点**（参考 `file_explorer.rs` 的 `search_file_contents_blocking`）：
```rust
fn run_search_files(pattern: &str, ...) -> ToolOutcome {
    // 构建 regex，默认 case_insensitive
    let regex = regex::RegexBuilder::new(pattern)
        .case_insensitive(case_insensitive)
        .build()
        .map_err(|e| format!("Invalid regex '{}': {}", pattern, e))?;
    
    // 复用项目的忽略逻辑
    let mut builder = ignore::WalkBuilder::new(&root);
    builder
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .hidden(false)
        .follow_links(false)
        .filter_entry(|e| !is_skip_dir(e));
    
    // 二进制检测、大小限制、匹配收集
    // ...（复用项目已有逻辑）
}
```

**glob 工具保留现状**：自研 glob 实现已完备，无需改动。

---

### Phase 3：bash 平台兼容（P0）

**目标**：Windows 下支持 POSIX 命令，失败时给出明确解读

**改动文件**：
- `tools/bash.rs`
- `prompt.rs`（描述 bash 实际限制）

**shell 探测顺序**：
```rust
fn detect_shell() -> (&'static str, &'static str) {
    #[cfg(windows)]
    {
        // 1. Git Bash（最常见的 POSIX shell）
        let git_bash = std::env::var("GIT_INSTALL_ROOT").ok()
            .and_then(|root| {
                let path = Path::new(&root).join("usr/bin/bash.exe");
                if path.exists() { Some(path.to_string_lossy().to_string()) } else { None }
            });
        if let Some(shell) = git_bash {
            return ("git_bash", &shell);
        }
        // 2. PowerShell
        if Path::new("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe").exists() {
            return ("pwsh", "pwsh");
        }
        // 3. 回退 cmd
        return ("cmd", "cmd");
    }
    ("sh", "sh")
}
```

**输出增强**（退出码解读）：
```rust
// 在 run_bash 输出后附加退出码解读
if exit_code == 127 {
    result.push_str(&format!(
        "\n[Shell error: Command '{}' not found. On Windows, POSIX commands like grep/sed/find may not be available. Use the dedicated tools (search_files, edit_file) instead.]",
        first_word_of_command(command)
    ));
}
```

**description 更新**：
```
"Execute a shell command and return its output. On Windows, the available shell is Git Bash or PowerShell if detected, falling back to cmd.exe. POSIX commands (grep, sed, find) may not be available. Prefer the dedicated tools (search_files, glob, read_file, edit_file) which work identically across platforms."
```

---

### Phase 4：系统提示词增强（P1）

**目标**：在 `prompt.rs` 中加入完整的工具使用指南，告诉模型最佳实践和失败恢复策略

**改动文件**：
- `prompt.rs`（PERSONA 追加 `# Tool usage guide` 段落）

**新增内容**：
```
# Tool usage guide
- **Editing files**: ALWAYS read the file with read_file first to get line numbers, then use
  edit_file with the exact line range. Never guess line numbers. If you need to edit multiple
  lines, use apply_patch for multi-hunk changes. After editing, re-read the file to verify.
- **Large files**: For files >500 lines, use search_files to locate the relevant section before
  reading. Use read_file with offset/limit to read only what you need.
- **Searching**: Use search_files for content (supports regex) and glob for filenames. search_files
  respects .gitignore and skips binary files.
- **Shell commands**: On Windows, the shell may be cmd.exe (no grep/sed/find). Prefer dedicated
  tools over shell equivalents. If a shell command fails with exit code 127, the command is
  not installed — use a dedicated tool instead.
- **Failure recovery**: If edit_file fails with an invalid line range error, re-read the file to
  get current line numbers. If search_files returns no matches, try a different pattern or
  file_ext filter.
```

---

### Phase 5：错误信息全面增强（P1）

**目标**：所有工具失败时提供"实际内容预览 + 操作建议"，不是"failed"

**改动文件**：
- `tools/fs.rs`（edit_file 失败时显示附近行）
- `tools/apply_patch.rs`（失败时显示实际内容预览）
- `tools/search.rs`（无匹配时建议不同 pattern）

**edit_file 失败信息示例**：
```
edit_file failed: Invalid line range (start=42, end=45, total_lines=38).
Current file ends at line 38. Re-read with read_file to get updated line numbers.
Last 3 lines of file:
   36	}
   37	fn helper() { }
   38	
```

**apply_patch 失败信息示例**：
```
apply_patch failed: chunk 1 could not locate the lines to replace.
The file has changed since you read it. Re-read with read_file to get current content.
Expected context (first 3 lines of chunk):
  "  fn main() {"
  "      let x = 42;"
  "      println!("{}", x);"
```

---

### Phase 6：其他基础设施（P2）

| 改动 | 说明 |
|------|------|
| MCP env 传递 | `mcp/mod.rs:43` 将空 HashMap 改为从 `ResolvedExternalMcpServer.env` 读取 |
| Agent 白名单 | 实现 `ToolRegistry::with_allowed_tools()` + `agent.rs` 中按白名单过滤 |
| Subagent 中断联动 | `ToolContext` 加 `abort_rx` 字段，`agent.rs` 中子会话共享父 abort |
| read_file 行范围 | 加 `offset`/`limit` 参数（与 edit_file 改造一并实现） |

---

## 五、实施顺序与工时估算

```
Phase 1 ─── edit_file 行级编辑 + read_file 行号/行范围 ─── 2天 ─── P0 (最关键)
Phase 3 ─── bash 平台兼容 ──── 0.5天 ──── P0
Phase 2 ─── search_files ripgrep 升级 ──── 1天 ─── P0
Phase 4 ─── 系统提示词增强 ──── 0.5天 ──── P1
Phase 5 ─── 错误信息全面增强 ──── 1天 ──── P1
Phase 6 ─── 基础设施 ──── 2天 ──── P2

预计总工时：~7天
```

**先做 Phase 1 + Phase 3**，这两个改动最小但直接解决"完全不可用"体验。完成后可立即验证。

---

## 六、验证策略

| 验证项 | 方法 | 预期 |
|--------|------|------|
| edit_file 行级编辑 | 读取含 CRLF 的文件，用行号范围编辑 | 编辑成功，不依赖 CRLF 感知 |
| read_file 行号 | 读取任意文件 | 输出带 `{n:>5}\t` 行号前缀 |
| read_file 行范围 | 读大文件 offset=50, limit=20 | 只返回 20 行，附元信息 |
| search_files regex | 搜 `fn main`、`log\.(error\|warn)` | 正确匹配，忽略 .gitignore 文件 |
| bash 退出码解读 | 跑 `grep`（Windows cmd 下不存在） | 明确提示 "command not found, use search_files" |
| apply_patch 失败 | 故意传错 context | 返回实际文件内容预览 |

---

## 七、风险与边界

| 风险 | 缓解 |
|------|------|
| 模型不习惯按行号编辑 | 提示词强制 "ALWAYS read first to get line numbers"，加 retry 兜底 |
| 行号范围编辑对多行删除/插入支持 | replacement_text 为空 = 删除，支持 |
| ripgrep 依赖可能过大 | 项目已有 `ignore` crate，无需新增依赖 |
| Windows shell 探测失败 | 回退 cmd，description 中明确声明限制 |

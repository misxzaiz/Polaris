# Plan: 为 Codex 代理模式添加模型目录支持

## 背景

Codex CLI 需要一个 `model_catalog_json` 文件来获取模型的元数据（context_window、tools 支持、reasoning 能力等）。对于非 OpenAI 标准模型（如 `sensenova-6.7-flash-lite`），如果没有这个文件，Codex 会报 `Model metadata not found. Defaulting to fallback metadata`，且无法正确判断模型是否支持 tools。

## 当前状态

Polaris 已经实现了正确的代理拓扑：
```
Codex CLI → (Responses API) → Polaris 本地代理 → (Chat Completions) → 上游端点
```

但 `generate_codex_proxy_config_args()` 生成的 TOML 中没有 `model_catalog_json` 字段，也没有在磁盘上生成对应的模型目录文件。

## 实施方案

### 改动文件

1. **`src-tauri/src/services/model_profile_service.rs`** — 新增模型目录文件生成
2. **`src-tauri/src/services/proxy/mod.rs`** — 清理目录文件的代理关闭时逻辑（可选）

### 修改流程

#### Step 1: 新增 `generate_codex_proxy_model_catalog()` 方法和模型目录常量

在 `ModelProfileService` 中：

```rust
/// Codex 模型目录文件名 - 写入 ~/.codex/ 目录
pub const CODEX_MODEL_CATALOG_FILENAME: &str = "polaris-model-catalog.json";

/// 为代理模式生成 Codex 模型目录文件
///
/// 目录文件告诉 Codex CLI 模型的 metadata（context_window、tools 支持等），
/// 避免 "Model metadata not found" 警告和 fallback 行为。
pub fn write_codex_proxy_model_catalog(profile: &ModelProfile) -> Result<PathBuf> {
    let codex_dir = get_codex_config_dir(); // ~/.codex/
    let catalog_path = codex_dir.join(CODEX_MODEL_CATALOG_FILENAME);
    
    let catalog = serde_json::json!({
        "models": [{
            "slug": profile.model,
            "display_name": &profile.name,
            "description": format!("{} - {}", profile.name, profile.model),
            "context_window": 128000,
            "max_context_window": 128000,
            "effective_context_window_percent": 95,
            "supports_parallel_tool_calls": true,
            "shell_type": "shell_command",
            "apply_patch_tool_type": "freeform",
            "supported_reasoning_levels": [
                {"effort": "low", "description": "Fast responses with lighter reasoning"},
                {"effort": "medium", "description": "Balances speed and reasoning depth for everyday tasks"},
                {"effort": "high", "description": "Greater reasoning depth for complex problems"}
            ],
            "default_reasoning_level": "medium",
            "visibility": "list",
            "supported_in_api": true,
            "priority": 500,
            "input_modalities": ["text"],
            "supports_search_tool": false,
            "supports_reasoning_summaries": true,
            "support_verbosity": false,
            "base_instructions": "You are Codex, a coding agent. You and the user share one workspace, and your job is to collaborate with them until their goal is genuinely handled.",
            "truncation_policy": {"mode": "bytes", "limit": 10000}
        }]
    });
    
    // 确保 ~/.codex/ 目录存在
    if let Some(parent) = catalog_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    
    let content = serde_json::to_string_pretty(&catalog)?;
    std::fs::write(&catalog_path, content)?;
    
    tracing::info!("[ModelProfileService] 写入 Codex 模型目录: {:?} (model={})", catalog_path, profile.model);
    Ok(catalog_path)
}

/// 清理 Codex 模型目录文件
pub fn cleanup_codex_proxy_model_catalog() -> Result<()> {
    let codex_dir = get_codex_config_dir();
    let catalog_path = codex_dir.join(CODEX_MODEL_CATALOG_FILENAME);
    if catalog_path.exists() {
        std::fs::remove_file(&catalog_path)?;
        tracing::info!("[ModelProfileService] 清理 Codex 模型目录: {:?}", catalog_path);
    }
    Ok(())
}

/// 获取 ~/.codex/ 目录
fn get_codex_config_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".codex")
}
```

#### Step 2: 修改 `generate_codex_proxy_config_args()` 添加 `model_catalog_json` 字段

在现有的 `generate_codex_proxy_config_args()` 末尾（或新建方法）追加：

```
"-c".to_string(),
format!("model_catalog_json=\"{}\"", CODEX_MODEL_CATALOG_FILENAME),
```

#### Step 3: 在 `apply_model_profile_options()` 中调用目录生成

在 `chat.rs` 的 `Codex` 引擎分支——代理启动成功时，在 `generate_codex_proxy_config_args` 之前先调用 `write_codex_proxy_model_catalog()` 写入目录文件。这样每次 Codex 会话启动时，目录文件都是最新的。

#### Step 4: 直连模式 (`openai-responses`) 也加目录支持

对于 `wire_api = "openai-responses"` 的直连模式，同样需要模型目录。cc-switch 对 NativeResponses 模式额外处理了 `supports_parallel_tool_calls`、`input_modalities` 等字段，并且禁用了 `apply_patch_tool_type`（因为原生 Responses 网关不支持 `type=="custom"` 工具）。但 Sensenova 始终走代理，所以可以简化。

### 测试方法

1. 构建 Polaris
2. 启动 Polaris + Sensenova Profile
3. 选择 Codex 引擎发送一条简单消息
4. 验证：
   - `~/.codex/polaris-model-catalog.json` 文件已生成
   - Codex 日志中 `Model metadata not found` 消失
   - Response 正常返回，工具调用正常
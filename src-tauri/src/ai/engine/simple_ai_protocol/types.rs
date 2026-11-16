//! CliModelSuffix 与模型后缀解析（K-R1 拆分）

// ============================================================================
// CLI 私有模型后缀解析
// ============================================================================

/// CLI 私有模型后缀解析结果。
///
/// Anthropic Claude CLI 使用 `[1m]` 等方括号后缀作为元数据标记（不在上游 API 协议中），
/// 含义是把"1M 上下文"等能力开关转换成 `anthropic-beta` 请求头与 `?beta=true` query。
///
/// SimpleAI 引擎走直接 HTTP 调用，上游不认方括号后缀。本函数负责：
/// - 剥离后缀，返回纯模型名（写入请求体 `model` 字段）；
/// - 对已知的 `[1m]` 标记返回 beta 头片段，供 HTTP 请求构建时注入。
/// - 对未知后缀（如 `glm-5.2[1m]` 这类从 CLI 复制过来、对非 Anthropic 上游无意义的标记）
///   静默剥离，不注入 beta 头。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct CliModelSuffix {
    /// 剥离后的纯模型名（可直接写入请求体 `model` 字段）。
    pub base_model: Option<String>,
    /// 应注入 `anthropic-beta` 头的片段（逗号拼接），仅 Anthropic 协议使用。
    /// `None` = 不需要 beta 头。
    pub beta_tokens: Option<Vec<String>>,
    /// 应追加到上游 URL 的 query（如 `?beta=true`），仅 Anthropic 协议使用。
    pub query: Option<String>,
    /// 由后缀推导的上下文窗口（token），与线路协议无关。
    /// 仅当后缀可解析为数值（如 `[1m]`/`[200k]`/`[128000]`）时才有值；
    /// 驱动 SimpleAI 压缩触发阈值，详见 `chat_loop` 的窗口优先级。
    pub context_window: Option<u64>,
}

/// 数值后缀解析出的窗口上限（token）：防 `[1000000m]` 这类无意义超大值。
/// 覆盖 1M/4M/8M 等已知大窗口后仍留余量。
const MAX_SUFFIX_CONTEXT_WINDOW: u64 = 16_000_000;

/// 内置的 Anthropic 1M 上下文 beta 头片段与 query。
/// 取自 Claude CLI 实际发送值（见 docs/proxy-anthropic-passthrough-headers-fix.md）。
const CONTEXT_1M_BETA_TOKENS: &[&str] = &[
    "claude-code-20250219",
    "context-1m-2025-08-07",
    "interleaved-thinking-2025-05-14",
];
const CONTEXT_1M_QUERY: &str = "beta=true";

/// 剥离模型名中的 CLI 私有后缀，解析附带的协议信号。
///
/// 输入示例：
/// - `"claude-fable-5[1m]"` → base=`claude-fable-5`, beta=[context-1m,...], query=`beta=true`,
///   context_window=1_000_000
/// - `"glm-5.2[1m]"`        → base=`glm-5.2`, beta=[context-1m,...], query=`beta=true`（现状不变），
///   context_window=1_000_000（窗口信号与线路无关）
/// - `"deepseek-v3"`        → base=`deepseek-v3`, 无变更
/// - `"gpt-4o[thinking]"`   → base=`gpt-4o`, 无变更(未知后缀)
/// - `"claude-4[200k]"`     → base=`claude-4`, beta=None(仅 `[1m]` 注入 beta 头), context_window=200_000
pub fn strip_cli_model_suffix(model: &str) -> CliModelSuffix {
    let Some((base, suffix_part)) = model.split_once('[') else {
        return CliModelSuffix {
            base_model: Some(model.to_string()),
            beta_tokens: None,
            query: None,
            context_window: None,
        };
    };

    let suffix = suffix_part.trim_end_matches(']');
    let base = base.trim_end();

    if base.is_empty() {
        // 畸形输入（如 `[1m]`），保守地当作原样返回，不剥离。
        return CliModelSuffix {
            base_model: Some(model.to_string()),
            beta_tokens: None,
            query: None,
            context_window: None,
        };
    }

    // 仅 CLI 实际使用的 `[1m]`（小写）在 Anthropic 线路注入 beta 头/query；
    // 其余可解析数值后缀只推导 context_window，不注入 beta（见上注释）。
    let (beta_tokens, query) = if suffix == "1m" {
        (
            Some(CONTEXT_1M_BETA_TOKENS.iter().map(|s| s.to_string()).collect()),
            Some(CONTEXT_1M_QUERY.to_string()),
        )
    } else {
        (None, None)
    };

    CliModelSuffix {
        base_model: Some(base.to_string()),
        beta_tokens,
        query,
        context_window: parse_suffix_window(suffix),
    }
}

/// 解析数值后缀为上下文窗口（token）。大小写不敏感，支持 m/k 单位与纯数值：
/// - `1m`/`1M` → 1_000_000
/// - `200k`/`200K` → 200_000
/// - `128000` → 128_000
/// - `0.2m` → 200_000（小数结果四舍五入到整数）
///   不可解析（`thinking`、空、负数、超上限等）→ `None`，仅剥离不报错。
fn parse_suffix_window(suffix: &str) -> Option<u64> {
    let s = suffix.trim();
    if s.is_empty() {
        return None;
    }
    let (num_part, mult) = match s.chars().last() {
        Some('m' | 'M') => (&s[..s.len() - 1], 1_000_000u64),
        Some('k' | 'K') => (&s[..s.len() - 1], 1_000u64),
        _ => (s, 1u64),
    };
    let num_part = num_part.trim();
    if num_part.is_empty() {
        return None;
    }
    // 纯整数或小数；小数带单位时在浮点域完成换算并取整（如 0.2m → 200_000）。
    let window = if let Ok(v) = num_part.parse::<u64>() {
        v.saturating_mul(mult)
    } else if let Ok(v) = num_part.parse::<f64>() {
        if !v.is_finite() || v < 0.0 {
            return None;
        }
        let scaled = v * (mult as f64);
        if scaled > (MAX_SUFFIX_CONTEXT_WINDOW as f64) {
            return None;
        }
        scaled.round() as u64
    } else {
        return None;
    };
    if window == 0 || window > MAX_SUFFIX_CONTEXT_WINDOW {
        return None;
    }
    Some(window)
}

/// 构建：等价于 `strip_cli_model_suffix(model)`，提供 `::new` 调用点。
impl CliModelSuffix {
    pub fn new(model: &str) -> Self {
        strip_cli_model_suffix(model)
    }
}
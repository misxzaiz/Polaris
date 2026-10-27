/*! 图片输入（多模态）能力判定 —— 单一权威。

 * 背景：同一模型供应商下的不同模型能力不齐（如 `glm-4v` 支持视觉、`glm-4-flash` 不支持），
 * 静态判定「模型支不支持图片输入」无法可靠完成。若盲目把图片块发给不支持的模型，
 * API 会以 400 拒绝，导致整轮对话崩溃。
 *
 * 本模块提供**三级能力来源**的判定，避免「发图块 → 400 报错」：
 * - `support`（确定支持）：Profile 显式声明 `imageInput="support"`，或模型名命中已知视觉模型清单。
 *   此时允许直通原生图块（`content:[{type:image}]` / `image_url`）。
 * - `unsupported`（确定不支持）：Profile 显式声明 `imageInput="unsupported"`。
 *   此时**绝不发图块**，走「落盘 + 指向 + AI 决策」路径（`image_bridge`）。
 * - `unknown`（无法判定，默认）：`auto` 且模型名不在清单内。**保守地不发图块**，
 *   走指向路径；若曾判定 `support` 但实际 400，由 `chat_loop` 捕获后自动降级为指向路径。
 *
 * 判定优先级：Profile 显式声明 > 已知视觉模型名清单 > 保守 `unknown`。
 */

/// 图片输入能力判定结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VisionSupport {
    /// 确定支持（可直通原生图块）
    Support,
    /// 确定不支持（走指向路径，绝不发图块）
    Unsupported,
    /// 无法判定（默认；保守走指向路径，避免 400）
    Unknown,
}

/// 已知支持视觉的模型名子串（小写匹配）。
///
/// 这是一个尽力而为的清单，覆盖常见多模态模型。命中即 `Support`；
/// 未命中 → `Unknown`（保守，不发图块）。Profile 显式声明优先于本清单。
const VISION_MODEL_KEYWORDS: &[&str] = &[
    // OpenAI
    "gpt-4o", "gpt-4.1", "gpt-4-turbo", "gpt-4-vision", "o3", "o4",
    // Anthropic
    "claude-3", "claude-3.5", "claude-3.7", "claude-opus-4", "claude-sonnet-4", "claude-haiku",
    // 智谱 GLM
    "glm-4v", "glm-4.1v", "glm-4.5v", "glm-4.6v",
    // 通义千问 VL
    "qwen-vl", "qwen2-vl", "qwen2.5-vl", "qwen3-vl",
    // Gemini
    "gemini", "gemini-2", "gemini-2.5", "gemini-3",
    // 豆包 / 字节
    "doubao-vision", "doubao-1.5-vision",
    // 讯飞 / 其他
    "spark-vl", "hunyuan-vision", "pixtral", "llava", "internvl", "minicpm-v",
    // SenseNova 视觉系列
    "sensenova-vl", "nova-vl", "nova-vision",
];

/// 由 Profile 的 `image_input` 声明解析为 `VisionSupport`。
///
/// - `Some("support")` → Support
/// - `Some("unsupported")` → Unsupported
/// - `Some("auto")` / `None` / 其他 → 由 `resolve_vision_support` 继续按模型名推断
fn from_declared(declared: Option<&str>) -> Option<VisionSupport> {
    match declared.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("support") | Some("true") | Some("1") => Some(VisionSupport::Support),
        Some("unsupported") | Some("false") | Some("0") => Some(VisionSupport::Unsupported),
        _ => None, // "auto" / 空 / 未声明 → 交给模型名推断
    }
}

/// 解析 `ModelProfile` 的图片输入能力（单一权威入口）。
///
/// 优先级：Profile 显式声明 > 已知视觉模型名清单 > 保守 `Unknown`。
pub fn resolve_vision_support(profile: &crate::models::config::ModelProfile) -> VisionSupport {
    if let Some(v) = from_declared(profile.image_input.as_deref()) {
        return v;
    }
    let model = profile.model.to_ascii_lowercase();
    if VISION_MODEL_KEYWORDS.iter().any(|kw| model.contains(kw)) {
        VisionSupport::Support
    } else {
        // 模型名不在已知清单 → 无法判定。保守：不发图块（避免 400），走指向路径。
        VisionSupport::Unknown
    }
}

/// 便捷：是否应直通原生图块（仅确定 Support 才允许）。
pub fn should_send_raw_image(profile: &crate::models::config::ModelProfile) -> bool {
    resolve_vision_support(profile) == VisionSupport::Support
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::config::ModelProfile;

    fn profile_with(model: &str, image_input: Option<&str>) -> ModelProfile {
        ModelProfile {
            id: "p".into(),
            name: "P".into(),
            base_url: "https://x".into(),
            api_key: "k".into(),
            model: model.into(),
            image_input: image_input.map(|s| s.to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn declared_support_wins() {
        // 显式声明 support，即使模型名不在清单
        assert_eq!(
            resolve_vision_support(&profile_with("glm-4-flash", Some("support"))),
            VisionSupport::Support
        );
    }

    #[test]
    fn declared_unsupported_wins() {
        // 显式声明 unsupported，即使模型名命中清单
        assert_eq!(
            resolve_vision_support(&profile_with("glm-4v", Some("unsupported"))),
            VisionSupport::Unsupported
        );
    }

    #[test]
    fn known_vision_model_inferred_support() {
        assert_eq!(
            resolve_vision_support(&profile_with("glm-4v-flash", None)),
            VisionSupport::Support
        );
        assert_eq!(
            resolve_vision_support(&profile_with("qwen-vl-plus", None)),
            VisionSupport::Support
        );
        assert_eq!(
            resolve_vision_support(&profile_with("gpt-4o", None)),
            VisionSupport::Support
        );
    }

    #[test]
    fn unknown_model_is_conservative() {
        // 模型名不在清单 → Unknown（保守，不发图块）
        assert_eq!(
            resolve_vision_support(&profile_with("glm-4-flash", None)),
            VisionSupport::Unknown
        );
        assert_eq!(
            resolve_vision_support(&profile_with("deepseek-v3", None)),
            VisionSupport::Unknown
        );
    }

    #[test]
    fn auto_falls_through_to_model_name() {
        assert_eq!(
            resolve_vision_support(&profile_with("glm-4v", Some("auto"))),
            VisionSupport::Support
        );
    }

    #[test]
    fn should_send_raw_image_gates_on_support_only() {
        assert!(should_send_raw_image(&profile_with("gpt-4o", None)));
        assert!(!should_send_raw_image(&profile_with("glm-4-flash", None)));
        assert!(!should_send_raw_image(&profile_with(
            "glm-4v",
            Some("unsupported")
        )));
    }
}

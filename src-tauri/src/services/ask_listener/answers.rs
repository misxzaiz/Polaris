//! AppState answer sender bookkeeping（K-R3 拆分）

use super::types::QuestionAnswerPayload;
use crate::state::SubAnswer;
use super::types::PluginCardOutcome;
use super::parsed::ParsedQuestion;
use super::types::QuestionOutcome;

use tokio::sync::oneshot;
use crate::state::AppState;

/// Internal entry stored in `AppState.ask_answer_senders`.
pub struct AskAnswerEntry {
    pub questions: Vec<ParsedQuestion>,
    pub sender: oneshot::Sender<QuestionOutcome>,
}

/// Internal entry stored in `AppState.plugin_card_answer_senders`.
pub struct PluginCardAnswerEntry {
    pub sender: oneshot::Sender<PluginCardOutcome>,
}

/// Internal entry stored in `AppState.form_answer_senders`.
///
/// See [`handle_form_frame`] for the blocking loop: the sender is `await`ed
/// until the user submits the form (via `form_submit`), the hold expires, or
/// the connection drops.
pub struct FormAnswerEntry {
    /// oneshot results in the receipt text the engine sees as tool_result.
    pub sender: oneshot::Sender<String>,
}

impl AppState {
    /// Register a oneshot answer sender keyed by call_id.
    pub(crate) fn register_ask_answer_sender(
        &self,
        call_id: &str,
        questions: Vec<ParsedQuestion>,
        sender: oneshot::Sender<QuestionOutcome>,
    ) {
        if let Ok(mut map) = self.ask_answer_senders.lock() {
            map.insert(call_id.to_string(), AskAnswerEntry { questions, sender });
        }
    }

    /// Remove and return the answer entry for a call_id, if present.
    pub fn take_ask_answer_sender(&self, call_id: &str) -> Option<AskAnswerEntry> {
        self.ask_answer_senders.lock().ok()?.remove(call_id)
    }

    pub(crate) fn register_plugin_card_answer_sender(
        &self,
        interaction_id: &str,
        sender: oneshot::Sender<PluginCardOutcome>,
    ) {
        if let Ok(mut map) = self.plugin_card_answer_senders.lock() {
            map.insert(interaction_id.to_string(), PluginCardAnswerEntry { sender });
        }
    }

    pub fn take_plugin_card_answer_sender(
        &self,
        interaction_id: &str,
    ) -> Option<PluginCardAnswerEntry> {
        self.plugin_card_answer_senders
            .lock()
            .ok()?
            .remove(interaction_id)
    }

    /// Register a form answer sender keyed by form_id.
    pub(crate) fn register_form_answer_sender(
        &self,
        form_id: &str,
        sender: oneshot::Sender<String>,
    ) {
        if let Ok(mut map) = self.form_answer_senders.lock() {
            map.insert(form_id.to_string(), FormAnswerEntry { sender });
        }
    }

    /// Remove and return the form answer entry for a form_id, if present.
    pub fn take_form_answer_sender(&self, form_id: &str) -> Option<FormAnswerEntry> {
        self.form_answer_senders.lock().ok()?.remove(form_id)
    }
}

/// Build a `QuestionOutcome` from the user-submitted multi-answer payload.
/// Length-aligns `answers` to `entry.questions` (missing slots get empty
/// SubAnswer; extra slots are dropped). If `declined == true` the outcome
/// is reported as a full decline regardless of `answers` content.
pub fn build_outcome_for_multiple_answers(
    entry: &AskAnswerEntry,
    answers: Vec<SubAnswer>,
    declined: bool,
) -> QuestionOutcome {
    if declined {
        return QuestionOutcome::declined();
    }
    let mut out = Vec::with_capacity(entry.questions.len());
    for (idx, q) in entry.questions.iter().enumerate() {
        let sub = answers.get(idx).cloned().unwrap_or_default();
        out.push(QuestionAnswerPayload {
            question: q.question.clone(),
            header: q.header.clone(),
            selected: sub.selected,
            custom_input: sub.custom_input,
        });
    }
    QuestionOutcome::answer(out)
}

#[cfg(test)]
mod dispatch_tests {
    use super::*;
    use crate::models::config::{Config, DispatchPreset, ModelProfile};

    #[test]
    fn form_answer_sender_roundtrip() {
        // FormAnswerEntry 的 oneshot 传输语义：form_submit 侧注册时取出 sender，
        // send receipt 后，handle_form_frame 挂起的 rx 应能收到同一份回执文本。
        // 这是阻塞回喂闭环的最小可用性验证。
        let (tx, rx) = tokio::sync::oneshot::channel::<String>();
        let entry = FormAnswerEntry { sender: tx };
        let receipt = "用户已提交表单\n执行结果: {\"ok\":true}".to_string();
        let _ = entry.sender.send(receipt.clone());
        let got = rx
            .blocking_recv()
            .expect("oneshot 应收到回执");
        assert_eq!(got, receipt);
    }

    #[test]
    fn dispatch_depth_parsing() {
        assert_eq!(parse_dispatch_depth(""), 0);
        assert_eq!(parse_dispatch_depth("some-session-id"), 0);
        assert_eq!(parse_dispatch_depth("dispatch-1-abc12345"), 1);
        assert_eq!(parse_dispatch_depth("dispatch-2-abc12345"), 2);
        // 格式异常但带 dispatch- 前缀：按 1 层保守处理
        assert_eq!(parse_dispatch_depth("dispatch-x"), 1);
    }

    fn preset(name: &str) -> DispatchPreset {
        DispatchPreset {
            id: format!("id-{}", name),
            name: name.to_string(),
            engine_id: "claude-code".to_string(),
            model_profile_id: None,
            model: Some("haiku".to_string()),
            append_system_prompt: None,
            permission_mode: None,
        }
    }

    fn profile(id: &str, name: &str) -> ModelProfile {
        ModelProfile {
            id: id.to_string(),
            name: name.to_string(),
            model: "m1".to_string(),
            model_options: None,
            ..serde_json::from_value(serde_json::json!({
                "id": "", "name": "", "baseUrl": "https://example.com",
                "apiKey": "sk-test", "model": ""
            }))
            .expect("ModelProfile 反序列化默认值")
        }
    }

    #[test]
    fn preset_resolution_exact_and_case_insensitive() {
        let mut config = Config::default();
        config.dispatch.presets = vec![preset("测试员"), preset("Docs")];

        assert_eq!(resolve_dispatch_preset(&config, "测试员").unwrap().name, "测试员");
        assert_eq!(resolve_dispatch_preset(&config, "docs").unwrap().name, "Docs");

        let err = resolve_dispatch_preset(&config, "不存在").unwrap_err();
        assert!(err.contains("测试员"), "错误信息应列出候选角色: {}", err);
    }

    #[test]
    fn provider_resolution_official_exact_and_ambiguous() {
        let mut config = Config::default();
        config.model_profiles = vec![
            profile("p1", "DeepSeek Pro"),
            profile("p2", "DeepSeek Lite"),
            profile("p3", "Kimi"),
        ];

        assert_eq!(
            resolve_dispatch_provider(&config, "official").unwrap(),
            Some("official".to_string())
        );
        assert_eq!(
            resolve_dispatch_provider(&config, "p1").unwrap(),
            Some("p1".to_string())
        );
        assert_eq!(
            resolve_dispatch_provider(&config, "Kimi").unwrap(),
            Some("p3".to_string())
        );
        // 模糊唯一命中
        assert_eq!(
            resolve_dispatch_provider(&config, "lite").unwrap(),
            Some("p2".to_string())
        );
        // 歧义：列出候选
        let err = resolve_dispatch_provider(&config, "deepseek").unwrap_err();
        assert!(err.contains("DeepSeek Pro") && err.contains("DeepSeek Lite"));
        // 未命中：列出全部可用
        let err = resolve_dispatch_provider(&config, "nope").unwrap_err();
        assert!(err.contains("Kimi"));
    }
}

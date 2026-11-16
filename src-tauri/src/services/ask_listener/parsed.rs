//! ask 帧 questions 解析与 question 事件（K-R3 拆分）

use crate::state::{QuestionItem, QuestionOption, QuestionStatus};

use crate::error::{AppError, Result};
use crate::state::AppState;
use super::emit::wrap_question_route_event;
use serde_json::{json, Value};

/// Parsed `questions[i]` for internal use.
#[derive(Debug, Clone)]
pub struct ParsedQuestion {
    pub question: String,
    pub header: String,
    pub multi_select: bool,
    pub options: Vec<ParsedOption>,
}

#[derive(Debug, Clone)]
pub struct ParsedOption {
    pub label: String,
    pub description: Option<String>,
}

pub fn parsed_to_item(q: &ParsedQuestion) -> QuestionItem {
    QuestionItem {
        question: q.question.clone(),
        header: q.header.clone(),
        multi_select: q.multi_select,
        options: q
            .options
            .iter()
            .map(|o| QuestionOption {
                value: o.label.clone(),
                label: Some(o.label.clone()),
                description: o.description.clone(),
            })
            .collect(),
        allow_custom_input: true,
    }
}

pub fn parse_questions(value: &Value) -> Result<Vec<ParsedQuestion>> {
    let arr = value
        .as_array()
        .ok_or_else(|| AppError::ValidationError("questions 必须是数组".into()))?;
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let question = item
            .get("question")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let header = item
            .get("header")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let multi_select = item
            .get("multiSelect")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let options = item
            .get("options")
            .and_then(Value::as_array)
            .map(|opts| {
                opts.iter()
                    .map(|o| ParsedOption {
                        label: o
                            .get("label")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        description: o
                            .get("description")
                            .and_then(Value::as_str)
                            .map(|s| s.to_string()),
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.push(ParsedQuestion {
            question,
            header,
            multi_select,
            options,
        });
    }
    Ok(out)
}

pub fn emit_question_event(
    state: &AppState,
    session_id: &str,
    call_id: &str,
    questions: &[ParsedQuestion],
) {
    // 单事件携带全部 questions（即使只有 1 题，也走数组形态以统一前端处理）。
    // 顶层仍带摘要字段（第一题的 header / options 等）便于旧消费方兼容。
    let questions_payload: Vec<Value> = questions
        .iter()
        .map(|q| {
            let options: Vec<Value> = q
                .options
                .iter()
                .map(|o| {
                    // 前端 QuestionOption 要求 `value`；用 label 同时作为
                    // 标识符与显示文本。
                    json!({
                        "value": o.label,
                        "label": o.label,
                        "description": o.description,
                    })
                })
                .collect();
            // MCP question 是正文，前端 header 字段承载正文；
            // MCP header 是短标签，映射到 categoryLabel。
            let body = if q.question.is_empty() {
                q.header.clone()
            } else {
                q.question.clone()
            };
            let mut item = json!({
                "question": body,
                "header": q.header,        // 短标签
                "multiSelect": q.multi_select,
                "options": options,
                "allowCustomInput": true,
            });
            if !q.question.is_empty() && !q.header.is_empty() {
                item["categoryLabel"] = Value::String(q.header.clone());
            }
            item
        })
        .collect();

    // 顶层摘要：第一题的字段，便于旧消费方
    let first_body = questions
        .first()
        .map(|q| {
            if q.question.is_empty() {
                q.header.clone()
            } else {
                q.question.clone()
            }
        })
        .unwrap_or_default();
    let first_options = questions
        .first()
        .map(|q| {
            q.options
                .iter()
                .map(|o| {
                    json!({
                        "value": o.label,
                        "label": o.label,
                        "description": o.description,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let first_multi = questions.first().map(|q| q.multi_select).unwrap_or(false);
    let first_category = questions.first().and_then(|q| {
        if !q.question.is_empty() && !q.header.is_empty() {
            Some(q.header.clone())
        } else {
            None
        }
    });

    let mut payload = json!({
        "type": "question",
        "sessionId": session_id,
        "questionId": call_id,
        "questions": questions_payload,
        // 兼容字段：填充第一题
        "header": first_body,
        "options": first_options,
        "multiSelect": first_multi,
        "allowCustomInput": true,
    });
    if let Some(category) = first_category {
        payload["categoryLabel"] = Value::String(category);
    }

    let event = wrap_question_route_event(session_id, payload.clone());

    // Web/WebSocket broadcast — wrap in envelope for event routing.
    // Frontend httpTransport filters messages without "event" field.
    let ws_msg = serde_json::json!({
        "event": "chat-event",
        "payload": event,
    });
    if let Ok(msg) = serde_json::to_string(&ws_msg) {
        let _ = state.event_broadcast.send(msg);
    }

    // Tauri webview emission — only when tauri-app feature is on.
    #[cfg(feature = "tauri-app")]
    if let Some(handle) = state.app_handle.get() {
        use tauri::Emitter;
        if let Err(error) = handle.emit("chat-event", &event) {
            tracing::warn!("[AskListener] emit chat-event 失败: {}", error);
        }
    }
}

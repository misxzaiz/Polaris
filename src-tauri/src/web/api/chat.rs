use axum::extract::{Path, State};
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use std::sync::Arc;

use crate::AppState;
use super::super::error::WebError;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageRequest {
    pub message: String,
    pub session_id: Option<String>,
    pub options: Option<serde_json::Value>,
}

pub async fn handle_send_message(
    State(_state): State<Arc<AppState>>,
    Json(_req): Json<SendMessageRequest>,
) -> Result<impl IntoResponse, WebError> {
    // TODO: route to start_chat_inner or continue_chat_inner based on session_id presence
    Ok(Json(serde_json::json!({ "status": "ok" })))
}

pub async fn handle_interrupt(
    State(_state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, WebError> {
    // TODO: route to interrupt_chat_inner
    Ok(Json(serde_json::json!({ "status": "ok" })))
}

pub async fn handle_get_history(
    State(_state): State<Arc<AppState>>,
    Path(_session_id): Path<String>,
) -> Result<impl IntoResponse, WebError> {
    // TODO: route to get_session_history
    Ok(Json(serde_json::json!([])))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerQuestionRequest {
    pub call_id: String,
    pub selected: Vec<String>,
    pub custom_input: Option<String>,
}

pub async fn handle_answer_question(
    State(_state): State<Arc<AppState>>,
    Json(_req): Json<AnswerQuestionRequest>,
) -> Result<impl IntoResponse, WebError> {
    // TODO: route to answer_question_inner
    Ok(Json(serde_json::json!({ "status": "ok" })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovePlanRequest {
    pub plan_id: String,
    pub feedback: Option<String>,
}

pub async fn handle_approve_plan(
    State(_state): State<Arc<AppState>>,
    Json(_req): Json<ApprovePlanRequest>,
) -> Result<impl IntoResponse, WebError> {
    // TODO: route to approve_plan_inner
    Ok(Json(serde_json::json!({ "status": "ok" })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectPlanRequest {
    pub plan_id: String,
    pub feedback: Option<String>,
}

pub async fn handle_reject_plan(
    State(_state): State<Arc<AppState>>,
    Json(_req): Json<RejectPlanRequest>,
) -> Result<impl IntoResponse, WebError> {
    // TODO: route to reject_plan_inner
    Ok(Json(serde_json::json!({ "status": "ok" })))
}

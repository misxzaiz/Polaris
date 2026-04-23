use axum::extract::{Path, State};
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use std::sync::Arc;

use crate::AppState;
use super::super::error::WebError;

pub async fn handle_list_sessions(
    State(_state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, WebError> {
    // TODO: route to list_sessions
    Ok(Json(serde_json::json!([])))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionRequest {
    pub name: Option<String>,
}

pub async fn handle_create_session(
    State(_state): State<Arc<AppState>>,
    Json(_req): Json<CreateSessionRequest>,
) -> Result<impl IntoResponse, WebError> {
    // TODO: route to create_session_inner
    Ok(Json(serde_json::json!({ "status": "ok" })))
}

pub async fn handle_delete_session(
    State(_state): State<Arc<AppState>>,
    Path(_session_id): Path<String>,
) -> Result<impl IntoResponse, WebError> {
    // TODO: route to delete_session_inner
    Ok(Json(serde_json::json!({ "status": "ok" })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchSessionRequest {
    pub name: Option<String>,
    pub active: Option<bool>,
}

pub async fn handle_patch_session(
    State(_state): State<Arc<AppState>>,
    Path(_session_id): Path<String>,
    Json(_req): Json<PatchSessionRequest>,
) -> Result<impl IntoResponse, WebError> {
    // TODO: route to rename/switch session
    Ok(Json(serde_json::json!({ "status": "ok" })))
}

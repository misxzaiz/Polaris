//! 文件预览静态服务路由 `GET /api/files/*`
//!
//! 用途：Web 模式（非 Tauri 桌面）下，`<img>` / `<video>` 无法走 Tauri 的
//! `asset://` 本地协议，需要后端把磁盘文件以 HTTP 方式暴露给前端预览。
//!
//! 安全模型：
//! - 鉴权与其它 `/api/*` 一致（`Authorization: Bearer <md5(token)>`）
//! - `<img>` / `<video>` 的 `src` 无法携带自定义 header，故额外支持
//!   `?token=<md5(token)>` query 回退（与 `cap.http` 的 token query 同思路）
//! - 路径规范化 + `..` 穿越防护，仅允许访问绝对路径文件，不限定根（预览
//!   的文件本就是用户在文件树里点开的、已授权的路径）
//! - 仅服务存在的**文件**，目录 / 不存在路径返回 404
//! - 通过 tower-http `ServeFile` 输出，天然支持 `Range`（视频拖动进度）

use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, Query, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use tower::ServiceExt;
use tower_http::services::ServeFile;

use crate::AppState;

/// `GET /api/files/<absolute-path>` —— 以 HTTP 流式输出磁盘文件。
///
/// 支持：
/// - Range 请求（视频拖动 / 大图渐进加载，由 ServeFile 内部处理）
/// - `?token=<md5>` query 鉴权回退（`<img>`/`<video>` src 无法带 header）
/// - 仅服务文件，目录 / 穿越路径一律 404
///
/// 路由形如 `/api/files/{*path}`，axum 会把 wildcard 解码成完整剩余路径
/// （如 `C:/Users/me/pic.png`）。
pub async fn handle_file_request(
    State(state): State<Arc<AppState>>,
    Path(raw_path): Path<String>,
    Query(query): Query<FileQuery>,
    req: Request<Body>,
) -> Response {
    // 1. 鉴权：header Bearer 优先，回退 query token
    if !authorized(&state, &req, query.token.as_deref()) {
        return (
            StatusCode::UNAUTHORIZED,
            axum::Json(serde_json::json!({ "error": "Unauthorized" })),
        )
            .into_response();
    }

    // 2. 路径规范化 + 穿越防护
    let Some(path) = normalize_path(&raw_path) else {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({ "error": "Invalid path" })),
        )
            .into_response();
    };

    // 3. 校验为存在的文件（目录 / 不存在 → 404）
    match std::fs::metadata(&path) {
        Ok(md) if md.is_file() => {}
        _ => {
            return (
                StatusCode::NOT_FOUND,
                axum::Json(serde_json::json!({ "error": "File not found" })),
            )
                .into_response();
        }
    }

    // 4. ServeFile 输出（处理 Range、Content-Type、Last-Modified）
    match ServeFile::new(&path).oneshot(req).await {
        Ok(res) => res.into_response(),
        Err(e) => {
            tracing::warn!("[Web][files] serve failed: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(serde_json::json!({ "error": "Serve failed" })),
            )
                .into_response()
        }
    }
}

/// Query 参数（仅支持 `token`）
#[derive(serde::Deserialize)]
pub struct FileQuery {
    /// `<img>`/`<video>` 无法带 header 时的鉴权回退：`md5(明文 token)`
    token: Option<String>,
}

/// 鉴权：接受 `Authorization: Bearer <md5(token)>` 或 `?token=<md5(token)>`。
/// token 未设置（None/空）时视为开放，与其它 /api/* 路由一致。
fn authorized(state: &Arc<AppState>, req: &Request<Body>, query_token: Option<&str>) -> bool {
    let raw_token = match state.clone_config_web().map(|c| c.web.token) {
        Ok(Some(t)) if !t.is_empty() => t,
        _ => return true, // 未设置 token → 开放
    };
    let expected = format!("{:x}", md5::compute(raw_token.as_bytes()));

    let header_token = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());

    let provided = header_token.or(query_token);
    provided.is_some_and(|t| subtle::ConstantTimeEq::ct_eq(t.as_bytes(), expected.as_bytes()).into())
}

/// 规范化路径并拒绝穿越。入参是 URI path segment（URL 解码过，但路径分隔符
/// 已被 axum 按 `/` 拆段拼接，`..` 以字面段存在）。这里做两道防线：
/// 1. 拒绝含 `..` 的段（防穿越）
/// 2. 规范化（`//` 等），并最终校验时确保是文件
fn normalize_path(raw: &str) -> Option<PathBuf> {
    // 去除可能的 query/fragment（axum 的 uri.path() 已不含 query，双保险）
    let raw = raw.split(['?', '#']).next().unwrap_or(raw);
    // 以 PATH_SEPARATOR 重解析；Windows 上用反斜杠分隔绝对路径
    let path_str = raw.replace('/', std::path::MAIN_SEPARATOR_STR);

    for seg in path_str.split(std::path::MAIN_SEPARATOR) {
        if seg == ".." || seg.contains('\\') || seg.contains('/') {
            return None;
        }
    }

    let pb = PathBuf::from(path_str);
    if !pb.is_absolute() {
        return None;
    }
    Some(pb)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_rejects_traversal() {
        assert!(normalize_path("C:/Users/me/../../etc/passwd").is_none());
        assert!(normalize_path("C:/../windows").is_none());
        assert!(normalize_path("C:/Users/me/a/../b.txt").is_none());
        assert!(normalize_path("relative/path").is_none());
    }

    #[test]
    fn normalize_accepts_absolute() {
        let p = normalize_path("C:/Users/me/x.png").expect("绝对路径应接受");
        assert!(p.is_absolute());
        assert_eq!(p, PathBuf::from(r"C:\Users\me\x.png"));
    }

    #[test]
    fn normalize_strips_query() {
        let p = normalize_path("C:/a/b.png?token=abc").expect("query 应被剥离");
        assert_eq!(p, PathBuf::from(r"C:\a\b.png"));
    }
}
//! 文件预览静态服务路由 `GET /api/files/*`
//!
//! 用途：Web 模式（非 Tauri 桌面）下，`<img>` / `<video>` 无法走 Tauri 的
//! `asset://` 本地协议，需要后端把磁盘文件以 HTTP 方式暴露给前端预览。
//!
//! 安全模型（P0 安全部署闸，plans/p0-web-security-gate-spec.md §4）：
//! - 鉴权与其它 `/api/*` 一致（`Authorization: Bearer <md5(token)>`）
//! - `<img>` / `<video>` 的 `src` 无法携带自定义 header，故额外支持
//!   `?token=<md5(token)>` query 回退（与 `cap.http` 的 token query 同思路）
//! - 路径规范化 + `..` 穿越防护（第一道）
//! - **根白名单（第二道）**：仅允许数据根（`data_root()`，会话附件/语音/插件
//!   资源）与已注册工作区（`config.workspaces[].path`，文件浏览器预览来源）
//!   子树内的文件；白名单外一律 403——历史上"全盘任意绝对路径可读"
//!   （持凭据=全盘读，凭据可走 URL query）是分析报告定性的高危缺口
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

    // 4. 根白名单（spec §4 第二道防线）：规范化两侧后前缀匹配。
    //    canonicalize 同时消解 Windows 大小写与符号链接歧义；文件已存在（上一步
    //    metadata 校验通过），canonicalize 失败按 404 处理。
    let canonical = match std::fs::canonicalize(&path) {
        Ok(p) => p,
        Err(_) => {
            return (
                StatusCode::NOT_FOUND,
                axum::Json(serde_json::json!({ "error": "File not found" })),
            )
                .into_response();
        }
    };
    if !is_path_allowed(&canonical, &collect_allowed_roots(&state)) {
        tracing::warn!("[Web][files] 路径不在白名单内，拒绝预览: {:?}", canonical);
        return (
            StatusCode::FORBIDDEN,
            axum::Json(serde_json::json!({ "error": "Path outside allowed roots" })),
        )
            .into_response();
    }

    // 5. ServeFile 输出（处理 Range、Content-Type、Last-Modified）
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

/// 收集根白名单（spec §4）：数据根 ∪ 已注册工作区根。
///
/// 所有根与请求路径同样 canonicalize 后再做前缀匹配——Windows 上
/// canonicalize 会产生 `\\?\` 扩展前缀形态，两侧形态不一致会让 starts_with
/// 永远为 false（smoke test 实测踩中）。不可访问的根跳过并记 debug 日志。
fn collect_allowed_roots(state: &Arc<AppState>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let data_root = crate::services::data_root::data_root().root().to_path_buf();
    match std::fs::canonicalize(&data_root) {
        Ok(c) => roots.push(c),
        // 兜底：数据根不可规范化时保留原路径（后续由存在性校验兜住）
        Err(_) => roots.push(data_root),
    }
    if let Ok(config) = state.clone_config_web() {
        for ws in &config.workspaces {
            match std::fs::canonicalize(&ws.path) {
                Ok(root) => roots.push(root),
                Err(_) => {
                    tracing::debug!(
                        "[Web][files] 工作区根不可规范化，跳过白名单项: {:?}",
                        ws.path
                    );
                }
            }
        }
    }
    roots
}

/// 白名单判定：规范化后的文件路径落在任一允许根子树内。
fn is_path_allowed(file: &std::path::Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| file.starts_with(root))
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

    #[test]
    fn whitelist_allows_subtree_and_rejects_outside() {
        let root = std::env::temp_dir().join("polaris-files-whitelist-test");
        let inside_dir = root.join("sub");
        std::fs::create_dir_all(&inside_dir).expect("创建测试目录");
        let inside = inside_dir.join("a.png");
        std::fs::write(&inside, b"x").expect("写测试文件");
        let inside_canon = std::fs::canonicalize(&inside).expect("规范化");
        let root_canon = std::fs::canonicalize(&root).expect("规范化根");

        // 白名单子树内 → 允许
        assert!(is_path_allowed(&inside_canon, &[root_canon.clone()]));
        // 白名单外的兄弟路径 → 拒绝
        let outside = std::env::temp_dir().canonicalize().expect("temp 存在");
        let outside_file = outside.join("polaris-files-whitelist-definitely-outside.png");
        assert!(
            !is_path_allowed(&outside_file, &[root_canon.clone()]),
            "白名单根之外应拒绝"
        );
        // 空白名单 → 全拒绝
        assert!(!is_path_allowed(&inside_canon, &[]));
        // 前缀陷阱:同前缀不同目录名不算子树(roots 含 root,文件在 root2 下)
        let sibling = root_canon.parent().map(|p| p.join("polaris-files-whitelist-test-other"));
        if let Some(sibling) = sibling {
            assert!(!is_path_allowed(&sibling.join("x.png"), &[root_canon.clone()]));
        }

        let _ = std::fs::remove_dir_all(&root);
    }
}
// Route definitions for Web Access Layer
// TODO: implement all routes

use axum::Router;
use std::sync::Arc;

use crate::AppState;

pub fn create_router(_state: Arc<AppState>) -> Router {
    Router::new()
        // TODO: add API routes
    }

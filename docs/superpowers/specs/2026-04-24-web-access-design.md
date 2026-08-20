# Polaris Web Access Layer — Design Spec

> Date: 2026-04-24
> Status: Draft
> Scope: MVP (Minimum Viable)

## 1. Goal

Enable LAN browser access to a running Polaris desktop instance. The desktop app runs normally; the web server is an additional entry point sharing the same process and state.

### MVP Feature Scope

- AI chat (with streaming output via WebSocket)
- Session management (list, create, delete, switch)
- Settings read/write
- Simple token-based authentication

### Out of Scope (Future)

- File explorer, Git panel, Terminal
- Multi-user / role-based access
- HTTPS / TLS
- Remote server deployment (separate process mode)

## 2. Architecture

```
┌─────────────────────────────────────────────────┐
│            Polaris Desktop (Tauri Process)        │
│                                                   │
│  ┌──────────────┐         ┌────────────────────┐  │
│  │  Tauri IPC   │         │  axum HTTP/WS      │  │
│  │  (webview)   │         │  (0.0.0.0:9800)    │  │
│  └──────┬───────┘         └─────────┬──────────┘  │
│         │                           │              │
│         └──────────┬────────────────┘              │
│                    ▼                               │
│          ┌─────────────────┐                       │
│          │   EventEmitter  │  (trait abstraction)  │
│          │  trait          │                       │
│          └────────┬────────┘                       │
│                   ▼                                │
│          ┌─────────────────┐                       │
│          │   AppState      │  (shared state)       │
│          └────────┬────────┘                       │
│                   ▼                                │
│          ┌─────────────────┐                       │
│          │  Business Logic │  (existing services)  │
│          └─────────────────┘                       │
└───────────────────────────────────────────────────┘
       │                         │
   Tauri Webview           LAN Browser
   (desktop)               (web access)
```

**Key principle**: Zero duplication of business logic. Both transport layers call the same `*_inner()` functions, differing only in how they receive requests and emit events.

## 3. Backend Changes (Rust)

### 3.1 New Dependencies (`src-tauri/Cargo.toml`)

```toml
[dependencies]
axum = { version = "0.8", features = ["ws"] }
tower = "0.5"
tower-http = { version = "0.6", features = ["cors", "fs"] }
tokio = { version = "1", features = ["full"] }  # already present
tokio-util = "0.7"  # CancellationToken for graceful shutdown
```

`AppState` 新增字段（`src-tauri/src/state.rs`）:

```rust
pub struct AppState {
    // ... existing fields ...
    pub event_broadcast: tokio::sync::broadcast::Sender<String>,  // WebSocket fan-out channel
}
```

`event_broadcast` 在 `AppState::new()` 时创建（`broadcast::channel(256)`），`WsEmitter` 通过它向所有 WS 客户端广播事件。

### 3.2 New Module: `src-tauri/src/web/`

```
web/
├── mod.rs              # Module declaration
├── server.rs           # WebServer struct, start/stop lifecycle
├── router.rs           # All route definitions
├── auth.rs             # Token generation, validation, middleware
├── extractors.rs       # Shared state extractor, request types
├── error.rs            # WebError → JSON error responses
├── api/
│   ├── mod.rs
│   ├── chat.rs         # POST /api/chat/send, /interrupt, /answer-question, /approve-plan
│   ├── session.rs      # GET/POST/DELETE/PATCH /api/sessions
│   ├── settings.rs     # GET/PATCH /api/settings
│   └── ws.rs           # WS /api/ws — event stream proxy
└── emitter.rs          # EventEmitter trait + TauriEmitter + WsEmitter
```

### 3.3 EventEmitter Trait

The core abstraction enabling shared business logic:

```rust
// web/emitter.rs
use async_trait::async_trait;

#[async_trait]
pub trait EventEmitter: Send + Sync {
    async fn emit(&self, context_id: &str, event_type: &str, payload: &str) -> Result<(), String>;
}

// Wraps Tauri AppHandle.emit() — app-wide event broadcast to webview
pub struct TauriEmitter {
    app: tauri::AppHandle,
}

// Wraps tokio::sync::broadcast::Sender for WebSocket fan-out
pub struct WsEmitter<'a> {
    tx: &'a broadcast::Sender<String>,
}

/// CompositeEmitter fires both channels simultaneously — ensures desktop-initiated
/// chats also reach WS clients, and web-initiated chats also reach the webview.
pub struct CompositeEmitter<'a> {
    tauri: &'a TauriEmitter,
    ws: &'a WsEmitter<'a>,
}
```

### 3.4 Business Logic Extraction Pattern

Before (command-coupled):
```rust
#[tauri::command]
pub async fn start_chat(message: String, state: State<'_, AppState>, window: Window) -> Result<...> {
    // 50 lines of business logic + window.emit("chat-event", ...)
}
```

After (shared logic):
```rust
// New: shared inner function
pub async fn start_chat_inner(
    message: String,
    options: ChatOptions,
    state: &AppState,
    emitter: &dyn EventEmitter,
) -> Result<StartChatResponse, AppError> {
    // Same 50 lines, but emitter.emit(...) instead of window.emit(...)
}

// Tauri command — thin wrapper, uses CompositeEmitter so web clients also see events
#[tauri::command]
pub async fn start_chat(message: String, options: ChatOptions, state: State<'_, AppState>, window: Window) -> Result<...> {
    let tauri_emitter = TauriEmitter::new(window.app_handle().clone());
    let ws_emitter = WsEmitter::new(&state.event_broadcast);
    let emitter = CompositeEmitter::new(&tauri_emitter, &ws_emitter);
    start_chat_inner(message, options, &state, &emitter).await
}

// HTTP handler — thin wrapper, same CompositeEmitter
pub async fn handle_start_chat(
    State(state): State<Arc<AppState>>,
    Json(req): Json<StartChatRequest>,
    app: tauri::AppHandle,  // injected via axum state
) -> Result<Json<StartChatResponse>, WebError> {
    let tauri_emitter = TauriEmitter::new(app);
    let ws_emitter = WsEmitter::new(&state.event_broadcast);
    let emitter = CompositeEmitter::new(&tauri_emitter, &ws_emitter);
    start_chat_inner(req.message, req.options, &state, &emitter).await
}
```

**关键决策**：所有 `*_inner()` 函数通过 `CompositeEmitter` 同时向 Tauri webview 和 WS 客户端广播事件。无论请求来自桌面端还是 Web 端，两端都能看到完整的流式输出。
```

**Commands to refactor** (MVP only):

| Command | Inner Function |
|---------|---------------|
| `start_chat` | `start_chat_inner` |
| `continue_chat` | `continue_chat_inner` |
| `interrupt_chat` | `interrupt_chat_inner` |
| `get_session_history` | (no emit, direct state read) |
| `answer_question` | `answer_question_inner` |
| `approve_plan` / `reject_plan` | `*_inner` |
| `list_sessions` | (no emit, direct state read) |
| `create_session` / `delete_session` | `*_inner` |
| `get_config` / `update_config` | (no emit, direct state read) |

### 3.5 WebSocket Event Distribution

```rust
// web/api/ws.rs
// Each WS client gets a broadcast::Receiver
// Server maintains a broadcast::Sender alongside Tauri's event system
// When business logic calls emitter.emit(), WsEmitter broadcasts to all WS clients

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws(socket, state))
}

async fn handle_ws(mut socket: WebSocket, state: Arc<AppState>) {
    let mut rx = state.event_broadcast.subscribe();
    loop {
        tokio::select! {
            msg = socket.recv() => { /* handle ping/close */ }
            event = rx.recv() => {
                socket.send(Message::Text(event)).await;
            }
        }
    }
}
```

**Dual emission via CompositeEmitter**: Every `*_inner()` call uses `CompositeEmitter` which fires both `TauriEmitter` (→ `app_handle.emit()` → webview) and `WsEmitter` (→ `broadcast::Sender` → all WS clients). Regardless of which transport originated the request, both desktop and web see all events.

### 3.6 Server Lifecycle

```rust
// web/server.rs
pub struct WebServer {
    state: Arc<AppState>,
    shutdown: CancellationToken,
}

impl WebServer {
    pub async fn start(self, addr: &str) -> Result<()> {
        let app = Router::new()
            .nest("/api", api_routes())
            .fallback(static_files_or_proxy())
            .layer(middleware::from_fn(auth_middleware))
            .with_state(self.state);

        let listener = TcpListener::bind(addr).await?;
        axum::serve(listener, app)
            .with_graceful_shutdown(self.shutdown.cancelled())
            .await?;
        Ok(())
    }
}
```

Integration in `lib.rs::setup()`:
```rust
// After AppState initialization, before window creation
let web_server = WebServer::new(app_state_clone, cancel_token);
tauri::async_runtime::spawn(async move {
    if let Err(e) = web_server.start("0.0.0.0:9800").await {
        eprintln!("Web server error: {}", e);
    }
});
```

Port is configurable via `polaris.conf` or environment variable `POLARIS_WEB_PORT`.

### 3.7 Static File Serving

```rust
fn static_files_or_proxy() -> impl IntoResponse {
    // Development: proxy to vite dev server at localhost:1420
    // Production: ServeDir("dist") with SPA fallback — all non-/api, non-asset paths
    // serve index.html for client-side routing
    ServeDir::new("../dist")
        .not_found_service(
            ServeFile::new("../dist/index.html")  // SPA fallback
        )
}
```

## 4. Frontend Changes (TypeScript)

### 4.1 Transport Abstraction Layer

New directory: `src/services/transport/`

```ts
// transport/types.ts
export interface TransportAdapter {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void>;
}

// transport/detector.ts
export function detectTransport(): 'tauri' | 'http' {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
    ? 'tauri'
    : 'http';
}
```

### 4.2 Tauri Transport (existing, wrapped)

```ts
// transport/tauriTransport.ts
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { TransportAdapter } from './types';

export const tauriTransport: TransportAdapter = {
  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    return invoke<T>(command, args);
  },
  async listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
    const unlisten = await listen<T>(event, (e) => handler(e.payload));
    return unlisten;
  },
};
```

### 4.3 HTTP Transport (new)

```ts
// transport/httpTransport.ts
import type { TransportAdapter } from './types';

export function createHttpTransport(baseUrl: string, token: string): TransportAdapter {
  const wsUrl = baseUrl.replace(/^http/, 'ws');
  let ws: WebSocket | null = null;
  const listeners = new Map<string, Set<(payload: unknown) => void>>();

  return {
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      const res = await fetch(`${baseUrl}/api/${command.replace(/_/g, '-')}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(args ?? {}),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error(err.message || `API error: ${res.status}`);
      }
      return res.json() as Promise<T>;
    },

    async listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
      // Lazy-init WebSocket on first listen call
      if (!ws) {
        ws = new WebSocket(`${wsUrl}/api/ws?token=${token}`);
        ws.onmessage = (msg) => {
          const { event: evtType, payload } = JSON.parse(msg.data);
          listeners.get(evtType)?.forEach(cb => cb(payload));
        };
      }
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler as (p: unknown) => void);

      // Return unsubscribe function
      return () => {
        listeners.get(event)?.delete(handler as (p: unknown) => void);
      };
    },
  };
}
```

### 4.4 Service Layer Integration

Minimal change — service files import from transport instead of `@tauri-apps/api` directly:

```ts
// src/services/tauri/index.ts — modified
import { detectTransport } from '../transport/detector';
import { tauriTransport } from '../transport/tauriTransport';
import { createHttpTransport } from '../transport/httpTransport';

const transport = detectTransport() === 'tauri'
  ? tauriTransport
  : createHttpTransport(
      localStorage.getItem('polaris_server_url') || window.location.origin,
      localStorage.getItem('polaris_token') || '',
    );

// Replace direct invoke/listen exports with transport methods
export const invoke = <T>(cmd: string, args?: Record<string, unknown>) => transport.invoke<T>(cmd, args);
export const listen = <T>(event: string, handler: (p: T) => void) => transport.listen<T>(event, handler);
```

**Impact**: All existing service files (`chatService.ts`, `configService.ts`, etc.) remain unchanged. Only `index.ts` changes the source of `invoke` and `listen`.

### 4.5 Token Management (Web Mode)

```ts
// src/services/transport/auth.ts
export function getTokenFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get('token');
}

export function initWebAuth(): void {
  const urlToken = getTokenFromUrl();
  if (urlToken) {
    localStorage.setItem('polaris_token', urlToken);
    // Clean URL to avoid token leakage in address bar
    window.history.replaceState({}, '', window.location.pathname);
  }
}
```

App entry point (`src/main.tsx`) adds before React render:
```ts
if (detectTransport() === 'http') {
  initWebAuth();
  const token = localStorage.getItem('polaris_token');
  if (!token) {
    // Show token input page
    renderTokenPage();
    return;
  }
}
```

## 5. Authentication

### 5.1 Token Lifecycle

1. **Generation**: On first web server start, generate 32-byte random hex token
2. **Storage**: Persist to `{appDataDir}/.polaris/web-token.json`
3. **Distribution**: Desktop settings page displays token + QR code (`http://{localIP}:9800?token={token}`)
4. **Validation**: axum middleware checks `Authorization: Bearer {token}` header or `?token=` query param
5. **WebSocket auth**: Token passed in query param on WS upgrade request

### 5.2 Auth Middleware

```rust
// web/auth.rs
pub async fn auth_middleware(
    req: Request,
    next: Next,
    State(config): State<Arc<WebConfig>>,
) -> Result<Response, WebError> {
    // Skip auth paths
    let path = req.uri().path();
    let method = req.method();
    // Static files (SPA): skip all GET that don't start with /api
    if method == Method::GET && !path.starts_with("/api") { return Ok(next.run(req).await); }
    // Token verification endpoint
    if path == "/api/auth/verify" { return Ok(next.run(req).await); }
    // Token exchange endpoint
    if path == "/api/auth/token" && method == Method::POST { return Ok(next.run(req).await); }

    let token = extract_token(&req)?;
    // if token != config.web_token {
    //     return Err(WebError::Unauthorized);
    // }
    Ok(next.run(req).await)
}
```

### 5.3 Token API

```
POST /api/auth/token
  Body: { "token": "existing-token" }  // provide existing to get current
  Response: { "token": "abc123...", "valid": true }

GET /api/auth/verify
  Header: Authorization: Bearer abc123...
  Response: { "valid": true }
```

## 6. API Reference

### Chat

| Method | Path | Tauri Command | Description |
|--------|------|---------------|-------------|
| POST | `/api/chat/send` | `start_chat` or `continue_chat` | Send message. If `sessionId` present → `continue_chat`, else → `start_chat`. Response via WS. |
| POST | `/api/chat/interrupt` | `interrupt_chat` | Interrupt current response |
| GET | `/api/chat/history/:sessionId` | `get_session_history` | Get session message history |
| POST | `/api/chat/answer-question` | `answer_question` | Answer AI question |
| POST | `/api/chat/approve-plan` | `approve_plan` | Approve pending plan |
| POST | `/api/chat/reject-plan` | `reject_plan` | Reject pending plan |

### Sessions

| Method | Path | Tauri Command | Description |
|--------|------|---------------|-------------|
| GET | `/api/sessions` | `list_sessions` | List all sessions |
| POST | `/api/sessions` | `create_session` | Create new session |
| DELETE | `/api/sessions/:id` | `delete_session` | Delete session |
| PATCH | `/api/sessions/:id` | — | Rename/switch session |

### Settings

| Method | Path | Tauri Command | Description |
|--------|------|---------------|-------------|
| GET | `/api/settings` | `get_config` | Read configuration |
| PATCH | `/api/settings` | `update_config` | Update configuration |

### Auth

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/token` | Get/validate token |
| GET | `/api/auth/verify` | Verify token validity |

### WebSocket

| Path | Description |
|------|-------------|
| `WS /api/ws` | Bidirectional event stream |

**WS Message Format** (server → client):
```json
{
  "event": "chat-event",
  "payload": {
    "contextId": "session-abc123",
    "payload": { "type": "Token", "content": "Hello" }
  }
}
```

**WS Message Format** (client → server):
```json
{ "type": "ping" }
{ "type": "subscribe", "events": ["chat-event"] }
```

## 7. Configuration

New config fields in `polaris.conf`:

```json
{
  "web": {
    "enabled": true,
    "host": "0.0.0.0",
    "port": 9800,
    "token": null
  }
}
```

- `token: null` → auto-generate on first start
- `token: "custom"` → use custom token
- `enabled: false` → disable web server entirely

## 8. File Change Summary

### New Files (Rust — ~15 files)

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `src-tauri/src/web/mod.rs` | Module declaration | 20 |
| `src-tauri/src/web/server.rs` | Server lifecycle | 80 |
| `src-tauri/src/web/router.rs` | Route definitions | 60 |
| `src-tauri/src/web/auth.rs` | Token + middleware | 100 |
| `src-tauri/src/web/extractors.rs` | Custom extractors | 40 |
| `src-tauri/src/web/error.rs` | Error types | 50 |
| `src-tauri/src/web/emitter.rs` | EventEmitter trait | 60 |
| `src-tauri/src/web/api/mod.rs` | API module | 10 |
| `src-tauri/src/web/api/chat.rs` | Chat API handlers | 150 |
| `src-tauri/src/web/api/session.rs` | Session API handlers | 80 |
| `src-tauri/src/web/api/settings.rs` | Settings API handlers | 60 |
| `src-tauri/src/web/api/ws.rs` | WebSocket handler | 120 |

### New Files (TypeScript — ~6 files)

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `src/services/transport/types.ts` | TransportAdapter interface | 15 |
| `src/services/transport/detector.ts` | Environment detection | 10 |
| `src/services/transport/tauriTransport.ts` | Tauri transport | 20 |
| `src/services/transport/httpTransport.ts` | HTTP + WS transport | 80 |
| `src/services/transport/auth.ts` | Token management | 30 |
| `src/services/transport/index.ts` | Barrel export | 10 |

### Modified Files

| File | Change |
|------|--------|
| `src-tauri/Cargo.toml` | Add axum, tower-http deps |
| `src-tauri/src/lib.rs` | Register web module, spawn server |
| `src-tauri/src/commands/chat.rs` | Extract `start_chat_inner`, `continue_chat_inner`, `interrupt_chat_inner` |
| `src-tauri/src/commands/workspace.rs` | Extract session list/create/delete inner functions |
| `src/services/tauri/index.ts` | Route invoke/listen through transport adapter |
| `src/main.tsx` | Add web auth init for HTTP mode |

### Estimated Total

- ~850 lines new Rust
- ~165 lines new TypeScript
- ~50 lines modified across existing files

## 9. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| AppState Mutex contention between Tauri and axum | High | Use existing `AsyncMutex` pattern; chat commands already async-safe |
| WS client receives events for all sessions | Medium | Filter by `contextId` client-side (same as EventRouter does now) |
| Large chat history JSON serialization blocks event loop | Low | Use `tokio::task::spawn_blocking` for heavy serialization |
| Token file readable by other users on shared machine | Low | Set file permissions 0600; acceptable for LAN-only MVP |
| CORS needed for development (Vite dev → axum) | Low | tower-http CORS layer with permissive defaults in dev mode |

## 10. Future Extensions (Post-MVP)

1. **Terminal streaming** — add `terminal:output` events to WS
2. **File explorer** — expose file read/write/list APIs
3. **Git operations** — expose git command APIs
4. **File watcher** — push `file-system-change` events via WS
5. **Multi-user** — user accounts, session isolation, permission scoping
6. **TLS** — add rustls-based HTTPS support
7. **Separate process mode** — extract web server into standalone binary for remote deployment
8. **Mobile-responsive UI** — responsive layout for phone/tablet browsers

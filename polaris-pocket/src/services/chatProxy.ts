/**
 * chatProxy — AI 聊天 HTTP 代理层
 *
 * 在 Android 上，WebView 的 `fetch()` 受 CORS 限制，导致 API 请求失败（"Failed to fetch"）。
 * 本模块检测是否运行在 Tauri 环境中，是则通过 Rust 后端 HTTP 代理绕开 CORS，
 * 否则回退到浏览器直接 `fetch()`（开发环境）。
 *
 * 使用方式：
 * ```ts
 * import { proxyFetch } from './chatProxy';
 * const res = await proxyFetch(url, options);
 * ```
 */

let isTauri: boolean | null = null;

/** 检测是否运行在 Tauri（Android APK）环境中 */
async function detectTauri(): Promise<boolean> {
  if (isTauri !== null) return isTauri;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    // 尝试调用一个轻量命令验证 Tauri 桥是否可用
    await invoke("get_device_info_probe");
    isTauri = true;
  } catch {
    isTauri = false;
  }
  return isTauri;
}

// ============================================================================
// 非流式代理
// ============================================================================

export interface ProxyFetchResult {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/**
 * 跨平台 fetch 代理。
 * - Tauri 环境：通过 Rust 后端 `pocket_chat_completions` 命令发起 HTTP 请求
 * - 浏览器环境：直接使用 `fetch()`
 */
export async function proxyFetch(
  url: string,
  options: RequestInit & { body?: string }
): Promise<ProxyFetchResult> {
  const isTauriEnv = await detectTauri();

  if (!isTauriEnv) {
    // 浏览器开发环境：直接 fetch
    const res = await fetch(url, options);
    const bodyText = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      json: async () => JSON.parse(bodyText),
      text: async () => bodyText,
    };
  }

  // Tauri 环境：通过 Rust 后端代理
  const { invoke } = await import("@tauri-apps/api/core");
  const body = JSON.parse(options.body || "{}");

  const result = await invoke<{ status: number; body: unknown; error?: string }>(
    "pocket_chat_completions",
    {
      req: {
        url,
        apiKey: extractApiKey(options.headers),
        body,
      },
    }
  );

  if (result.error) {
    throw new Error(result.error);
  }

  const bodyStr = JSON.stringify(result.body);
  return {
    ok: result.status >= 200 && result.status < 300,
    status: result.status,
    json: async () => result.body,
    text: async () => bodyStr,
  };
}

function extractApiKey(headers?: HeadersInit | Record<string, string>): string {
  if (!headers) return "";
  const h = headers as Record<string, string>;
  const auth = h["Authorization"] || h["authorization"] || "";
  return auth.replace(/^Bearer\s+/i, "");
}

// ============================================================================
// 流式代理（通过 Tauri 事件）
// ============================================================================

export type StreamChunkHandler = (chunk: string, done: boolean, error?: string) => void;

/**
 * 跨平台流式 SSE 请求。
 * - Tauri 环境：通过 `pocket_chat_completions_stream` 命令 + 事件监听
 * - 浏览器环境：直接使用 `fetch()` + 流式读取
 *
 * 返回取消函数。
 */
export async function proxyStreamFetch(
  url: string,
  options: RequestInit & { body?: string },
  onChunk: StreamChunkHandler
): Promise<() => void> {
  const isTauriEnv = await detectTauri();

  if (!isTauriEnv) {
    // 浏览器环境：直接 SSE 流式读取
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch(url, { ...options, signal: ctrl.signal });
        if (!res.ok) {
          onChunk("", true, `HTTP ${res.status}`);
          return;
        }
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            if (ctrl.signal.aborted) break;
            const { done, value } = await reader.read();
            if (done) break;
            onChunk(decoder.decode(value, { stream: true }), false);
          }
        } finally {
          reader.releaseLock();
        }
        onChunk("", true);
      } catch (e: unknown) {
        if ((e as Error).name === "AbortError") {
          onChunk("", true);
          return;
        }
        onChunk("", true, (e as Error).message);
      }
    })();
    return () => ctrl.abort();
  }

  // Tauri 环境：通过 Rust 后端流式代理
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const body = JSON.parse(options.body || "{}");

  // 监听流式事件
  const unlisten = await listen<{ chunk: string; isDone: boolean; error?: string }>(
    "pocket-stream-chunk",
    (event: { payload: { chunk: string; isDone: boolean; error?: string } }) => {
      const { chunk, isDone, error } = event.payload;
      onChunk(chunk, isDone, error);
      if (isDone) {
        unlisten();
      }
    }
  );

  // 启动后端流式请求（不阻塞）
  invoke("pocket_chat_completions_stream", {
    req: {
      url,
      apiKey: extractApiKey(options.headers),
      body,
    },
  }).catch((err: unknown) => {
    unlisten();
    onChunk("", true, String(err));
  });

  return () => {
    unlisten();
  };
}
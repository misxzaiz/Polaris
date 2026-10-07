/**
 * cap.ai.chat — AI 对话能力(流式 + 工具调用)
 *
 * 设计:
 * - 流式: dispatch_stream 立即返回 streamId, 事件流经 EventBus
 *   stream.chunk { stream_id, chunk: text }
 *   stream.end   { stream_id, ok, error? }
 *   stream.tool  { stream_id, name, args }   — AI 发起工具调用
 *   stream.toolResult { stream_id, name, result } — 工具返回
 * - 工具: 所有注册的 cap 自动暴露为 AI 工具(让 AI 能操作全部能力)
 *   工具调用循环: AI 请求工具 → Router.dispatch 执行 → 结果回填 → 继续生成
 * - 协议: OpenAI 兼容(/v1/chat/completions, stream=true), 用户自带 baseUrl+apiKey
 *
 * 工具 schema 来源: cap.inputSchema + cap.id 作为工具名
 */

import type {
  Capability, CallContext, StreamingCapability, Value,
} from '../contracts.ts';
import type { Router } from '../server/router.ts';
import { readConfigRaw } from './config.ts';

interface AiParams {
  messages: Array<{ role: string; content: string }>;
  sessionId?: string;
  /** 限制可用工具 cap 列表; 不传=全部 */
  tools?: string[];
  /** 模型覆盖 */
  model?: string;
  /** 最大工具调用循环次数(防死循环) */
  maxToolRounds?: number;
}

export function createAiChatCap(router: Router): StreamingCapability {
  return {
    id: 'cap.ai.chat',
    description: 'AI chat with streaming + tool use. All registered caps are exposed as AI tools.',
    inputSchema: {
      type: 'object',
      properties: {
        messages: { type: 'array', description: 'Chat messages [{role, content}]' },
        sessionId: { type: 'string', description: 'Persist to cap.history if provided' },
        tools: { type: 'array', items: { type: 'string' }, description: 'Restrict available caps' },
        model: { type: 'string' },
      },
      required: ['messages'],
    },

    async invoke(_params: Value, _ctx: CallContext) {
      // 非流式入口: 提示走 stream
      return {
        hint: 'use dispatchStream to get a streamId, then subscribe via WebSocket',
      };
    },

    async stream(params: Value, ctx: CallContext) {
      const p = params as AiParams;
      if (!p.messages?.length) throw new Error('messages required');
      const streamId = `stream-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const ac = registerStream(streamId);

      // 异步执行,不阻塞 dispatch_stream 返回
      runAiLoop(p, ctx, streamId, router, ac.signal).catch((err: unknown) => {
        const aborted = ac.signal.aborted || (err instanceof Error && err.name === 'AbortError');
        const msg = aborted ? 'aborted by user' : (err instanceof Error ? err.message : String(err));
        ctx.emit({
          type: 'stream.end', stream_id: streamId,
          data: aborted ? { ok: false, aborted: true, error: msg } : { ok: false, error: msg },
          ts: Date.now(),
        });
      }).finally(() => unregisterStream(streamId));

      return { streamId };
    },
  };
}

// ============================================================================
// 流式任务注册表 — 支持客户端停止生成
// ============================================================================

const activeStreams = new Map<string, AbortController>();

function registerStream(streamId: string): AbortController {
  const ac = new AbortController();
  activeStreams.set(streamId, ac);
  return ac;
}

function unregisterStream(streamId: string): void {
  activeStreams.delete(streamId);
}

/** 停止生成: 中断 AI fetch; 返回是否存在该流 */
export function abortAiStream(streamId: string): boolean {
  const ac = activeStreams.get(streamId);
  if (!ac) return false;
  ac.abort();
  return true;
}

// ============================================================================
// AI 主循环(流式 + 工具调用)
// ============================================================================

async function runAiLoop(
  p: AiParams,
  ctx: CallContext,
  streamId: string,
  router: Router,
  signal: AbortSignal,
) {
  const config = await getConfig(ctx);
  const aiCfg = config.ai as { baseUrl: string; apiKey: string; model: string; maxTokens: number };
  if (!aiCfg.baseUrl || !aiCfg.apiKey) {
    throw new Error('AI not configured. Set ai.baseUrl + ai.apiKey via cap.config (POST /api/config or web shell).');
  }

  // 工具列表每轮刷新, 而非请求开始时快照一次.
  // 快照版的后果: AI 在本轮 cap.plugin install 后, 新 cap 永远不在工具列表里,
  // 于是只能绕道 cap.http POST 自己的 cap (实测真实行为, 一轮能刷十几次).
  // 白名单场景下重算仍只在白名单内取, 不会越界.
  const buildTools = () => {
    const available = router.list().filter(c => c.id !== 'cap.ai.chat');
    return p.tools ? available.filter(c => p.tools!.includes(c.id)) : available;
  };
  let allowedTools = buildTools();

  // 续聊: 若 sessionId 有值, 先从 cap.history 读历史拼进上下文.
  // 前端只发当前 user 消息, 后端补全 — 续聊逻辑集中一处.
  let historyMsgs: Array<{ role: string; content: string }> = [];
  if (p.sessionId) {
    const histReply = await ctx.dispatch('cap.history', {
      action: 'list', sessionId: p.sessionId,
    });
    if (histReply.result.ok) {
      historyMsgs = (histReply.result.data as { messages?: Array<{ role: string; content: string }> }).messages ?? [];
    }
  }
  // 拼接: 历史 (剔除纯工具调用消息, AI API 不认 role=tool 无 tool_call_id 的孤儿)
  //   + 当前用户消息
  const filteredHist = historyMsgs.filter(m =>
    m.role === 'user' || m.role === 'assistant'
  ).map(m => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  }));
  const messages: Array<Record<string, unknown>> = [...filteredHist, ...p.messages];

  // 持久化用户消息
  if (p.sessionId) {
    const last = p.messages[p.messages.length - 1];
    if (last?.role === 'user') {
      await ctx.dispatch('cap.history', {
        action: 'append', sessionId: p.sessionId,
        message: { role: 'user', content: last.content },
      });
    }
  }

  // 工具调用循环: 无上限, 靠 finishReason !== 'tool_calls' 自然退出.
  // (用户要求不加限制; AI 持续调用工具直到自行结束生成)
  // round 仅作事件元信息, 不做边界.
  for (let round = 0; ; round++) {
    if (signal.aborted) {
      ctx.emit({
        type: 'stream.end', stream_id: streamId,
        data: { ok: false, aborted: true, error: 'aborted by user' }, ts: Date.now(),
      });
      return;
    }
    // 1. 调 AI(流式)
    const result = callAiStream(aiCfg, messages, allowedTools, p.model, signal);

    // 2. 收集 chunk + 解析工具调用
    const assistantContent: string[] = [];
    let toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
    let finishReason = '';

    try {
      for await (const part of result) {
        if (signal.aborted) break;
        if (part.delta) {
          assistantContent.push(part.delta);
          ctx.emit({
            type: 'stream.chunk', stream_id: streamId,
            data: part.delta, ts: Date.now(),
          });
        }
        if (part.toolCalls) {
          toolCalls = part.toolCalls;
        }
        if (part.finishReason) finishReason = part.finishReason;
      }
    } catch (err) {
      const aborted = signal.aborted || (err instanceof Error && err.name === 'AbortError');
      if (!aborted) throw err;
      // 停止生成: 已生成的部分内容照常落盘 (用户能看到半截回复被保留)
      if (assistantContent.length && p.sessionId) {
        await ctx.dispatch('cap.history', {
          action: 'append', sessionId: p.sessionId,
          message: { role: 'assistant', content: assistantContent.join('') },
        });
      }
      ctx.emit({
        type: 'stream.end', stream_id: streamId,
        data: { ok: false, aborted: true, error: 'aborted by user' }, ts: Date.now(),
      });
      return;
    }

    const assistantMsg: Record<string, unknown> = {
      role: 'assistant',
      content: assistantContent.join(''),
    };
    if (toolCalls.length) {
      assistantMsg.tool_calls = toolCalls.map(tc => ({
        id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      }));
    }
    messages.push(assistantMsg);

    // 3. 持久化 assistant 消息
    if (p.sessionId) {
      await ctx.dispatch('cap.history', {
        action: 'append', sessionId: p.sessionId,
        message: assistantMsg,
      });
    }

    // 4. 无工具调用 → 结束
    if (!toolCalls.length || finishReason !== 'tool_calls') {
      ctx.emit({
        type: 'stream.end', stream_id: streamId,
        data: { ok: true, rounds: round + 1 }, ts: Date.now(),
      });
      return;
    }

    // 5. 执行工具调用(AI 操作 cap)
    for (const tc of toolCalls) {
      ctx.emit({
        type: 'stream.tool', stream_id: streamId,
        data: { name: tc.name, args: tc.args }, ts: Date.now(),
      });
      const reply = await ctx.dispatch(tc.name as never, tc.args);
      const toolResult = reply.result.ok
        ? JSON.stringify(reply.result.data)
        : `Error: ${reply.result.error}`;
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        name: tc.name,
        content: toolResult,
      });
      ctx.emit({
        type: 'stream.toolResult', stream_id: streamId,
        data: { name: tc.name, result: reply.result }, ts: Date.now(),
      });
    }
    // 循环继续 → AI 看到工具结果继续生成.
    // 上一批工具可能刚注册了新 cap (cap.plugin install), 刷新列表让下一轮可见.
    allowedTools = buildTools();
  }
  // 不可达: 循环仅靠 finishReason !== 'tool_calls' 退出, 无上限.
}

// ============================================================================
// AI HTTP 调用(OpenAI 兼容, SSE 流式解析)
// ============================================================================

async function getConfig(_ctx: CallContext): Promise<{ ai: Record<string, unknown> }> {
  // 内部直读: cap.config get 对非 admin remote 脱敏, AI 读自身配置走原始值
  return readConfigRaw() as { ai: Record<string, unknown> };
}

interface AiPart {
  delta?: string;
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  finishReason?: string;
}

async function* callAiStream(
  cfg: { baseUrl: string; apiKey: string; model: string; maxTokens: number },
  messages: Array<Record<string, unknown>>,
  tools: Array<{ id: string; description: string; inputSchema: Record<string, unknown> }>,
  modelOverride?: string,
  signal?: AbortSignal,
): AsyncGenerator<AiPart> {
  const base = cfg.baseUrl.replace(/\/$/, '');
  // 智能拼接: 用户可能填 "https://api.x.com" 或 ".../v1" 或 ".../v1/"
  // 统一指向 /v1/chat/completions, 避免重复 /v1
  const url = (base.endsWith('/v1') ? base : base + '/v1') + '/chat/completions';
  const body: Record<string, unknown> = {
    model: modelOverride ?? cfg.model,
    messages,
    stream: true,
    max_tokens: cfg.maxTokens,
  };
  if (tools.length) {
    body.tools = tools.map(t => ({
      type: 'function',
      function: {
        name: t.id,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
    body.tool_choice = 'auto';
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => '');
    throw new Error(`AI API ${resp.status}: ${text.slice(0, 500)}`);
  }

  // SSE 解析
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const toolAcc = new Map<number, { id: string; name: string; argsBuf: string }>();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') {
        // flush 残留的累积工具调用(无 finish_reason 的边界情况)
        if (toolAcc.size > 0) {
          const calls = [...toolAcc.values()].map(tc => {
            let args = {};
            try { args = JSON.parse(tc.argsBuf || '{}'); } catch { /* ignore */ }
            return { id: tc.id, name: tc.name, args };
          });
          toolAcc.clear();
          yield { toolCalls: calls };
        }
        // 不再 yield finishReason — finish_reason 字段已处理(避免覆盖 tool_calls)
        return;
      }
      try {
        const json = JSON.parse(data);
        const choice = json.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta;
        if (delta?.content) {
          yield { delta: delta.content };
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolAcc.has(idx)) {
              toolAcc.set(idx, {
                id: tc.id ?? `call-${idx}`,
                name: tc.function?.name ?? '',
                argsBuf: '',
              });
            }
            const acc = toolAcc.get(idx)!;
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments) acc.argsBuf += tc.function.arguments;
          }
        }
        if (choice.finish_reason) {
          if (toolAcc.size > 0) {
            const calls = [...toolAcc.values()].map(tc => {
              let args = {};
              try { args = JSON.parse(tc.argsBuf || '{}'); } catch { /* ignore */ }
              return { id: tc.id, name: tc.name, args };
            });
            toolAcc.clear();
            yield { toolCalls: calls, finishReason: 'tool_calls' };
          } else {
            yield { finishReason: choice.finish_reason };
          }
        }
      } catch { /* 跳过非 JSON 行 */ }
    }
  }
}

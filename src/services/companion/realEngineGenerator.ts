/**
 * RealEngineContentGenerator — 调用真实 AI 引擎生成主动内容
 *
 * 使用 Polaris 的静默会话模式（silentMode: true）：
 * 1. 创建一次性的静默会话
 * 2. 发送构建好的 prompt
 * 3. 等待流式结束
 * 4. 提取助手回复文本，解析为 JSON
 * 5. 销毁会话
 *
 * 与 titleGenerationService / contextCompactHandoff 使用相同的模式。
 */

import { createLogger } from '@/utils/logger';
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager';
import { pickLatestAssistantText } from '@/services/assistantTextUtils';
import type { CompanionContentGenerator, GeneratedContent, ContentSchema } from './types';
import type { EngineId } from '@/types';

const log = createLogger('RealEngineGenerator');

/** 超时（毫秒） */
const GENERATION_TIMEOUT_MS = 30_000;

/**
 * 等待会话空闲（流式结束）。
 * 轮询 isStreaming，超时后异常退出。
 */
function waitForSessionIdle(
  sessionId: string,
  signal: AbortSignal,
  timeoutMs = GENERATION_TIMEOUT_MS
): Promise<void> {
  return new Promise((resolve, reject) => {
    const stores = sessionStoreManager.getState().stores;
    const store = stores.get(sessionId);
    if (!store) {
      reject(new Error('会话不存在'));
      return;
    }

    // 已经空闲
    if (!store.getState().isStreaming) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('生成超时'));
    }, timeoutMs);

    const unsubscribe = store.subscribe((state) => {
      if (signal.aborted) {
        clearTimeout(timeout);
        unsubscribe();
        reject(new Error('已取消'));
        return;
      }
      if (!state.isStreaming) {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      }
    });
  });
}

/**
 * 从 LLM 输出的文本中提取第一个合法 JSON 对象。
 * 兼容 Markdown 代码块包装（```json ... ```）。
 */
function extractJSON(text: string): Record<string, unknown> | null {
  let cleaned = text.trim();
  // 去掉 ```json ... ``` 或 ``` ... ``` 包装
  const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    cleaned = codeBlock[1].trim();
  }

  // 找第一个 { ... } 匹配
  const start = cleaned.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === '{') depth++;
    else if (cleaned[i] === '}') depth--;
    if (depth === 0) {
      try {
        return JSON.parse(cleaned.slice(start, i + 1)) as Record<string, unknown>;
      } catch {
        // 尝试找到下一个闭合
        depth = 1; // 继续找
      }
    }
  }
  return null;
}

/**
 * 真实引擎内容生成器
 *
 * 执行流：
 * 1. 创建静默会话（silentMode: true）
 * 2. 发送 prompt + 系统提示
 * 3. 等待流式结束
 * 4. 提取 JSON 结果
 * 5. 销毁会话
 */
export class RealEngineContentGenerator implements CompanionContentGenerator {
  private engineId: EngineId;
  private workspaceId: string;
  private workspacePath: string;

  constructor(engineId: string, workspaceId: string, workspacePath: string) {
    this.engineId = engineId as EngineId;
    this.workspaceId = workspaceId;
    this.workspacePath = workspacePath;
  }

  async generate(
    prompt: string,
    schema: ContentSchema
  ): Promise<GeneratedContent | null> {
    const abortSignal = new AbortController();

    // 1. 创建静默会话
    const sessionId = this.createSilentSession();
    if (!sessionId) {
      log.warn('创建静默会话失败');
      return null;
    }

    try {
      // 2. 发送 prompt
      const stores = sessionStoreManager.getState().stores;
      const store = stores.get(sessionId);
      if (!store) {
        log.warn('获取会话 store 失败');
        return null;
      }

      await store.getState().sendMessage(prompt, this.workspacePath, undefined, {
        runtimeOverride: {
          permissionMode: 'bypassPermissions',
        },
      });

      // 3. 等待流式结束
      await waitForSessionIdle(sessionId, abortSignal.signal);

      // 4. 提取结果
      const state = store.getState();
      if (state.error) {
        log.warn('生成会话报错', { error: state.error });
        return null;
      }

      const rawText = pickLatestAssistantText(state);
      if (!rawText || rawText.trim().length < 10) {
        log.warn('生成结果为空或过短');
        return null;
      }

      // 5. 解析 JSON
      const parsed = extractJSON(rawText);
      if (!parsed) {
        log.warn('无法解析生成结果为 JSON', { preview: rawText.slice(0, 100) });
        return null;
      }

      // 6. 映射到 GeneratedContent
      const content: GeneratedContent = {
        id: `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: schema.type,
        title: String(parsed.title ?? '') || '未命名',
        body: String(parsed.body ?? '') || String(parsed.content ?? ''),
        createdAt: Date.now(),
        action: parsed.action
          ? {
              label: String((parsed.action as Record<string, unknown>).label ?? ''),
              payload: String((parsed.action as Record<string, unknown>).payload ?? ''),
            }
          : undefined,
        evidence: Array.isArray(parsed.evidence)
          ? (parsed.evidence as string[]).map(String)
          : undefined,
      };

      log.info('内容生成成功', { id: content.id, type: content.type, title: content.title });
      return content;
    } catch (err) {
      log.warn('生成过程异常', { error: (err as Error).message });
      return null;
    } finally {
      // 清理
      abortSignal.abort();
      try {
        sessionStoreManager.getState().deleteSession(sessionId);
      } catch {
        // 忽略清理失败
      }
    }
  }

  private createSilentSession(): string | null {
    try {
      return sessionStoreManager.getState().createSession({
        type: 'project',
        title: 'Companion Content',
        engineId: this.engineId,
        silentMode: true,
        workspaceId: this.workspaceId,
      });
    } catch (err) {
      log.warn('创建静默会话失败', { error: (err as Error).message });
      return null;
    }
  }
}

// 导出辅助函数方便测试
export { extractJSON, waitForSessionIdle };
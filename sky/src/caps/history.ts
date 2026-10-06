/**
 * cap.history — 会话历史能力(JSONL 真相源 + 索引可重建)
 *
 * 动作: append/list/get/clear
 * 存储在 <DataRoot>/history/<sessionId>.jsonl
 * 索引(可选): 纯派生,可随时重建
 */

import { mkdirSync, appendFileSync, readFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Capability, Value } from '../contracts.ts';
import { dataRoot } from '../storage.ts';

const HISTORY_DIR = join(dataRoot, 'history');

function ensureDir() {
  mkdirSync(HISTORY_DIR, { recursive: true });
}

export const historyCap: Capability = {
  id: 'cap.history',
  description: 'Session history (JSONL). Actions: append/list/get/clear. Per-session file.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['append', 'list', 'get', 'clear', 'sessions'] },
      sessionId: { type: 'string' },
      message: { description: 'Message object for append' },
    },
    required: ['action'],
  },
  async invoke(params: Value) {
    const p = params as {
      action: 'append' | 'list' | 'get' | 'clear' | 'sessions';
      sessionId?: string;
      message?: { role: string; content: unknown; ts?: number };
    };
    ensureDir();
    switch (p.action) {
      case 'append': {
        if (!p.sessionId) throw new Error('sessionId required');
        const msg = { ...p.message, ts: p.message?.ts ?? Date.now() };
        const file = join(HISTORY_DIR, `${p.sessionId}.jsonl`);
        appendFileSync(file, JSON.stringify(msg) + '\n', 'utf8');
        return { ok: true, ts: msg.ts };
      }
      case 'list': {
        if (!p.sessionId) throw new Error('sessionId required');
        const file = join(HISTORY_DIR, `${p.sessionId}.jsonl`);
        if (!existsSync(file)) return { messages: [] };
        const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
        return { messages: lines.map(l => JSON.parse(l)) };
      }
      case 'get': {
        if (!p.sessionId) throw new Error('sessionId required');
        const file = join(HISTORY_DIR, `${p.sessionId}.jsonl`);
        if (!existsSync(file)) return { ok: false, notFound: true };
        return { ok: true, content: readFileSync(file, 'utf8') };
      }
      case 'clear': {
        if (!p.sessionId) throw new Error('sessionId required');
        const file = join(HISTORY_DIR, `${p.sessionId}.jsonl`);
        if (existsSync(file)) unlinkSync(file);
        return { ok: true };
      }
      case 'sessions': {
        const files = readdirSync(HISTORY_DIR).filter(f => f.endsWith('.jsonl'));
        return {
          sessions: files.map(f => {
            const id = f.replace('.jsonl', '');
            const stat = existsSync(join(HISTORY_DIR, f))
              ? { size: readFileSync(join(HISTORY_DIR, f), 'utf8').length }
              : { size: 0 };
            return { sessionId: id, size: stat.size };
          }),
        };
      }
      default:
        throw new Error(`unknown action: ${(p as { action: string }).action}`);
    }
  },
};

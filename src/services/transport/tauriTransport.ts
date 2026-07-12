/**
 * Tauri IPC 传输适配器 — 桌面端直接调用 Tauri invoke/listen
 */

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

/**
 * 快捷片段状态管理
 */

import { create } from 'zustand';
import * as tauri from '@/services/tauri';
import type { PromptSnippet, CreateSnippetParams, UpdateSnippetParams } from '@/types/promptSnippet';
import { createLogger } from '@/utils/logger';

const log = createLogger('SnippetStore');

interface SnippetState {
  snippets: PromptSnippet[];
  loading: boolean;
  error: string | null;

  loadSnippets: () => Promise<void>;
  createSnippet: (params: CreateSnippetParams) => Promise<PromptSnippet>;
  updateSnippet: (id: string, params: UpdateSnippetParams) => Promise<PromptSnippet | null>;
  deleteSnippet: (id: string) => Promise<boolean>;
  searchSnippets: (query: string) => PromptSnippet[];
}

export const useSnippetStore = create<SnippetState>((set, get) => ({
  snippets: [],
  loading: false,
  error: null,

  loadSnippets: async () => {
    set({ loading: true, error: null });
    try {
      const snippets = await tauri.snippetList();
      set({ snippets, loading: false });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('加载片段失败', err instanceof Error ? err : new Error(msg));
      set({ error: msg, loading: false });
    }
  },

  createSnippet: async (params) => {
    const snippet = await tauri.snippetCreate(params);
    set(state => ({ snippets: [...state.snippets, snippet] }));
    return snippet;
  },

  updateSnippet: async (id, params) => {
    const result = await tauri.snippetUpdate(id, params);
    if (result) {
      set(state => ({
        snippets: state.snippets.map(s => (s.id === id ? result : s)),
      }));
    }
    return result;
  },

  deleteSnippet: async (id) => {
    const deleted = await tauri.snippetDelete(id);
    if (deleted) {
      set(state => ({
        snippets: state.snippets.filter(s => s.id !== id),
      }));
    }
    return deleted;
  },

  searchSnippets: (query) => {
    const { snippets } = get();
    if (!query) return snippets.filter(s => s.enabled);
    const lower = query.toLowerCase();
    return snippets.filter(
      s =>
        s.enabled &&
        (s.name.toLowerCase().includes(lower) ||
          (s.description?.toLowerCase().includes(lower) ?? false))
    );
  },
}));

/**
 * 诊断聚合 Store
 *
 * 存储所有文件的 LSP 诊断结果（按 uri），供 Problems 面板 / 状态栏统计使用。
 *
 * 数据来源：`lspStore.ts` 里给 `LSPClient` 注册的自定义
 * `LSPClientExtension`，会拦截 `textDocument/publishDiagnostics` 通知并
 * 调用 `set(uri, diagnostics)`。
 */

import { create } from 'zustand';

/** LSP Diagnostic 的最小字段集 */
export interface DiagnosticItem {
  severity?: number; // 1=Error 2=Warning 3=Info 4=Hint
  message: string;
  source?: string;
  code?: string | number;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

interface DiagnosticsState {
  /** key = file URI */
  byUri: Map<string, DiagnosticItem[]>;
  /** 全量集合变更版本号，方便 memo 判断 */
  version: number;
  /** 缓存的汇总计数，byUri 变更时自动重算 */
  summary: { errors: number; warnings: number; infos: number; hints: number };

  set: (uri: string, diagnostics: DiagnosticItem[]) => void;
  clear: (uri: string) => void;
  clearAll: () => void;
  /** 所有诊断拍平为 (uri, item) 对 */
  flat: () => Array<{ uri: string; item: DiagnosticItem }>;
}

const EMPTY_SUMMARY = { errors: 0, warnings: 0, infos: 0, hints: 0 };

function computeSummary(byUri: Map<string, DiagnosticItem[]>): { errors: number; warnings: number; infos: number; hints: number } {
  let errors = 0, warnings = 0, infos = 0, hints = 0;
  for (const items of byUri.values()) {
    for (const d of items) {
      switch (d.severity) {
        case 1: errors++; break;
        case 2: warnings++; break;
        case 3: infos++; break;
        case 4: hints++; break;
        default: errors++; break;
      }
    }
  }
  return { errors, warnings, infos, hints };
}

export const useDiagnosticsStore = create<DiagnosticsState>((set, get) => ({
  byUri: new Map(),
  version: 0,
  summary: EMPTY_SUMMARY,

  set: (uri, diagnostics) => {
    set((state) => {
      const next = new Map(state.byUri);
      if (diagnostics.length === 0) {
        next.delete(uri);
      } else {
        next.set(uri, diagnostics);
      }
      const summary = computeSummary(next);
      return { byUri: next, version: state.version + 1, summary };
    });
  },

  clear: (uri) => {
    set((state) => {
      if (!state.byUri.has(uri)) return {};
      const next = new Map(state.byUri);
      next.delete(uri);
      const summary = computeSummary(next);
      return { byUri: next, version: state.version + 1, summary };
    });
  },

  clearAll: () => {
    set({ byUri: new Map(), version: get().version + 1, summary: EMPTY_SUMMARY });
  },

  flat: () => {
    const out: Array<{ uri: string; item: DiagnosticItem }> = [];
    for (const [uri, items] of get().byUri.entries()) {
      for (const item of items) out.push({ uri, item });
    }
    return out;
  },
}));

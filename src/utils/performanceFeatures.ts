/**
 * 性能功能开关查询
 *
 * 从 configStore 读取 performance 配置，各组件按需调用。
 * 大多数开关默认关闭（false），用户手动开启后即时生效。
 * 例外：schedulerDaemon 默认启用（定时任务是核心功能）。
 *
 * 为避免循环依赖，核心查询函数接受 config 对象作为参数，
 * 而非直接 import configStore。
 */

import type { Config } from '@/types';
import { useConfigStore } from '@/stores/configStore';

type PerfConfig = NonNullable<Config['performance']>;

/**
 * 从传入的 config 读取单个开关状态。
 * 参数化设计，避免循环依赖。
 */
function readFlag(config: Config | null | undefined, key: keyof PerfConfig): boolean {
  return !!config?.performance?.[key];
}

// ============================================================================
// 组件内使用（React hook）
// ============================================================================

/** React 组件内读取 performance 配置（触发响应式更新） */
export function usePerformanceConfig() {
  const performance = useConfigStore((state) => state.config?.performance ?? {});
  return performance;
}

/** React 组件内读取单个开关 */
export function usePerformanceFlag(key: keyof PerfConfig): boolean {
  const config = useConfigStore((state) => state.config);
  return readFlag(config, key);
}

// ============================================================================
// 组件外/工具函数使用（非响应式，适合渲染器回调）
// ============================================================================

/**
 * 工具函数中读取开关（非响应式）。
 * 不直接 import configStore，而是接受 config 作为参数。
 */

/** 检查语法高亮是否启用 */
export function isSyntaxHighlightingEnabled(config?: Config | null): boolean {
  const cfg = config ?? useConfigStore.getState().config;
  return readFlag(cfg, 'syntaxHighlighting');
}

/** 检查 Mermaid 图表渲染是否启用 */
export function isMermaidDiagramsEnabled(config?: Config | null): boolean {
  const cfg = config ?? useConfigStore.getState().config;
  return readFlag(cfg, 'mermaidDiagrams');
}

/** 检查 KaTeX 公式渲染是否启用 */
export function isKatexMathEnabled(config?: Config | null): boolean {
  const cfg = config ?? useConfigStore.getState().config;
  return readFlag(cfg, 'katexMath');
}

/** 检查代码编辑器语言包预加载是否启用 */
export function isCodeEditorLanguagesEnabled(config?: Config | null): boolean {
  const cfg = config ?? useConfigStore.getState().config;
  return readFlag(cfg, 'codeEditorLanguages');
}

/** 检查 LSP 智能索引是否启用 */
export function isLspIndexEnabled(config?: Config | null): boolean {
  const cfg = config ?? useConfigStore.getState().config;
  return readFlag(cfg, 'lspIndex');
}

/** 检查文件监听是否启用 */
export function isFileWatcherEnabled(config?: Config | null): boolean {
  const cfg = config ?? useConfigStore.getState().config;
  return readFlag(cfg, 'fileWatcher');
}

/** 检查调度器守护进程是否启用 */
export function isSchedulerDaemonEnabled(config?: Config | null): boolean {
  const cfg = config ?? useConfigStore.getState().config;
  return readFlag(cfg, 'schedulerDaemon');
}

/** 检查插件服务自动启动是否启用 */
export function isPluginAutoStartEnabled(config?: Config | null): boolean {
  const cfg = config ?? useConfigStore.getState().config;
  return readFlag(cfg, 'pluginAutoStart');
}
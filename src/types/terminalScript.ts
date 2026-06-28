/**
 * 终端脚本类型定义
 */

export type TerminalScriptSource = 'package.json' | 'maven' | 'gradle' | 'user';

export type TerminalScriptAutoRunTrigger = 'app_start' | 'workspace_open' | 'terminal_open';

export type TerminalScriptRunStatus = 'idle' | 'running' | 'success' | 'failed' | 'stopped';

export interface TerminalScript {
  id: string;
  name: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  tags?: string[];
  source: TerminalScriptSource | string;
  sourcePath?: string;
  enabled: boolean;
  autoRun: boolean;
  autoRunTrigger?: TerminalScriptAutoRunTrigger;
  confirmBeforeAutoRun: boolean;
}

export interface WorkspaceTerminalScripts {
  scripts: TerminalScript[];
  hiddenDiscoveredScriptIds?: string[];
}

export interface DiscoveredTerminalScript {
  id: string;
  name: string;
  command: string;
  cwd: string;
  source: TerminalScriptSource | string;
  sourcePath: string;
  enabled: boolean;
  tags: string[];
}

export interface TerminalScriptRuntime {
  status: TerminalScriptRunStatus;
  terminalSessionId?: string;
  exitCode?: number;
  lastRunAt?: number;
  error?: string;
}

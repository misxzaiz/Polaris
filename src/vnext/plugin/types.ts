/**
 * Plugin System Types for Polaris Scheduler vNext
 *
 * Provides a flexible plugin architecture for extending the workflow engine
 */

import type { Workflow, WorkflowNode, AgentEvent } from '../types';
import type { WorkflowRuntime } from '../runtime';

/**
 * Plugin lifecycle hooks - key extension points
 */
export type PluginHook =
  | 'beforeWorkflowStart'
  | 'afterWorkflowComplete'
  | 'beforeNodeExecute'
  | 'afterNodeExecute'
  | 'onWorkflowError'
  | 'onNodeError'
  | 'onEventEmit'
  | 'onEventReceive'
  | 'beforeMemorySave'
  | 'afterMemoryLoad'
  | 'beforePersist'
  | 'afterRestore';

/**
 * Plugin execution context
 */
export interface PluginContext {
  /** Plugin configuration */
  config: Record<string, unknown>;
  /** Reference to the runtime */
  runtime: WorkflowRuntime;
  /** Logger instance */
  logger: PluginLogger;
  /** Shared state between hooks */
  state: Map<string, unknown>;
}

/**
 * Plugin logger interface
 */
export interface PluginLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * Hook execution result
 */
export interface HookResult<T = unknown> {
  /** Whether to continue execution */
  continue: boolean;
  /** Modified data (if applicable) */
  data?: T;
  /** Error if hook failed */
  error?: Error;
}

/**
 * Before workflow start hook payload
 */
export interface BeforeWorkflowStartPayload {
  workflow: Workflow;
}

/**
 * After workflow complete hook payload
 */
export interface AfterWorkflowCompletePayload {
  workflow: Workflow;
  success: boolean;
  duration: number;
}

/**
 * Before node execute hook payload
 */
export interface BeforeNodeExecutePayload {
  workflow: Workflow;
  node: WorkflowNode;
}

/**
 * After node execute hook payload
 */
export interface AfterNodeExecutePayload {
  workflow: Workflow;
  node: WorkflowNode;
  success: boolean;
  duration: number;
  output?: unknown;
}

/**
 * Workflow error hook payload
 */
export interface WorkflowErrorPayload {
  workflow: Workflow;
  error: Error;
  phase: string;
}

/**
 * Node error hook payload
 */
export interface NodeErrorPayload {
  workflow: Workflow;
  node: WorkflowNode;
  error: Error;
}

/**
 * Event emit hook payload
 */
export interface EventEmitPayload {
  event: AgentEvent;
  source: string;
}

/**
 * Event receive hook payload
 */
export interface EventReceivePayload {
  event: AgentEvent;
  targetNode?: string;
}

/**
 * Memory save hook payload
 */
export interface MemorySavePayload {
  workflowId: string;
  layer: string;
  data: unknown;
}

/**
 * Memory load hook payload
 */
export interface MemoryLoadPayload {
  workflowId: string;
  layer: string;
  data: unknown;
}

/**
 * Persist hook payload
 */
export interface PersistPayload {
  workflowId: string;
  snapshot: unknown;
}

/**
 * Restore hook payload
 */
export interface RestorePayload {
  workflowId: string;
  snapshot: unknown;
}

/**
 * Plugin hook handler type
 */
export type HookHandler<Payload, Result = unknown> = (
  payload: Payload,
  context: PluginContext
) => Promise<HookResult<Result>> | HookResult<Result>;

/**
 * Plugin hook map
 */
export interface PluginHooks {
  beforeWorkflowStart?: HookHandler<BeforeWorkflowStartPayload>;
  afterWorkflowComplete?: HookHandler<AfterWorkflowCompletePayload>;
  beforeNodeExecute?: HookHandler<BeforeNodeExecutePayload>;
  afterNodeExecute?: HookHandler<AfterNodeExecutePayload>;
  onWorkflowError?: HookHandler<WorkflowErrorPayload>;
  onNodeError?: HookHandler<NodeErrorPayload>;
  onEventEmit?: HookHandler<EventEmitPayload>;
  onEventReceive?: HookHandler<EventReceivePayload>;
  beforeMemorySave?: HookHandler<MemorySavePayload>;
  afterMemoryLoad?: HookHandler<MemoryLoadPayload>;
  beforePersist?: HookHandler<PersistPayload>;
  afterRestore?: HookHandler<RestorePayload>;
}

/**
 * Plugin priority (higher = executed first)
 */
export type PluginPriority = 'lowest' | 'low' | 'normal' | 'high' | 'highest';

/**
 * Plugin metadata
 */
export interface PluginMeta {
  /** Unique plugin identifier */
  id: string;
  /** Plugin name */
  name: string;
  /** Plugin version */
  version: string;
  /** Plugin description */
  description?: string;
  /** Plugin author */
  author?: string;
  /** Required vnext version */
  engineVersion?: string;
  /** Plugin dependencies */
  dependencies?: string[];
  /** Plugin priority */
  priority?: PluginPriority;
  /** Whether plugin is enabled by default */
  enabled?: boolean;
}

/**
 * Plugin definition
 */
export interface Plugin {
  /** Plugin metadata */
  meta: PluginMeta;
  /** Plugin configuration schema */
  configSchema?: PluginConfigSchema;
  /** Default configuration */
  defaultConfig?: Record<string, unknown>;
  /** Plugin hooks */
  hooks: PluginHooks;
  /** Plugin initialization */
  init?: (context: PluginContext) => Promise<void> | void;
  /** Plugin cleanup */
  destroy?: (context: PluginContext) => Promise<void> | void;
}

/**
 * Configuration schema definition
 */
export interface PluginConfigSchema {
  [key: string]: ConfigField;
}

/**
 * Configuration field definition
 */
export interface ConfigField {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required?: boolean;
  default?: unknown;
  description?: string;
  validation?: {
    min?: number;
    max?: number;
    pattern?: string;
    enum?: unknown[];
  };
}

/**
 * Plugin manager configuration
 */
export interface PluginManagerConfig {
  /** Maximum number of plugins to load */
  maxPlugins?: number;
  /** Enable hot reload */
  hotReload?: boolean;
  /** Plugin directory */
  pluginDir?: string;
  /** Default logger */
  logger?: PluginLogger;
}

/**
 * Plugin state
 */
export type PluginState = 'unloaded' | 'loading' | 'loaded' | 'active' | 'error' | 'unloading';

/**
 * Plugin status
 */
export interface PluginStatus {
  id: string;
  state: PluginState;
  enabled: boolean;
  loadTime?: number;
  error?: Error;
}

/**
 * Built-in plugin IDs
 */
export const BUILTIN_PLUGINS = {
  LOGGING: '@polaris/plugin-logging',
  METRICS: '@polaris/plugin-metrics',
  TRACING: '@polaris/plugin-tracing',
  RATE_LIMIT: '@polaris/plugin-rate-limit',
  CACHING: '@polaris/plugin-caching',
} as const;

/**
 * Built-in Plugins for Polaris Scheduler vNext
 *
 * Provides commonly used plugins out of the box
 */

import type {
  Plugin,
  PluginContext,
  HookResult,
  BeforeWorkflowStartPayload,
  AfterWorkflowCompletePayload,
  BeforeNodeExecutePayload,
  AfterNodeExecutePayload,
  WorkflowErrorPayload,
  NodeErrorPayload,
} from './types';

/**
 * Logging Plugin
 *
 * Logs workflow and node lifecycle events
 */
export const loggingPlugin: Plugin = {
  meta: {
    id: '@polaris/plugin-logging',
    name: 'Logging Plugin',
    version: '1.0.0',
    description: 'Logs workflow and node lifecycle events',
    priority: 'highest',
    enabled: true,
  },
  defaultConfig: {
    logWorkflowStart: true,
    logWorkflowComplete: true,
    logNodeExecute: true,
    logErrors: true,
    verbose: false,
  },
  hooks: {
    beforeWorkflowStart: async (
      payload: BeforeWorkflowStartPayload,
      context: PluginContext
    ): Promise<HookResult> => {
      if (context.config.logWorkflowStart) {
        context.logger.info(
          `Workflow starting: ${payload.workflow.name} (${payload.workflow.id})`
        );
      }
      return { continue: true };
    },

    afterWorkflowComplete: async (
      payload: AfterWorkflowCompletePayload,
      context: PluginContext
    ): Promise<HookResult> => {
      if (context.config.logWorkflowComplete) {
        const status = payload.success ? 'completed' : 'failed';
        context.logger.info(
          `Workflow ${status}: ${payload.workflow.name} (${payload.workflow.id}) - ${payload.duration}ms`
        );
      }
      return { continue: true };
    },

    beforeNodeExecute: async (
      payload: BeforeNodeExecutePayload,
      context: PluginContext
    ): Promise<HookResult> => {
      if (context.config.logNodeExecute) {
        context.logger.info(
          `Node executing: ${payload.node.name} (${payload.node.id})`
        );
      }
      return { continue: true };
    },

    afterNodeExecute: async (
      payload: AfterNodeExecutePayload,
      context: PluginContext
    ): Promise<HookResult> => {
      if (context.config.logNodeExecute) {
        const status = payload.success ? 'completed' : 'failed';
        context.logger.info(
          `Node ${status}: ${payload.node.name} (${payload.node.id}) - ${payload.duration}ms`
        );
      }
      return { continue: true };
    },

    onWorkflowError: async (
      payload: WorkflowErrorPayload,
      context: PluginContext
    ): Promise<HookResult> => {
      if (context.config.logErrors) {
        context.logger.error(
          `Workflow error in ${payload.workflow.name}: ${payload.error.message}`,
          payload.error
        );
      }
      return { continue: true };
    },

    onNodeError: async (
      payload: NodeErrorPayload,
      context: PluginContext
    ): Promise<HookResult> => {
      if (context.config.logErrors) {
        context.logger.error(
          `Node error in ${payload.node.name}: ${payload.error.message}`,
          payload.error
        );
      }
      return { continue: true };
    },
  },
};

/**
 * Metrics Plugin
 *
 * Collects and exposes metrics about workflow execution
 */
export interface MetricsData {
  workflowsStarted: number;
  workflowsCompleted: number;
  workflowsFailed: number;
  nodesExecuted: number;
  nodesSucceeded: number;
  nodesFailed: number;
  totalExecutionTime: number;
  errors: Array<{
    workflowId: string;
    nodeId?: string;
    error: string;
    timestamp: number;
  }>;
}

export const metricsPlugin: Plugin = {
  meta: {
    id: '@polaris/plugin-metrics',
    name: 'Metrics Plugin',
    version: '1.0.0',
    description: 'Collects execution metrics',
    priority: 'high',
    enabled: true,
  },
  defaultConfig: {
    collectErrors: true,
    maxErrorHistory: 100,
  },
  hooks: {
    beforeWorkflowStart: async (
      payload: BeforeWorkflowStartPayload,
      context: PluginContext
    ): Promise<HookResult> => {
      const metrics = context.state.get('metrics') as MetricsData | undefined;
      if (metrics) {
        metrics.workflowsStarted++;
      }
      return { continue: true };
    },

    afterWorkflowComplete: async (
      payload: AfterWorkflowCompletePayload,
      context: PluginContext
    ): Promise<HookResult> => {
      const metrics = context.state.get('metrics') as MetricsData | undefined;
      if (metrics) {
        if (payload.success) {
          metrics.workflowsCompleted++;
        } else {
          metrics.workflowsFailed++;
        }
        metrics.totalExecutionTime += payload.duration;
      }
      return { continue: true };
    },

    afterNodeExecute: async (
      payload: AfterNodeExecutePayload,
      context: PluginContext
    ): Promise<HookResult> => {
      const metrics = context.state.get('metrics') as MetricsData | undefined;
      if (metrics) {
        metrics.nodesExecuted++;
        if (payload.success) {
          metrics.nodesSucceeded++;
        } else {
          metrics.nodesFailed++;
        }
      }
      return { continue: true };
    },

    onWorkflowError: async (
      payload: WorkflowErrorPayload,
      context: PluginContext
    ): Promise<HookResult> => {
      const metrics = context.state.get('metrics') as MetricsData | undefined;
      const config = context.config;
      if (metrics && config.collectErrors) {
        metrics.errors.push({
          workflowId: payload.workflow.id,
          error: payload.error.message,
          timestamp: Date.now(),
        });
        if (metrics.errors.length > (config.maxErrorHistory || 100)) {
          metrics.errors.shift();
        }
      }
      return { continue: true };
    },

    onNodeError: async (
      payload: NodeErrorPayload,
      context: PluginContext
    ): Promise<HookResult> => {
      const metrics = context.state.get('metrics') as MetricsData | undefined;
      const config = context.config;
      if (metrics && config.collectErrors) {
        metrics.errors.push({
          workflowId: payload.workflow.id,
          nodeId: payload.node.id,
          error: payload.error.message,
          timestamp: Date.now(),
        });
        if (metrics.errors.length > (config.maxErrorHistory || 100)) {
          metrics.errors.shift();
        }
      }
      return { continue: true };
    },
  },
  init: (context: PluginContext): void => {
    context.state.set('metrics', {
      workflowsStarted: 0,
      workflowsCompleted: 0,
      workflowsFailed: 0,
      nodesExecuted: 0,
      nodesSucceeded: 0,
      nodesFailed: 0,
      totalExecutionTime: 0,
      errors: [],
    } as MetricsData);
  },
};

/**
 * Rate Limit Plugin
 *
 * Limits the number of concurrent executions
 */
export interface RateLimitConfig {
  maxConcurrentWorkflows: number;
  maxConcurrentNodes: number;
  waitTimeout: number;
}

export const rateLimitPlugin: Plugin = {
  meta: {
    id: '@polaris/plugin-rate-limit',
    name: 'Rate Limit Plugin',
    version: '1.0.0',
    description: 'Limits concurrent executions',
    priority: 'highest',
    enabled: true,
  },
  defaultConfig: {
    maxConcurrentWorkflows: 10,
    maxConcurrentNodes: 5,
    waitTimeout: 30000,
  },
  hooks: {
    beforeWorkflowStart: async (
      payload: BeforeWorkflowStartPayload,
      context: PluginContext
    ): Promise<HookResult> => {
      const state = context.state;
      const activeCount = (state.get('activeWorkflows') as Set<string>)?.size || 0;
      const config = context.config as RateLimitConfig;

      if (activeCount >= config.maxConcurrentWorkflows) {
        context.logger.warn(
          `Rate limit reached: ${activeCount} active workflows`
        );
        return { continue: false, error: new Error('Rate limit exceeded') };
      }

      const active = state.get('activeWorkflows') as Set<string> || new Set();
      active.add(payload.workflow.id);
      state.set('activeWorkflows', active);

      return { continue: true };
    },

    afterWorkflowComplete: async (
      payload: AfterWorkflowCompletePayload,
      context: PluginContext
    ): Promise<HookResult> => {
      const active = context.state.get('activeWorkflows') as Set<string>;
      if (active) {
        active.delete(payload.workflow.id);
      }
      return { continue: true };
    },

    beforeNodeExecute: async (
      payload: BeforeNodeExecutePayload,
      context: PluginContext
    ): Promise<HookResult> => {
      const state = context.state;
      const activeCount = (state.get('activeNodes') as Set<string>)?.size || 0;
      const config = context.config as RateLimitConfig;

      if (activeCount >= config.maxConcurrentNodes) {
        context.logger.warn(`Rate limit reached: ${activeCount} active nodes`);
        return { continue: false, error: new Error('Node rate limit exceeded') };
      }

      const active = state.get('activeNodes') as Set<string> || new Set();
      active.add(payload.node.id);
      state.set('activeNodes', active);

      return { continue: true };
    },

    afterNodeExecute: async (
      payload: AfterNodeExecutePayload,
      context: PluginContext
    ): Promise<HookResult> => {
      const active = context.state.get('activeNodes') as Set<string>;
      if (active) {
        active.delete(payload.node.id);
      }
      return { continue: true };
    },
  },
  init: (context: PluginContext): void => {
    context.state.set('activeWorkflows', new Set<string>());
    context.state.set('activeNodes', new Set<string>());
  },
};

/**
 * Caching Plugin
 *
 * Caches node execution results
 */
export interface CacheEntry {
  output: unknown;
  timestamp: number;
  ttl: number;
}

export const cachingPlugin: Plugin = {
  meta: {
    id: '@polaris/plugin-caching',
    name: 'Caching Plugin',
    version: '1.0.0',
    description: 'Caches node execution results',
    priority: 'normal',
    enabled: true,
  },
  defaultConfig: {
    enabled: true,
    defaultTTL: 60000, // 1 minute
    maxSize: 1000,
  },
  hooks: {
    beforeNodeExecute: async (
      payload: BeforeNodeExecutePayload,
      context: PluginContext
    ): Promise<HookResult> => {
      if (!context.config.enabled) {
        return { continue: true };
      }

      // Check if node has cache enabled
      if (!payload.node.config?.cacheable) {
        return { continue: true };
      }

      const cache = context.state.get('cache') as Map<string, CacheEntry>;
      const cacheKey = `${payload.workflow.id}:${payload.node.id}`;
      const entry = cache?.get(cacheKey);

      if (entry) {
        const now = Date.now();
        if (now - entry.timestamp < entry.ttl) {
          context.logger.debug(`Cache hit for node ${payload.node.id}`);
          return {
            continue: false,
            data: entry.output,
          };
        }
        // Cache expired
        cache.delete(cacheKey);
      }

      return { continue: true };
    },

    afterNodeExecute: async (
      payload: AfterNodeExecutePayload,
      context: PluginContext
    ): Promise<HookResult> => {
      if (!context.config.enabled || !payload.success) {
        return { continue: true };
      }

      // Check if node has cache enabled
      if (!payload.node.config?.cacheable) {
        return { continue: true };
      }

      const cache = context.state.get('cache') as Map<string, CacheEntry>;
      const cacheKey = `${payload.workflow.id}:${payload.node.id}`;

      cache.set(cacheKey, {
        output: payload.output,
        timestamp: Date.now(),
        ttl: payload.node.config?.cacheTTL || context.config.defaultTTL,
      });

      // Enforce max size
      if (cache.size > context.config.maxSize) {
        const firstKey = cache.keys().next().value;
        if (firstKey) {
          cache.delete(firstKey);
        }
      }

      return { continue: true };
    },
  },
  init: (context: PluginContext): void => {
    context.state.set('cache', new Map<string, CacheEntry>());
  },
};

/**
 * Get all built-in plugins
 */
export function getBuiltinPlugins(): Plugin[] {
  return [
    loggingPlugin,
    metricsPlugin,
    rateLimitPlugin,
    cachingPlugin,
  ];
}

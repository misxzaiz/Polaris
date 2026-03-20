/**
 * Plugin System Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  PluginManager,
  loggingPlugin,
  metricsPlugin,
  rateLimitPlugin,
  cachingPlugin,
  getBuiltinPlugins,
} from '../plugin';
import type {
  Plugin,
  BeforeWorkflowStartPayload,
} from '../plugin';

// Test helper to create a mock workflow
function createMockWorkflow(overrides = {}) {
  return {
    id: 'test-workflow-1',
    name: 'Test Workflow',
    version: '1.0.0',
    status: 'idle' as const,
    nodes: [],
    edges: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// Test helper to create a mock node
function createMockNode(overrides = {}) {
  return {
    id: 'test-node-1',
    name: 'Test Node',
    type: 'task' as const,
    status: 'idle' as const,
    dependencies: [],
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('PluginManager', () => {
  let manager: PluginManager;

  beforeEach(() => {
    manager = new PluginManager();
  });

  describe('register', () => {
    it('should register a valid plugin', async () => {
      const plugin: Plugin = {
        meta: {
          id: 'test-plugin',
          name: 'Test Plugin',
          version: '1.0.0',
        },
        hooks: {
          beforeWorkflowStart: async () => ({ continue: true }),
        },
      };

      const result = await manager.register(plugin);
      expect(result).toBe(true);
      expect(manager.getPlugin('test-plugin')).toBe(plugin);
    });

    it('should reject plugin without id', async () => {
      const plugin = {
        meta: {
          name: 'Test Plugin',
          version: '1.0.0',
        },
        hooks: {},
      } as Plugin;

      const result = await manager.register(plugin);
      expect(result).toBe(false);
    });

    it('should reject plugin without name', async () => {
      const plugin = {
        meta: {
          id: 'test-plugin',
          version: '1.0.0',
        },
        hooks: {},
      } as Plugin;

      const result = await manager.register(plugin);
      expect(result).toBe(false);
    });

    it('should reject plugin without version', async () => {
      const plugin = {
        meta: {
          id: 'test-plugin',
          name: 'Test Plugin',
        },
        hooks: {},
      } as Plugin;

      const result = await manager.register(plugin);
      expect(result).toBe(false);
    });

    it('should reject plugin without hooks', async () => {
      const plugin = {
        meta: {
          id: 'test-plugin',
          name: 'Test Plugin',
          version: '1.0.0',
        },
        hooks: {},
      } as Plugin;

      const result = await manager.register(plugin);
      expect(result).toBe(false);
    });

    it('should not register duplicate plugins', async () => {
      const plugin: Plugin = {
        meta: {
          id: 'test-plugin',
          name: 'Test Plugin',
          version: '1.0.0',
        },
        hooks: {
          beforeWorkflowStart: async () => ({ continue: true }),
        },
      };

      await manager.register(plugin);
      const result = await manager.register(plugin);
      expect(result).toBe(false);
    });
  });

  describe('unregister', () => {
    it('should unregister a registered plugin', async () => {
      const plugin: Plugin = {
        meta: {
          id: 'test-plugin',
          name: 'Test Plugin',
          version: '1.0.0',
        },
        hooks: {
          beforeWorkflowStart: async () => ({ continue: true }),
        },
      };

      await manager.register(plugin);
      const result = await manager.unregister('test-plugin');
      expect(result).toBe(true);
      expect(manager.getPlugin('test-plugin')).toBeUndefined();
    });

    it('should return false for non-existent plugin', async () => {
      const result = await manager.unregister('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('load', () => {
    it('should load a registered plugin', async () => {
      const plugin: Plugin = {
        meta: {
          id: 'test-plugin',
          name: 'Test Plugin',
          version: '1.0.0',
        },
        hooks: {
          beforeWorkflowStart: async () => ({ continue: true }),
        },
      };

      await manager.register(plugin);
      const result = await manager.load('test-plugin');
      expect(result).toBe(true);
      expect(manager.getStatus('test-plugin')?.state).toBe('active');
    });

    it('should call init hook on load', async () => {
      const initFn = vi.fn();
      const plugin: Plugin = {
        meta: {
          id: 'test-plugin',
          name: 'Test Plugin',
          version: '1.0.0',
        },
        hooks: {
          beforeWorkflowStart: async () => ({ continue: true }),
        },
        init: initFn,
      };

      await manager.register(plugin);
      await manager.load('test-plugin');
      expect(initFn).toHaveBeenCalled();
    });

    it('should return false for non-existent plugin', async () => {
      const result = await manager.load('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('unload', () => {
    it('should unload a loaded plugin', async () => {
      const plugin: Plugin = {
        meta: {
          id: 'test-plugin',
          name: 'Test Plugin',
          version: '1.0.0',
        },
        hooks: {
          beforeWorkflowStart: async () => ({ continue: true }),
        },
      };

      await manager.register(plugin);
      await manager.load('test-plugin');
      const result = await manager.unload('test-plugin');
      expect(result).toBe(true);
      expect(manager.getStatus('test-plugin')?.state).toBe('unloaded');
    });

    it('should call destroy hook on unload', async () => {
      const destroyFn = vi.fn();
      const plugin: Plugin = {
        meta: {
          id: 'test-plugin',
          name: 'Test Plugin',
          version: '1.0.0',
        },
        hooks: {
          beforeWorkflowStart: async () => ({ continue: true }),
        },
        destroy: destroyFn,
      };

      await manager.register(plugin);
      await manager.load('test-plugin');
      await manager.unload('test-plugin');
      expect(destroyFn).toHaveBeenCalled();
    });
  });

  describe('enable/disable', () => {
    it('should enable a plugin', async () => {
      const plugin: Plugin = {
        meta: {
          id: 'test-plugin',
          name: 'Test Plugin',
          version: '1.0.0',
        },
        hooks: {
          beforeWorkflowStart: async () => ({ continue: true }),
        },
      };

      await manager.register(plugin);
      await manager.load('test-plugin');
      await manager.disable('test-plugin');
      await manager.enable('test-plugin');
      expect(manager.getStatus('test-plugin')?.enabled).toBe(true);
    });

    it('should disable a plugin', async () => {
      const plugin: Plugin = {
        meta: {
          id: 'test-plugin',
          name: 'Test Plugin',
          version: '1.0.0',
        },
        hooks: {
          beforeWorkflowStart: async () => ({ continue: true }),
        },
      };

      await manager.register(plugin);
      await manager.load('test-plugin');
      await manager.disable('test-plugin');
      expect(manager.getStatus('test-plugin')?.enabled).toBe(false);
    });
  });

  describe('executeHook', () => {
    it('should execute hook handlers', async () => {
      const handler = vi.fn(async () => ({ continue: true }));
      const plugin: Plugin = {
        meta: {
          id: 'test-plugin',
          name: 'Test Plugin',
          version: '1.0.0',
        },
        hooks: {
          beforeWorkflowStart: handler,
        },
      };

      await manager.register(plugin);
      await manager.load('test-plugin');

      const payload: BeforeWorkflowStartPayload = {
        workflow: createMockWorkflow(),
      };

      await manager.executeHook('beforeWorkflowStart', payload);
      expect(handler).toHaveBeenCalledWith(payload, expect.any(Object));
    });

    it('should stop execution when hook returns continue=false', async () => {
      const handler1 = vi.fn(async () => ({ continue: false }));
      const handler2 = vi.fn(async () => ({ continue: true }));

      const plugin1: Plugin = {
        meta: {
          id: 'plugin-1',
          name: 'Plugin 1',
          version: '1.0.0',
          priority: 'high',
        },
        hooks: {
          beforeWorkflowStart: handler1,
        },
      };

      const plugin2: Plugin = {
        meta: {
          id: 'plugin-2',
          name: 'Plugin 2',
          version: '1.0.0',
          priority: 'low',
        },
        hooks: {
          beforeWorkflowStart: handler2,
        },
      };

      await manager.register(plugin1);
      await manager.register(plugin2);
      await manager.load('plugin-1');
      await manager.load('plugin-2');

      const payload: BeforeWorkflowStartPayload = {
        workflow: createMockWorkflow(),
      };

      await manager.executeHook('beforeWorkflowStart', payload);
      expect(handler1).toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
    });

    it('should pass modified payload to next handler', async () => {
      const handler1 = vi.fn(async (payload: BeforeWorkflowStartPayload) => ({
        continue: true,
        data: {
          ...payload,
          workflow: { ...payload.workflow, name: 'Modified' },
        },
      }));
      const handler2 = vi.fn(async () => ({ continue: true }));

      const plugin1: Plugin = {
        meta: {
          id: 'plugin-1',
          name: 'Plugin 1',
          version: '1.0.0',
          priority: 'high',
        },
        hooks: {
          beforeWorkflowStart: handler1,
        },
      };

      const plugin2: Plugin = {
        meta: {
          id: 'plugin-2',
          name: 'Plugin 2',
          version: '1.0.0',
          priority: 'low',
        },
        hooks: {
          beforeWorkflowStart: handler2,
        },
      };

      await manager.register(plugin1);
      await manager.register(plugin2);
      await manager.load('plugin-1');
      await manager.load('plugin-2');

      const payload: BeforeWorkflowStartPayload = {
        workflow: createMockWorkflow(),
      };

      await manager.executeHook('beforeWorkflowStart', payload);
      expect(handler2).toHaveBeenCalledWith(
        expect.objectContaining({
          workflow: expect.objectContaining({ name: 'Modified' }),
        }),
        expect.any(Object)
      );
    });

    it('should execute hooks in priority order', async () => {
      const order: string[] = [];

      const plugin1: Plugin = {
        meta: {
          id: 'plugin-1',
          name: 'Plugin 1',
          version: '1.0.0',
          priority: 'low',
        },
        hooks: {
          beforeWorkflowStart: async () => {
            order.push('low');
            return { continue: true };
          },
        },
      };

      const plugin2: Plugin = {
        meta: {
          id: 'plugin-2',
          name: 'Plugin 2',
          version: '1.0.0',
          priority: 'high',
        },
        hooks: {
          beforeWorkflowStart: async () => {
            order.push('high');
            return { continue: true };
          },
        },
      };

      await manager.register(plugin1);
      await manager.register(plugin2);
      await manager.load('plugin-1');
      await manager.load('plugin-2');

      await manager.executeHook('beforeWorkflowStart', {
        workflow: createMockWorkflow(),
      });

      expect(order).toEqual(['high', 'low']);
    });
  });

  describe('getPlugins', () => {
    it('should return all registered plugins', async () => {
      const plugin1: Plugin = {
        meta: {
          id: 'plugin-1',
          name: 'Plugin 1',
          version: '1.0.0',
        },
        hooks: {
          beforeWorkflowStart: async () => ({ continue: true }),
        },
      };

      const plugin2: Plugin = {
        meta: {
          id: 'plugin-2',
          name: 'Plugin 2',
          version: '1.0.0',
        },
        hooks: {
          beforeWorkflowStart: async () => ({ continue: true }),
        },
      };

      await manager.register(plugin1);
      await manager.register(plugin2);

      const plugins = manager.getPlugins();
      expect(plugins).toHaveLength(2);
    });
  });

  describe('loadAll', () => {
    it('should load all registered plugins', async () => {
      const plugin1: Plugin = {
        meta: {
          id: 'plugin-1',
          name: 'Plugin 1',
          version: '1.0.0',
        },
        hooks: {
          beforeWorkflowStart: async () => ({ continue: true }),
        },
      };

      const plugin2: Plugin = {
        meta: {
          id: 'plugin-2',
          name: 'Plugin 2',
          version: '1.0.0',
        },
        hooks: {
          beforeWorkflowStart: async () => ({ continue: true }),
        },
      };

      await manager.register(plugin1);
      await manager.register(plugin2);
      await manager.loadAll();

      expect(manager.getStatus('plugin-1')?.state).toBe('active');
      expect(manager.getStatus('plugin-2')?.state).toBe('active');
    });
  });
});

describe('Built-in Plugins', () => {
  let manager: PluginManager;

  beforeEach(() => {
    manager = new PluginManager();
  });

  describe('loggingPlugin', () => {
    it('should be valid', () => {
      expect(loggingPlugin.meta.id).toBe('@polaris/plugin-logging');
      expect(loggingPlugin.meta.name).toBe('Logging Plugin');
      expect(loggingPlugin.hooks).toBeDefined();
    });

    it('should register and load', async () => {
      const result = await manager.register(loggingPlugin);
      expect(result).toBe(true);

      const loadResult = await manager.load('@polaris/plugin-logging');
      expect(loadResult).toBe(true);
    });
  });

  describe('metricsPlugin', () => {
    it('should be valid', () => {
      expect(metricsPlugin.meta.id).toBe('@polaris/plugin-metrics');
      expect(metricsPlugin.meta.name).toBe('Metrics Plugin');
      expect(metricsPlugin.init).toBeDefined();
    });

    it('should initialize metrics state', async () => {
      await manager.register(metricsPlugin);
      await manager.load('@polaris/plugin-metrics');

      const status = manager.getStatus('@polaris/plugin-metrics');
      expect(status?.state).toBe('active');
    });
  });

  describe('rateLimitPlugin', () => {
    it('should be valid', () => {
      expect(rateLimitPlugin.meta.id).toBe('@polaris/plugin-rate-limit');
      expect(rateLimitPlugin.meta.priority).toBe('highest');
    });

    it('should enforce workflow rate limits', async () => {
      await manager.register(rateLimitPlugin);
      await manager.load('@polaris/plugin-rate-limit');

      // Execute hooks up to the limit
      for (let i = 0; i < 10; i++) {
        await manager.executeHook('beforeWorkflowStart', {
          workflow: createMockWorkflow({ id: `workflow-${i}` }),
        });
      }

      // Next one should fail
      const result = await manager.executeHook('beforeWorkflowStart', {
        workflow: createMockWorkflow({ id: 'workflow-11' }),
      });

      expect(result.continue).toBe(false);
    });
  });

  describe('cachingPlugin', () => {
    it('should be valid', () => {
      expect(cachingPlugin.meta.id).toBe('@polaris/plugin-caching');
    });

    it('should cache node results', async () => {
      await manager.register(cachingPlugin);
      await manager.load('@polaris/plugin-caching');

      const workflow = createMockWorkflow();
      const node = createMockNode({
        config: { cacheable: true, cacheTTL: 60000 },
      });

      // Simulate first execution
      await manager.executeHook('beforeNodeExecute', {
        workflow,
        node,
      });

      await manager.executeHook('afterNodeExecute', {
        workflow,
        node,
        success: true,
        duration: 100,
        output: { result: 'cached-data' },
      });

      // Second execution should hit cache
      const result = await manager.executeHook('beforeNodeExecute', {
        workflow,
        node,
      });

      expect(result.continue).toBe(false);
      expect(result.data).toEqual({ result: 'cached-data' });
    });
  });

  describe('getBuiltinPlugins', () => {
    it('should return all built-in plugins', () => {
      const plugins = getBuiltinPlugins();
      expect(plugins).toHaveLength(4);
      expect(plugins.map((p) => p.meta.id)).toContain('@polaris/plugin-logging');
      expect(plugins.map((p) => p.meta.id)).toContain('@polaris/plugin-metrics');
      expect(plugins.map((p) => p.meta.id)).toContain('@polaris/plugin-rate-limit');
      expect(plugins.map((p) => p.meta.id)).toContain('@polaris/plugin-caching');
    });
  });
});

describe('Plugin Integration', () => {
  it('should work with multiple plugins', async () => {
    const manager = new PluginManager();

    // Register all built-in plugins
    for (const plugin of getBuiltinPlugins()) {
      await manager.register(plugin);
    }

    await manager.loadAll();

    const workflow = createMockWorkflow();
    const node = createMockNode({ config: { cacheable: true } });

    // Execute workflow lifecycle hooks
    await manager.executeHook('beforeWorkflowStart', { workflow });
    await manager.executeHook('beforeNodeExecute', { workflow, node });
    await manager.executeHook('afterNodeExecute', {
      workflow,
      node,
      success: true,
      duration: 100,
    });
    await manager.executeHook('afterWorkflowComplete', {
      workflow,
      success: true,
      duration: 200,
    });

    // Check all plugins are active
    const statuses = manager.getAllStatuses();
    expect(statuses.every((s) => s.state === 'active')).toBe(true);
  });
});

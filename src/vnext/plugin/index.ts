/**
 * Plugin Manager for Polaris Scheduler vNext
 *
 * Manages plugin lifecycle, registration, and hook execution
 */

import type {
  Plugin,
  PluginContext,
  PluginHook,
  PluginHooks,
  PluginManagerConfig,
  PluginPriority,
  PluginState,
  PluginStatus,
  HookResult,
  PluginLogger,
} from './types';

/**
 * Default console logger
 */
const defaultLogger: PluginLogger = {
  debug: (message, ...args) => console.debug(`[Plugin] ${message}`, ...args),
  info: (message, ...args) => console.info(`[Plugin] ${message}`, ...args),
  warn: (message, ...args) => console.warn(`[Plugin] ${message}`, ...args),
  error: (message, ...args) => console.error(`[Plugin] ${message}`, ...args),
};

/**
 * Priority weights for hook execution order
 */
const PRIORITY_WEIGHTS: Record<PluginPriority, number> = {
  lowest: 1,
  low: 2,
  normal: 3,
  high: 4,
  highest: 5,
};

/**
 * Plugin Manager
 *
 * Handles plugin registration, lifecycle, and hook execution
 */
export class PluginManager {
  private plugins: Map<string, Plugin> = new Map();
  private statuses: Map<string, PluginStatus> = new Map();
  private contexts: Map<string, PluginContext> = new Map();
  private config: PluginManagerConfig;
  private runtime: unknown;

  constructor(config: PluginManagerConfig = {}) {
    this.config = {
      maxPlugins: 100,
      hotReload: false,
      logger: defaultLogger,
      ...config,
    };
  }

  /**
   * Set the runtime reference
   */
  setRuntime(runtime: unknown): void {
    this.runtime = runtime;
  }

  /**
   * Register a plugin
   */
  async register(plugin: Plugin): Promise<boolean> {
    const { meta } = plugin;

    // Check if already registered
    if (this.plugins.has(meta.id)) {
      this.log('warn', `Plugin ${meta.id} is already registered`);
      return false;
    }

    // Check max plugins limit
    if (this.plugins.size >= (this.config.maxPlugins || 100)) {
      this.log('error', 'Maximum number of plugins reached');
      return false;
    }

    // Validate plugin
    const validation = this.validatePlugin(plugin);
    if (!validation.valid) {
      this.log('error', `Plugin validation failed: ${validation.error}`);
      return false;
    }

    // Register plugin
    this.plugins.set(meta.id, plugin);
    this.statuses.set(meta.id, {
      id: meta.id,
      state: 'unloaded',
      enabled: meta.enabled ?? true,
    });

    this.log('info', `Plugin ${meta.id} registered successfully`);
    return true;
  }

  /**
   * Unregister a plugin
   */
  async unregister(pluginId: string): Promise<boolean> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      return false;
    }

    // Destroy plugin if active
    const status = this.statuses.get(pluginId);
    if (status?.state === 'active') {
      await this.deactivate(pluginId);
    }

    // Remove plugin
    this.plugins.delete(pluginId);
    this.statuses.delete(pluginId);
    this.contexts.delete(pluginId);

    this.log('info', `Plugin ${pluginId} unregistered`);
    return true;
  }

  /**
   * Load a plugin
   */
  async load(pluginId: string): Promise<boolean> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      this.log('error', `Plugin ${pluginId} not found`);
      return false;
    }

    const status = this.statuses.get(pluginId);
    if (!status) {
      return false;
    }

    // Update state
    this.updateStatus(pluginId, 'loading');

    try {
      // Create context
      const context = this.createContext(plugin);
      this.contexts.set(pluginId, context);

      // Call init if present
      if (plugin.init) {
        await plugin.init(context);
      }

      // Update state
      this.updateStatus(pluginId, 'loaded', { loadTime: Date.now() });
      this.log('info', `Plugin ${pluginId} loaded`);

      // Auto-activate if enabled
      if (status.enabled) {
        await this.activate(pluginId);
      }

      return true;
    } catch (error) {
      this.updateStatus(pluginId, 'error', { error: error as Error });
      this.log('error', `Failed to load plugin ${pluginId}:`, error);
      return false;
    }
  }

  /**
   * Unload a plugin
   */
  async unload(pluginId: string): Promise<boolean> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      return false;
    }

    const status = this.statuses.get(pluginId);
    if (!status || status.state !== 'active') {
      return false;
    }

    this.updateStatus(pluginId, 'unloading');

    try {
      // Call destroy if present
      const context = this.contexts.get(pluginId);
      if (plugin.destroy && context) {
        await plugin.destroy(context);
      }

      this.contexts.delete(pluginId);
      this.updateStatus(pluginId, 'unloaded');
      this.log('info', `Plugin ${pluginId} unloaded`);
      return true;
    } catch (error) {
      this.updateStatus(pluginId, 'error', { error: error as Error });
      this.log('error', `Failed to unload plugin ${pluginId}:`, error);
      return false;
    }
  }

  /**
   * Activate a plugin
   */
  async activate(pluginId: string): Promise<boolean> {
    const status = this.statuses.get(pluginId);
    if (!status) {
      return false;
    }

    if (status.state === 'active') {
      return true;
    }

    if (status.state !== 'loaded') {
      this.log('error', `Plugin ${pluginId} must be loaded before activation`);
      return false;
    }

    this.updateStatus(pluginId, 'active');
    this.log('info', `Plugin ${pluginId} activated`);
    return true;
  }

  /**
   * Deactivate a plugin
   */
  async deactivate(pluginId: string): Promise<boolean> {
    const status = this.statuses.get(pluginId);
    if (!status || status.state !== 'active') {
      return false;
    }

    this.updateStatus(pluginId, 'loaded');
    this.log('info', `Plugin ${pluginId} deactivated`);
    return true;
  }

  /**
   * Enable a plugin
   */
  async enable(pluginId: string): Promise<boolean> {
    const status = this.statuses.get(pluginId);
    if (!status) {
      return false;
    }

    status.enabled = true;

    if (status.state === 'loaded') {
      await this.activate(pluginId);
    }

    this.log('info', `Plugin ${pluginId} enabled`);
    return true;
  }

  /**
   * Disable a plugin
   */
  async disable(pluginId: string): Promise<boolean> {
    const status = this.statuses.get(pluginId);
    if (!status) {
      return false;
    }

    status.enabled = false;

    if (status.state === 'active') {
      await this.deactivate(pluginId);
    }

    this.log('info', `Plugin ${pluginId} disabled`);
    return true;
  }

  /**
   * Execute a hook
   */
  async executeHook<H extends PluginHook>(
    hook: H,
    payload: unknown
  ): Promise<HookResult> {
    const handlers = this.getHookHandlers(hook);

    if (handlers.length === 0) {
      return { continue: true, data: payload };
    }

    let currentPayload = payload;

    for (const { pluginId, handler } of handlers) {
      const context = this.contexts.get(pluginId);
      if (!context) {
        continue;
      }

      try {
        const result = await handler!(currentPayload as never, context);

        if (!result.continue) {
          return result;
        }

        if (result.data !== undefined) {
          currentPayload = result.data;
        }
      } catch (error) {
        this.log('error', `Hook ${hook} failed in plugin ${pluginId}:`, error);
        return { continue: false, error: error as Error };
      }
    }

    return { continue: true, data: currentPayload };
  }

  /**
   * Get all registered plugins
   */
  getPlugins(): Plugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Get plugin by ID
   */
  getPlugin(pluginId: string): Plugin | undefined {
    return this.plugins.get(pluginId);
  }

  /**
   * Get plugin status
   */
  getStatus(pluginId: string): PluginStatus | undefined {
    return this.statuses.get(pluginId);
  }

  /**
   * Get all plugin statuses
   */
  getAllStatuses(): PluginStatus[] {
    return Array.from(this.statuses.values());
  }

  /**
   * Check if a plugin is active
   */
  isActive(pluginId: string): boolean {
    const status = this.statuses.get(pluginId);
    return status?.state === 'active';
  }

  /**
   * Load all registered plugins
   */
  async loadAll(): Promise<void> {
    const loadPromises = Array.from(this.plugins.keys()).map((id) =>
      this.load(id)
    );
    await Promise.all(loadPromises);
  }

  /**
   * Unload all plugins
   */
  async unloadAll(): Promise<void> {
    const unloadPromises = Array.from(this.plugins.keys()).map((id) =>
      this.unload(id)
    );
    await Promise.all(unloadPromises);
  }

  // Private methods

  private validatePlugin(plugin: Plugin): { valid: boolean; error?: string } {
    if (!plugin.meta?.id) {
      return { valid: false, error: 'Plugin must have a meta.id' };
    }

    if (!plugin.meta?.name) {
      return { valid: false, error: 'Plugin must have a meta.name' };
    }

    if (!plugin.meta?.version) {
      return { valid: false, error: 'Plugin must have a meta.version' };
    }

    if (!plugin.hooks || Object.keys(plugin.hooks).length === 0) {
      return { valid: false, error: 'Plugin must have at least one hook' };
    }

    return { valid: true };
  }

  private createContext(plugin: Plugin): PluginContext {
    return {
      config: {
        ...plugin.defaultConfig,
      },
      runtime: this.runtime as never,
      logger: this.createPluginLogger(plugin.meta.id),
      state: new Map(),
    };
  }

  private createPluginLogger(pluginId: string): PluginLogger {
    const logger = this.config.logger || defaultLogger;
    return {
      debug: (message, ...args) =>
        logger.debug(`[${pluginId}] ${message}`, ...args),
      info: (message, ...args) =>
        logger.info(`[${pluginId}] ${message}`, ...args),
      warn: (message, ...args) =>
        logger.warn(`[${pluginId}] ${message}`, ...args),
      error: (message, ...args) =>
        logger.error(`[${pluginId}] ${message}`, ...args),
    };
  }

  private updateStatus(
    pluginId: string,
    state: PluginState,
    updates?: Partial<PluginStatus>
  ): void {
    const status = this.statuses.get(pluginId);
    if (status) {
      this.statuses.set(pluginId, { ...status, state, ...updates });
    }
  }

  private getHookHandlers(hook: PluginHook): Array<{
    pluginId: string;
    handler: PluginHooks[PluginHook];
  }> {
    const handlers: Array<{
      pluginId: string;
      handler: PluginHooks[PluginHook];
      priority: number;
    }> = [];

    for (const [pluginId, plugin] of this.plugins) {
      const status = this.statuses.get(pluginId);
      if (status?.state !== 'active') {
        continue;
      }

      const handler = plugin.hooks[hook];
      if (handler) {
        handlers.push({
          pluginId,
          handler,
          priority: PRIORITY_WEIGHTS[plugin.meta.priority || 'normal'],
        });
      }
    }

    // Sort by priority (higher first)
    return handlers
      .sort((a, b) => b.priority - a.priority)
      .map(({ pluginId, handler }) => ({ pluginId, handler }));
  }

  private log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    ...args: unknown[]
  ): void {
    const logger = this.config.logger || defaultLogger;
    logger[level](message, ...args);
  }
}

export * from './types';
export * from './builtin';

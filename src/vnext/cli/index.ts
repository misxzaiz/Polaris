/**
 * CLI Tool for Polaris Scheduler vNext
 * @module vnext/cli
 */

import type {
  CLICommand,
  CLIOptions,
  CLIResult,
  CLIContext,
  CLIConfig,
  CLICommandDefinition,
  WorkflowTemplate,
  MonitorData,
  TableOptions,
  TableColumn,
} from './types';
import {
  DEFAULT_CLI_CONFIG,
  BUILTIN_TEMPLATES,
} from './types';
import { WorkflowRuntime } from '../runtime';
import { getWorkflowPersistence } from '../persistence';
import type { Workflow, WorkflowNode, WorkflowStatus } from '../types';

/**
 * Format table output
 */
export function formatTable(data: Record<string, unknown>[], options: TableOptions): string {
  if (data.length === 0) {
    return 'No data';
  }

  const { columns, showHeaders = true, showBorders = true, showRowNumbers = false } = options;

  // Calculate column widths
  const widths: number[] = columns.map((col, index) => {
    const headerWidth = col.header.length;
    const dataWidth = Math.max(
      ...data.map((row) => {
        const value = row[col.property];
        const formatted = col.format ? col.format(value) : String(value ?? '');
        return formatted.length;
      })
    );
    return Math.max(headerWidth, dataWidth, col.width ?? 0);
  });

  const lines: string[] = [];

  // Build separator
  const separator = showBorders
    ? '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+'
    : '';

  // Build header
  if (showHeaders) {
    if (separator) lines.push(separator);
    const headerCells = columns.map((col, index) => {
      const align = col.align ?? 'left';
      const width = widths[index];
      const text = col.header;
      return align === 'right'
        ? text.padStart(width)
        : align === 'center'
        ? text.padStart((width + text.length) / 2).padEnd(width)
        : text.padEnd(width);
    });
    const headerLine = showBorders
      ? '| ' + headerCells.join(' | ') + ' |'
      : headerCells.join('  ');
    lines.push(headerLine);
    if (separator) lines.push(separator);
  }

  // Build rows
  data.forEach((row, rowIndex) => {
    const cells = columns.map((col, colIndex) => {
      const value = row[col.property];
      const formatted = col.format ? col.format(value) : String(value ?? '');
      const width = widths[colIndex];
      const align = col.align ?? 'left';

      return align === 'right'
        ? formatted.padStart(width)
        : align === 'center'
        ? formatted.padStart((width + formatted.length) / 2).padEnd(width)
        : formatted.padEnd(width);
    });

    if (showRowNumbers) {
      cells.unshift(String(rowIndex + 1).padStart(3));
    }

    const rowLine = showBorders
      ? '| ' + cells.join(' | ') + ' |'
      : cells.join('  ');
    lines.push(rowLine);
  });

  if (separator) lines.push(separator);

  return lines.join('\n');
}

/**
 * Format JSON output
 */
export function formatJSON(data: unknown, pretty = true): string {
  return pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
}

/**
 * Format YAML output (simplified)
 */
export function formatYAML(data: unknown, indent = 0): string {
  if (data === null || data === undefined) {
    return 'null';
  }

  if (typeof data === 'string') {
    return data.includes('\n') ? `|\n${data.split('\n').map((l) => '  ' + l).join('\n')}` : data;
  }

  if (typeof data === 'number' || typeof data === 'boolean') {
    return String(data);
  }

  if (Array.isArray(data)) {
    if (data.length === 0) return '[]';
    return data
      .map((item) => {
        const formatted = formatYAML(item, indent + 2);
        return '- ' + formatted.split('\n').join('\n  ');
      })
      .join('\n');
  }

  if (typeof data === 'object') {
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    const indentStr = '  '.repeat(indent);
    return entries
      .map(([key, value]) => {
        const formatted = formatYAML(value, indent + 1);
        return `${indentStr}${key}: ${formatted}`;
      })
      .join('\n');
  }

  return String(data);
}

/**
 * Format status badge
 */
export function formatStatusBadge(status: WorkflowStatus): string {
  const badges: Record<WorkflowStatus, string> = {
    idle: '[IDLE]',
    running: '[RUNNING]',
    paused: '[PAUSED]',
    completed: '[COMPLETED]',
    failed: '[FAILED]',
    cancelled: '[CANCELLED]',
  };
  return badges[status] || '[UNKNOWN]';
}

/**
 * Format duration
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

/**
 * Format relative time
 */
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

/**
 * CLI Tool implementation
 */
export class CLITool {
  private runtime: WorkflowRuntime;
  private persistence: ReturnType<typeof getWorkflowPersistence>;
  private config: CLIConfig;
  private context: CLIContext;
  private commandRegistry: Map<CLICommand, CLICommandDefinition>;

  constructor(runtime: WorkflowRuntime, config: Partial<CLIConfig> = {}) {
    this.runtime = runtime;
    this.persistence = getWorkflowPersistence();
    this.config = { ...DEFAULT_CLI_CONFIG, ...config };
    this.context = this.createContext();
    this.commandRegistry = new Map();
    this.registerCommands();
  }

  private createContext(): CLIContext {
    return {
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
      history: [],
      stdout: process.stdout,
      stderr: process.stderr,
    };
  }

  private registerCommands(): void {
    const commands: CLICommandDefinition[] = [
      {
        name: 'create',
        description: 'Create a new workflow',
        usage: 'create --name <name> [--template <template>]',
        examples: ['create --name my-workflow', 'create --name my-workflow --template dev-pipeline'],
        handler: this.handleCreate.bind(this),
      },
      {
        name: 'list',
        aliases: ['ls'],
        description: 'List all workflows',
        usage: 'list [--format <format>]',
        handler: this.handleList.bind(this),
      },
      {
        name: 'show',
        description: 'Show workflow details',
        usage: 'show --id <workflow-id>',
        handler: this.handleShow.bind(this),
      },
      {
        name: 'start',
        description: 'Start a workflow',
        usage: 'start --id <workflow-id>',
        handler: this.handleStart.bind(this),
      },
      {
        name: 'pause',
        description: 'Pause a workflow',
        usage: 'pause --id <workflow-id>',
        handler: this.handlePause.bind(this),
      },
      {
        name: 'resume',
        description: 'Resume a paused workflow',
        usage: 'resume --id <workflow-id>',
        handler: this.handleResume.bind(this),
      },
      {
        name: 'stop',
        description: 'Stop a workflow',
        usage: 'stop --id <workflow-id> [--force]',
        handler: this.handleStop.bind(this),
      },
      {
        name: 'delete',
        aliases: ['rm'],
        description: 'Delete a workflow',
        usage: 'delete --id <workflow-id> [--force]',
        handler: this.handleDelete.bind(this),
      },
      {
        name: 'run',
        description: 'Create and run a workflow in one command',
        usage: 'run --name <name> [--template <template>]',
        handler: this.handleRun.bind(this),
      },
      {
        name: 'status',
        description: 'Get workflow status',
        usage: 'status --id <workflow-id>',
        handler: this.handleStatus.bind(this),
      },
      {
        name: 'monitor',
        description: 'Monitor workflow execution',
        usage: 'monitor [--watch] [--interval <ms>]',
        handler: this.handleMonitor.bind(this),
      },
      {
        name: 'template',
        description: 'List available templates',
        usage: 'template [--format <format>]',
        handler: this.handleTemplate.bind(this),
      },
      {
        name: 'help',
        aliases: ['?'],
        description: 'Show help information',
        usage: 'help [command]',
        handler: this.handleHelp.bind(this),
      },
      {
        name: 'version',
        aliases: ['v'],
        description: 'Show version information',
        usage: 'version',
        handler: this.handleVersion.bind(this),
      },
    ];

    commands.forEach((cmd) => this.commandRegistry.set(cmd.name, cmd));
  }

  /**
   * Execute a CLI command
   */
  async execute(command: CLICommand, options: CLIOptions = {}): Promise<CLIResult> {
    const definition = this.commandRegistry.get(command);
    if (!definition) {
      return {
        success: false,
        error: `Unknown command: ${command}`,
        exitCode: 1,
      };
    }

    // Record in history
    const historyEntry = {
      id: `cmd-${Date.now()}`,
      command,
      options,
      timestamp: Date.now(),
    };
    this.context.history.push(historyEntry);

    try {
      const result = await definition.handler(options, this.context);
      historyEntry.result = result;
      return result;
    } catch (error) {
      const result: CLIResult = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        exitCode: 1,
      };
      historyEntry.result = result;
      return result;
    }
  }

  /**
   * Format output based on options
   */
  formatOutput(data: unknown, format?: 'json' | 'table' | 'yaml'): string {
    const outputFormat = format ?? this.config.defaultFormat;

    switch (outputFormat) {
      case 'json':
        return formatJSON(data);
      case 'yaml':
        return formatYAML(data);
      case 'table':
      default:
        if (Array.isArray(data)) {
          return formatTable(data as Record<string, unknown>[], {
            columns: Object.keys(data[0] || {}).map((key) => ({
              header: key.toUpperCase(),
              property: key,
            })),
          });
        }
        return formatJSON(data);
    }
  }

  // Command handlers

  private async handleCreate(options: CLIOptions): Promise<CLIResult> {
    if (!options.name) {
      return { success: false, error: 'Workflow name is required', exitCode: 1 };
    }

    let template: WorkflowTemplate | undefined;
    if (options.template) {
      template = BUILTIN_TEMPLATES.find((t) => t.id === options.template);
      if (!template) {
        return { success: false, error: `Template not found: ${options.template}`, exitCode: 1 };
      }
    }

    const nodes: WorkflowNode[] = ((template?.nodes || []) as WorkflowNode[]).map((n, i) => ({
      id: n.id || `node-${i}`,
      name: n.name || `Node ${i}`,
      type: n.type || 'task',
      status: 'pending' as const,
      dependencies: n.dependencies || [],
      profileId: n.profileId || 'default',
    }));

    const workflow: Workflow = {
      id: options.id || `workflow-${Date.now()}`,
      name: options.name,
      description: options.description || template?.description || '',
      version: '1.0.0',
      status: 'idle',
      priority: options.priority || template?.workflow.priority || 'normal',
      nodes,
      edges: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Store in persistence
    this.persistence.registerWorkflow(workflow, nodes);

    return {
      success: true,
      message: `Workflow created: ${workflow.id}`,
      data: workflow,
      exitCode: 0,
    };
  }

  private async handleList(options: CLIOptions): Promise<CLIResult> {
    const workflowIds = this.persistence.getWorkflowIds();
    const workflows = workflowIds
      .map((id) => this.persistence.getWorkflow(id))
      .filter((w): w is Workflow => w !== undefined);

    if (options.format === 'json') {
      return { success: true, data: workflows, exitCode: 0 };
    }

    const data = workflows.map((w) => ({
      id: w.id,
      name: w.name,
      status: w.status,
      priority: w.priority,
      nodes: w.nodes?.length || 0,
      created: formatRelativeTime(w.createdAt),
    }));

    return {
      success: true,
      data,
      message: this.formatOutput(data, options.format),
      exitCode: 0,
    };
  }

  private async handleShow(options: CLIOptions): Promise<CLIResult> {
    if (!options.id) {
      return { success: false, error: 'Workflow ID is required', exitCode: 1 };
    }

    const workflow = this.persistence.getWorkflow(options.id);
    if (!workflow) {
      return { success: false, error: `Workflow not found: ${options.id}`, exitCode: 1 };
    }

    return {
      success: true,
      data: workflow,
      message: this.formatOutput(workflow, options.format),
      exitCode: 0,
    };
  }

  private async handleStart(options: CLIOptions): Promise<CLIResult> {
    if (!options.id) {
      return { success: false, error: 'Workflow ID is required', exitCode: 1 };
    }

    const workflow = this.persistence.getWorkflow(options.id);
    if (!workflow) {
      return { success: false, error: `Workflow not found: ${options.id}`, exitCode: 1 };
    }

    // Register to runtime and start
    this.runtime.registerWorkflow({
      workflow,
      nodes: workflow.nodes || [],
    });

    await this.runtime.start();

    return {
      success: true,
      message: `Workflow started: ${options.id}`,
      exitCode: 0,
    };
  }

  private async handlePause(options: CLIOptions): Promise<CLIResult> {
    const paused = this.runtime.pause();

    if (!paused) {
      return { success: false, error: 'Cannot pause workflow', exitCode: 1 };
    }

    return {
      success: true,
      message: 'Workflow paused',
      exitCode: 0,
    };
  }

  private async handleResume(_options: CLIOptions): Promise<CLIResult> {
    try {
      await this.runtime.resume();

      return {
        success: true,
        message: 'Workflow resumed',
        exitCode: 0,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Cannot resume workflow',
        exitCode: 1,
      };
    }
  }

  private async handleStop(_options: CLIOptions): Promise<CLIResult> {
    const stopped = this.runtime.stop();

    if (!stopped) {
      return { success: false, error: 'Cannot stop workflow', exitCode: 1 };
    }

    return {
      success: true,
      message: 'Workflow stopped',
      exitCode: 0,
    };
  }

  private async handleDelete(options: CLIOptions): Promise<CLIResult> {
    if (!options.id) {
      return { success: false, error: 'Workflow ID is required', exitCode: 1 };
    }

    const workflow = this.persistence.getWorkflow(options.id);
    if (!workflow) {
      return { success: false, error: `Workflow not found: ${options.id}`, exitCode: 1 };
    }

    // Remove from persistence
    this.persistence.removeWorkflow(options.id);

    return {
      success: true,
      message: `Workflow deleted: ${options.id}`,
      exitCode: 0,
    };
  }

  private async handleRun(options: CLIOptions): Promise<CLIResult> {
    // Create workflow first
    const createResult = await this.handleCreate(options);
    if (!createResult.success || !createResult.data) {
      return createResult;
    }

    const workflow = createResult.data as Workflow;

    // Register to runtime and start
    this.runtime.registerWorkflow({
      workflow,
      nodes: workflow.nodes || [],
    });

    await this.runtime.start();

    return {
      success: true,
      message: `Workflow created and started: ${workflow.id}`,
      data: workflow,
      exitCode: 0,
    };
  }

  private async handleStatus(options: CLIOptions): Promise<CLIResult> {
    if (!options.id) {
      return { success: false, error: 'Workflow ID is required', exitCode: 1 };
    }

    const workflow = this.persistence.getWorkflow(options.id);
    if (!workflow) {
      return { success: false, error: `Workflow not found: ${options.id}`, exitCode: 1 };
    }

    const nodes = workflow.nodes || [];
    const status = {
      id: workflow.id,
      name: workflow.name,
      status: workflow.status,
      priority: workflow.priority,
      nodes: {
        total: nodes.length,
        completed: nodes.filter((n) => n.status === 'completed').length,
        running: nodes.filter((n) => n.status === 'running').length,
        pending: nodes.filter((n) => n.status === 'pending').length,
        failed: nodes.filter((n) => n.status === 'failed').length,
      },
    };

    return {
      success: true,
      data: status,
      message: this.formatOutput(status, options.format),
      exitCode: 0,
    };
  }

  private async handleMonitor(options: CLIOptions): Promise<CLIResult> {
    const workflowIds = this.persistence.getWorkflowIds();
    const workflows = workflowIds
      .map((id) => this.persistence.getWorkflow(id))
      .filter((w): w is Workflow => w !== undefined);

    const monitorData: MonitorData = {
      timestamp: Date.now(),
      activeWorkflows: workflows.filter((w) => w.status === 'running').length,
      runningNodes: workflows.reduce(
        (sum, w) => sum + (w.nodes || []).filter((n) => n.status === 'running').length,
        0
      ),
      pendingNodes: workflows.reduce(
        (sum, w) => sum + (w.nodes || []).filter((n) => n.status === 'pending').length,
        0
      ),
      completedNodes: workflows.reduce(
        (sum, w) => sum + (w.nodes || []).filter((n) => n.status === 'completed').length,
        0
      ),
      failedNodes: workflows.reduce(
        (sum, w) => sum + (w.nodes || []).filter((n) => n.status === 'failed').length,
        0
      ),
      totalTokens: 0,
      estimatedCost: 0,
      workflows: workflows.map((w) => {
        const nodes = w.nodes || [];
        return {
          id: w.id,
          name: w.name,
          status: w.status,
          progress: nodes.length > 0
            ? Math.round((nodes.filter((n) => n.status === 'completed').length / nodes.length) * 100)
            : 0,
          tokens: 0,
          cost: 0,
          duration: w.startedAt ? Date.now() - w.startedAt : 0,
        };
      }),
    };

    return {
      success: true,
      data: monitorData,
      message: this.formatOutput(monitorData, options.format),
      exitCode: 0,
    };
  }

  private async handleTemplate(options: CLIOptions): Promise<CLIResult> {
    const templates = BUILTIN_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      category: t.category,
      nodes: t.nodes?.length || 0,
    }));

    return {
      success: true,
      data: templates,
      message: this.formatOutput(templates, options.format),
      exitCode: 0,
    };
  }

  private async handleHelp(options: CLIOptions): Promise<CLIResult> {
    const commands = Array.from(this.commandRegistry.values());

    const lines: string[] = [
      'Polaris Scheduler vNext CLI',
      '',
      'Usage: polaris <command> [options]',
      '',
      'Commands:',
    ];

    commands.forEach((cmd) => {
      const aliases = cmd.aliases ? ` (${cmd.aliases.join(', ')})` : '';
      lines.push(`  ${cmd.name}${aliases.padEnd(15)} - ${cmd.description}`);
    });

    lines.push('', 'Options:');
    lines.push('  --id <id>          Workflow ID');
    lines.push('  --name <name>      Workflow name');
    lines.push('  --template <id>    Template ID');
    lines.push('  --format <format>  Output format (json, table, yaml)');
    lines.push('  --verbose          Verbose output');
    lines.push('  --force            Force operation');

    return {
      success: true,
      message: lines.join('\n'),
      exitCode: 0,
    };
  }

  private async handleVersion(): Promise<CLIResult> {
    return {
      success: true,
      message: 'Polaris Scheduler vNext v1.0.0',
      exitCode: 0,
    };
  }

  /**
   * Get command registry
   */
  getCommands(): CLICommandDefinition[] {
    return Array.from(this.commandRegistry.values());
  }

  /**
   * Get runtime instance
   */
  getRuntime(): WorkflowRuntime {
    return this.runtime;
  }

  /**
   * Get config
   */
  getConfig(): CLIConfig {
    return { ...this.config };
  }

  /**
   * Get context
   */
  getContext(): CLIContext {
    return { ...this.context };
  }

  /**
   * Get history
   */
  getHistory(): CLIContext['history'] {
    return [...this.context.history];
  }
}

/**
 * Create CLI tool instance
 */
export function createCLITool(runtime: WorkflowRuntime, config?: Partial<CLIConfig>): CLITool {
  return new CLITool(runtime, config);
}

// Re-export types
export * from './types';

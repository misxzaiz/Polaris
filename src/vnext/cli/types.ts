/**
 * CLI Types for Polaris Scheduler vNext
 * @module vnext/cli
 */

import type { Workflow, WorkflowNode, AgentProfile } from '../types';

/**
 * CLI command types
 */
export type CLICommand =
  | 'create'
  | 'list'
  | 'show'
  | 'start'
  | 'pause'
  | 'resume'
  | 'stop'
  | 'delete'
  | 'run'
  | 'status'
  | 'monitor'
  | 'template'
  | 'help'
  | 'version';

/**
 * CLI command options
 */
export interface CLIOptions {
  /** Workflow ID */
  id?: string;
  /** Workflow name */
  name?: string;
  /** Workflow description */
  description?: string;
  /** Template to use */
  template?: string;
  /** Priority level */
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  /** Output format */
  format?: 'json' | 'table' | 'yaml';
  /** Verbose output */
  verbose?: boolean;
  /** Dry run mode */
  dryRun?: boolean;
  /** Watch mode for monitor */
  watch?: boolean;
  /** Interval for watch mode (ms) */
  interval?: number;
  /** File path for import/export */
  file?: string;
  /** Force operation */
  force?: boolean;
}

/**
 * CLI command result
 */
export interface CLIResult {
  /** Success flag */
  success: boolean;
  /** Result message */
  message?: string;
  /** Result data */
  data?: unknown;
  /** Error message */
  error?: string;
  /** Exit code */
  exitCode: number;
}

/**
 * Workflow template definition
 */
export interface WorkflowTemplate {
  /** Template ID */
  id: string;
  /** Template name */
  name: string;
  /** Template description */
  description: string;
  /** Template category */
  category: 'development' | 'testing' | 'deployment' | 'custom';
  /** Default workflow definition */
  workflow: Partial<Workflow>;
  /** Default nodes */
  nodes?: Partial<WorkflowNode>[];
  /** Default profiles */
  profiles?: AgentProfile[];
}

/**
 * CLI context
 */
export interface CLIContext {
  /** Current working directory */
  cwd: string;
  /** Configuration file path */
  configPath?: string;
  /** Environment variables */
  env: Record<string, string>;
  /** Command history */
  history: CLIHistoryEntry[];
  /** Output stream */
  stdout: NodeJS.WritableStream;
  /** Error stream */
  stderr: NodeJS.WritableStream;
}

/**
 * CLI history entry
 */
export interface CLIHistoryEntry {
  /** Entry ID */
  id: string;
  /** Command executed */
  command: string;
  /** Options used */
  options: CLIOptions;
  /** Timestamp */
  timestamp: number;
  /** Result */
  result?: CLIResult;
}

/**
 * CLI configuration
 */
export interface CLIConfig {
  /** Default output format */
  defaultFormat: 'json' | 'table' | 'yaml';
  /** Default priority */
  defaultPriority: 'low' | 'normal' | 'high' | 'urgent';
  /** Auto-save interval (ms) */
  autoSaveInterval: number;
  /** History file path */
  historyPath: string;
  /** Max history entries */
  maxHistoryEntries: number;
  /** Enable colors */
  colors: boolean;
  /** Enable timestamps */
  timestamps: boolean;
}

/**
 * CLI command handler
 */
export type CLICommandHandler = (
  options: CLIOptions,
  context: CLIContext
) => Promise<CLIResult>;

/**
 * CLI command definition
 */
export interface CLICommandDefinition {
  /** Command name */
  name: CLICommand;
  /** Command aliases */
  aliases?: string[];
  /** Command description */
  description: string;
  /** Command usage */
  usage: string;
  /** Command examples */
  examples?: string[];
  /** Command handler */
  handler: CLICommandHandler;
  /** Subcommands */
  subcommands?: CLICommandDefinition[];
}

/**
 * Table column definition
 */
export interface TableColumn {
  /** Column header */
  header: string;
  /** Property to display */
  property: string;
  /** Column width */
  width?: number;
  /** Alignment */
  align?: 'left' | 'center' | 'right';
  /** Formatter function */
  format?: (value: unknown) => string;
}

/**
 * Table output options
 */
export interface TableOptions {
  /** Columns to display */
  columns: TableColumn[];
  /** Show headers */
  showHeaders?: boolean;
  /** Show borders */
  showBorders?: boolean;
  /** Show row numbers */
  showRowNumbers?: boolean;
}

/**
 * Monitor output data
 */
export interface MonitorData {
  /** Timestamp */
  timestamp: number;
  /** Active workflows */
  activeWorkflows: number;
  /** Running nodes */
  runningNodes: number;
  /** Pending nodes */
  pendingNodes: number;
  /** Completed nodes */
  completedNodes: number;
  /** Failed nodes */
  failedNodes: number;
  /** Total token usage */
  totalTokens: number;
  /** Estimated cost */
  estimatedCost: number;
  /** Workflow details */
  workflows: MonitorWorkflowInfo[];
}

/**
 * Monitor workflow info
 */
export interface MonitorWorkflowInfo {
  /** Workflow ID */
  id: string;
  /** Workflow name */
  name: string;
  /** Workflow status */
  status: string;
  /** Progress percentage */
  progress: number;
  /** Current node */
  currentNode?: string;
  /** Token usage */
  tokens: number;
  /** Estimated cost */
  cost: number;
  /** Duration (ms) */
  duration: number;
}

/**
 * Default CLI configuration
 */
export const DEFAULT_CLI_CONFIG: CLIConfig = {
  defaultFormat: 'table',
  defaultPriority: 'normal',
  autoSaveInterval: 30000,
  historyPath: '.polaris/cli-history.json',
  maxHistoryEntries: 100,
  colors: true,
  timestamps: true,
};

/**
 * Built-in workflow templates
 */
export const BUILTIN_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'dev-pipeline',
    name: 'Development Pipeline',
    description: 'Standard development workflow with code review and testing',
    category: 'development',
    workflow: {
      name: 'Development Pipeline',
      description: 'Standard development workflow',
      priority: 5,
      mode: 'continuous',
      memoryRoot: '/tmp/memory',
      workDir: '/tmp/workdir',
    },
    nodes: [
      { id: 'analyze', name: 'Analyze', role: 'developer', dependencies: [] },
      { id: 'implement', name: 'Implement', role: 'developer', dependencies: ['analyze'] },
      { id: 'review', name: 'Review', role: 'reviewer', dependencies: ['implement'] },
      { id: 'test', name: 'Test', role: 'tester', dependencies: ['review'] },
    ],
  },
  {
    id: 'feature-flow',
    name: 'Feature Flow',
    description: 'Feature development with planning and implementation',
    category: 'development',
    workflow: {
      name: 'Feature Flow',
      description: 'Feature development workflow',
      priority: 7,
      mode: 'continuous',
      memoryRoot: '/tmp/memory',
      workDir: '/tmp/workdir',
    },
    nodes: [
      { id: 'plan', name: 'Plan', role: 'product', dependencies: [] },
      { id: 'design', name: 'Design', role: 'designer', dependencies: ['plan'] },
      { id: 'implement', name: 'Implement', role: 'developer', dependencies: ['design'] },
      { id: 'verify', name: 'Verify', role: 'tester', dependencies: ['implement'] },
    ],
  },
  {
    id: 'test-suite',
    name: 'Test Suite',
    description: 'Comprehensive testing workflow',
    category: 'testing',
    workflow: {
      name: 'Test Suite',
      description: 'Testing workflow',
      priority: 5,
      mode: 'continuous',
      memoryRoot: '/tmp/memory',
      workDir: '/tmp/workdir',
    },
    nodes: [
      { id: 'unit-tests', name: 'Unit Tests', role: 'tester', dependencies: [] },
      { id: 'integration-tests', name: 'Integration Tests', role: 'tester', dependencies: ['unit-tests'] },
      { id: 'e2e-tests', name: 'E2E Tests', role: 'tester', dependencies: ['integration-tests'] },
      { id: 'report', name: 'Report', role: 'reporter', dependencies: ['e2e-tests'] },
    ],
  },
];

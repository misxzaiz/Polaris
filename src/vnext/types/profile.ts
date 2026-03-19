/**
 * Scheduler vNext - Agent Profile Template
 *
 * Defines agent behavior, constraints, and execution policies
 */

import type { ExecutionStrategy } from './node';

// ============================================================================
// Agent Profile
// ============================================================================

/**
 * AgentProfile defines a complete agent template with behavior rules
 */
export interface AgentProfile {
  /** Unique profile identifier */
  id: string;

  /** Profile name */
  name: string;

  /** Agent role (product, developer, tester, etc.) */
  role: string;

  /** Human-readable description */
  description?: string;

  /** System policy / base prompt */
  systemPolicy: string;

  /** Default execution strategy */
  executionStrategy: ExecutionStrategy;

  /** Scoring rule for self-evaluation */
  scoringRule: ScoringRule;

  /** Done condition definition */
  doneDefinition: DoneDefinition;

  /** Memory management policy */
  memoryPolicy: MemoryPolicy;

  /** Iteration policy (max rounds, timeout, etc.) */
  iterationPolicy: IterationPolicy;

  /** Output protocol definition */
  outputProtocol: OutputProtocol;

  /** Whether this profile can self-evolve */
  selfEvolve: boolean;

  /** Constraints for agent behavior */
  constraints: AgentConstraint[];

  /** Required tools for this agent */
  requiredTools: string[];

  /** Tags for categorization */
  tags: string[];

  /** Creation timestamp */
  createdAt: number;

  /** Last update timestamp */
  updatedAt: number;
}

// ============================================================================
// Scoring Rule
// ============================================================================

export interface ScoringRule {
  /** Scoring criteria */
  criteria: ScoringCriterion[];

  /** Minimum acceptable score (0-100) */
  minScore: number;

  /** Whether to auto-rollback on low score */
  autoRollback: boolean;
}

export interface ScoringCriterion {
  /** Criterion name */
  name: string;

  /** Criterion description */
  description: string;

  /** Weight in total score */
  weight: number;

  /** Evaluation prompt */
  evaluationPrompt: string;
}

// ============================================================================
// Done Definition
// ============================================================================

export interface DoneDefinition {
  /** Conditions for completion */
  conditions: DoneCondition[];

  /** Whether to require user confirmation */
  requireConfirmation: boolean;
}

export interface DoneCondition {
  /** Condition type */
  type: 'output_exists' | 'test_pass' | 'score_threshold' | 'custom';

  /** Condition expression/prompt */
  expression: string;

  /** Whether this is required */
  required: boolean;
}

// ============================================================================
// Memory Policy
// ============================================================================

export interface MemoryPolicy {
  /** Maximum active memory lines before compaction */
  maxActiveLines: number;

  /** Maximum tokens before compaction */
  maxTokens: number;

  /** Number of completed nodes to trigger compaction */
  compactionThreshold: number;

  /** Whether to auto-archive on completion */
  autoArchive: boolean;

  /** Memory retention days */
  retentionDays: number;

  /** Whether to generate semantic index */
  semanticIndex: boolean;
}

// ============================================================================
// Iteration Policy
// ============================================================================

export interface IterationPolicy {
  /** Maximum iterations per round */
  maxIterations: number;

  /** Maximum total rounds */
  maxRounds: number;

  /** Timeout per iteration (ms) */
  iterationTimeoutMs: number;

  /** Whether to allow early termination */
  allowEarlyTermination: boolean;

  /** Cooldown between iterations (ms) */
  cooldownMs: number;
}

// ============================================================================
// Output Protocol
// ============================================================================

export interface OutputProtocol {
  /** Required output fields */
  requiredFields: string[];

  /** Output format */
  format: 'markdown' | 'json' | 'structured';

  /** Whether to require summary */
  requireSummary: boolean;

  /** Whether to require commit message */
  requireCommitMessage: boolean;
}

// ============================================================================
// Agent Constraint
// ============================================================================

export interface AgentConstraint {
  /** Constraint type */
  type: 'forbidden' | 'required' | 'limit' | 'pattern';

  /** Constraint description */
  description: string;

  /** Constraint value/rule */
  rule: string;

  /** Severity if violated */
  severity: 'error' | 'warning' | 'info';
}

// ============================================================================
// Built-in Profile Templates
// ============================================================================

/**
 * Default agent profiles
 */
export const BUILTIN_PROFILES: Partial<AgentProfile>[] = [
  {
    id: 'developer-v1',
    name: 'Developer Agent',
    role: 'developer',
    description: 'Software development agent focused on code implementation',
    systemPolicy: `You are a software developer agent. Your primary responsibilities:
1. Analyze requirements and existing code
2. Implement features and fix bugs
3. Write tests for your code
4. Document your changes

Always:
- Read existing code before making changes
- Write clear commit messages
- Follow existing code patterns`,
    executionStrategy: 'PLAN_FIRST',
    scoringRule: {
      criteria: [
        { name: 'code_quality', description: 'Code follows best practices', weight: 0.3, evaluationPrompt: 'Rate code quality 0-100' },
        { name: 'test_coverage', description: 'Tests cover new code', weight: 0.3, evaluationPrompt: 'Rate test coverage 0-100' },
        { name: 'documentation', description: 'Changes are documented', weight: 0.2, evaluationPrompt: 'Rate documentation 0-100' },
        { name: 'completion', description: 'Task is fully completed', weight: 0.2, evaluationPrompt: 'Rate completion 0-100' },
      ],
      minScore: 60,
      autoRollback: true,
    },
    memoryPolicy: {
      maxActiveLines: 1500,
      maxTokens: 60000,
      compactionThreshold: 5,
      autoArchive: true,
      retentionDays: 30,
      semanticIndex: false,
    },
    iterationPolicy: {
      maxIterations: 10,
      maxRounds: 50,
      iterationTimeoutMs: 300000,
      allowEarlyTermination: true,
      cooldownMs: 1000,
    },
    selfEvolve: false,
    constraints: [
      { type: 'forbidden', description: 'No deletion without confirmation', rule: 'delete_*', severity: 'error' },
    ],
    requiredTools: ['read', 'write', 'bash'],
    tags: ['development', 'coding'],
  },
  {
    id: 'product-v1',
    name: 'Product Agent',
    role: 'product',
    description: 'Product management agent for requirements and planning',
    systemPolicy: `You are a product manager agent. Your responsibilities:
1. Analyze user requirements
2. Create detailed specifications
3. Prioritize features
4. Identify conflicts and dependencies

Always:
- Think from user perspective
- Consider edge cases
- Document decisions`,
    executionStrategy: 'EXPLORE',
    scoringRule: {
      criteria: [
        { name: 'completeness', description: 'Requirements are complete', weight: 0.4, evaluationPrompt: 'Rate completeness 0-100' },
        { name: 'clarity', description: 'Requirements are clear', weight: 0.3, evaluationPrompt: 'Rate clarity 0-100' },
        { name: 'conflicts', description: 'Conflicts are identified', weight: 0.3, evaluationPrompt: 'Rate conflict detection 0-100' },
      ],
      minScore: 70,
      autoRollback: false,
    },
    memoryPolicy: {
      maxActiveLines: 1000,
      maxTokens: 40000,
      compactionThreshold: 3,
      autoArchive: true,
      retentionDays: 60,
      semanticIndex: false,
    },
    iterationPolicy: {
      maxIterations: 10,
      maxRounds: 20,
      iterationTimeoutMs: 180000,
      allowEarlyTermination: true,
      cooldownMs: 2000,
    },
    selfEvolve: false,
    constraints: [],
    requiredTools: ['read', 'write'],
    tags: ['product', 'requirements'],
  },
  {
    id: 'tester-v1',
    name: 'Tester Agent',
    role: 'tester',
    description: 'Testing agent for quality assurance',
    systemPolicy: `You are a QA engineer agent. Your responsibilities:
1. Write test cases
2. Execute tests
3. Report bugs
4. Verify fixes

Always:
- Cover edge cases
- Document test scenarios
- Provide reproducible steps for bugs`,
    executionStrategy: 'TEST_DRIVEN',
    scoringRule: {
      criteria: [
        { name: 'coverage', description: 'Test coverage achieved', weight: 0.4, evaluationPrompt: 'Rate coverage 0-100' },
        { name: 'quality', description: 'Test quality', weight: 0.3, evaluationPrompt: 'Rate test quality 0-100' },
        { name: 'bugs_found', description: 'Bugs identified', weight: 0.3, evaluationPrompt: 'Rate bug detection 0-100' },
      ],
      minScore: 50,
      autoRollback: false,
    },
    memoryPolicy: {
      maxActiveLines: 800,
      maxTokens: 30000,
      compactionThreshold: 4,
      autoArchive: true,
      retentionDays: 30,
      semanticIndex: false,
    },
    iterationPolicy: {
      maxIterations: 5,
      maxRounds: 30,
      iterationTimeoutMs: 300000,
      allowEarlyTermination: true,
      cooldownMs: 1000,
    },
    selfEvolve: false,
    constraints: [],
    requiredTools: ['read', 'write', 'bash'],
    tags: ['testing', 'qa'],
  },
];

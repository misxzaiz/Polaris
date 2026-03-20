/**
 * Scheduler vNext - WorkflowNode Data Models
 *
 * Re-exports from index.ts for backward compatibility
 */

export type {
  WorkflowNode,
  NodeState,
  NodeTriggerType,
  ExecutionStrategy,
  CreateNodeParams,
  UpdateNodeParams,
} from './index';

// Helper functions
export function isTerminalState(state: import('./index').NodeState): boolean {
  return state === 'DONE' || state === 'FAILED' || state === 'SKIPPED';
}

export function isValidTransition(
  from: import('./index').NodeState,
  to: import('./index').NodeState
): boolean {
  const validTransitions: Record<import('./index').NodeState, import('./index').NodeState[]> = {
    'IDLE': ['READY', 'SKIPPED'],
    'READY': ['RUNNING', 'SKIPPED'],
    'RUNNING': ['DONE', 'FAILED', 'WAITING_INPUT', 'WAITING_EVENT'],
    'WAITING_INPUT': ['RUNNING', 'FAILED'],
    'WAITING_EVENT': ['RUNNING', 'FAILED', 'DONE'],
    'DONE': ['READY'],
    'FAILED': ['READY'],
    'SKIPPED': [],
  };

  return validTransitions[from]?.includes(to) ?? false;
}

// Node ready check result
export interface NodeReadyCheck {
  nodeId: string;
  isReady: boolean;
  blockedBy: string[];
  reason: string;
}

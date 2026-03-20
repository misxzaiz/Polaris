/**
 * Scheduler vNext - Workflow Data Models
 *
 * Re-exports from index.ts for backward compatibility
 */

export type {
  Workflow,
  WorkflowStatus,
  WorkflowMode,
  CreateWorkflowParams,
  UpdateWorkflowParams,
} from './index';

// Extended Workflow type with additional fields for compatibility
export interface WorkflowWithNodes {
  id: string;
  name: string;
  description?: string;
  templateId?: string;
  status: import('./index').WorkflowStatus;
  mode: import('./index').WorkflowMode;
  priority: number;
  continuousMode?: boolean;
  createdAt: number;
  updatedAt: number;
  currentNodeId?: string;
  memoryRoot?: string;
  workDir?: string;
  maxRounds?: number;
  currentRounds?: number;
  totalRounds?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

import { invoke } from './transport';

export interface McpHealthStatus {
  name: string;
  connected: boolean;
  status: string;
  transport?: 'stdio' | 'http' | null;
  command?: string | null;
}

export function listMcpHealthStatuses(): Promise<McpHealthStatus[]> {
  return invoke<McpHealthStatus[]>('mcp_health_check');
}

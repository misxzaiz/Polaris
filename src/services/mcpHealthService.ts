import { invoke } from './transport';

export interface McpHealthStatus {
  name: string;
  connected: boolean;
  status: string;
  transport?: 'stdio' | 'http' | null;
  command?: string | null;
}

/** K-R5 批E：mcp_health_check 命令删除，走 cap.mcp health 动作 */
export function listMcpHealthStatuses(): Promise<McpHealthStatus[]> {
  return invoke<{ msgId: string; ok: boolean; result: McpHealthStatus[]; error: string | null }>('router_dispatch', {
    req: { target: 'cap.mcp', payload: { action: 'health' } },
  }).then((res) => {
    if (!res.ok) throw new Error(res.error || 'cap.mcp health 失败');
    return res.result;
  });
}

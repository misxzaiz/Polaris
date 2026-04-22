/**
 * MCP 拓扑图组件
 *
 * 使用 Mermaid 渲染服务器连接拓扑
 * 动态生成 graph TD 代码
 */

import { useEffect, useRef, memo, useState } from 'react';
import type { McpServerAggregate } from '../../types/mcp';
import { getMermaidConfig } from '../../utils/mermaid-config';

/** 从服务器推断状态颜色 */
function getStatusColor(server: McpServerAggregate): string {
  const { health } = server;
  if (!health) return '#6B7280'; // gray - unknown
  if (health.connected) return '#34D399'; // green
  const s = health.status?.toLowerCase() ?? '';
  if (s.includes('auth') || s.includes('认证') || s.includes('authenticate')) return '#FBBF24'; // yellow
  return '#F87171'; // red
}

/** 生成 mermaid graph TD 代码 */
function generateMermaidCode(servers: McpServerAggregate[]): string {
  const lines: string[] = ['graph TD'];

  // 根节点：应用
  lines.push('  App["MCP Client"]');

  servers.forEach((server, index) => {
    const nodeId = `S${index}`;
    const color = getStatusColor(server);
    const transport = server.health?.transport ?? server.configs[0]?.transport ?? 'stdio';
    const scopes = [...new Set(server.configs.map((c) => c.scope))].join(',');
    const label = `${server.name}<br/>${transport} · ${scopes}`;

    lines.push(`  ${nodeId}["${label}"]`);
    lines.push(`  style ${nodeId} fill:${color}33,stroke:${color},color:#F8F8F8`);
    lines.push(`  App --- ${nodeId}`);
  });

  return lines.join('\n');
}

export interface McpTopologyDiagramProps {
  servers: McpServerAggregate[];
}

export const McpTopologyDiagram = memo(function McpTopologyDiagram({
  servers,
}: McpTopologyDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const code = generateMermaidCode(servers);

  useEffect(() => {
    if (!servers.length || !containerRef.current) return;

    let cancelled = false;

    const render = async () => {
      try {
        const mermaidModule = await import('mermaid');
        const mermaid = mermaidModule.default;

        // mermaid.initialize is idempotent - safe to call multiple times
        const config = getMermaidConfig('dark');
        mermaid.initialize(config);

        const id = `mcp-topology-${Date.now()}`;
        const { svg } = await mermaid.render(id, code);

        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg;
          setRendered(true);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setRendered(false);
        }
      }
    };

    render();

    return () => {
      cancelled = true;
    };
  }, [code, servers.length]);

  if (servers.length === 0) {
    return null;
  }

  return (
    <div className="relative">
      <div
        ref={containerRef}
        className="w-full overflow-x-auto"
        style={{ minHeight: rendered ? undefined : '100px' }}
      />
      {!rendered && !error && (
        <div className="flex justify-center py-4">
          <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      )}
      {error && (
        <pre className="mermaid text-xs text-text-muted p-2 bg-background-base rounded overflow-x-auto">
          {code}
        </pre>
      )}
    </div>
  );
});

McpTopologyDiagram.displayName = 'McpTopologyDiagram';

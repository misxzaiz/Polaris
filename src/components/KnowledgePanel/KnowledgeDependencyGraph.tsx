/**
 * KnowledgeDependencyGraph - 知识模块依赖关系图
 *
 * 使用 Mermaid 渲染模块依赖拓扑
 * 支持按 Domain 分组、复杂度着色、交互选中
 */

import { useEffect, useRef, memo, useState, useMemo } from 'react';
import { getMermaidConfig } from '../../utils/mermaid-config';
import { createLogger } from '../../utils/logger';

const log = createLogger('KnowledgeDependencyGraph');

/** 域配置 */
export interface Domain {
  id: string;
  name: string;
  color: string;
}

/** 节点数据 */
export interface ModuleNode {
  id: string;
  name: string;
  domain: string;
  complexity: 'low' | 'medium' | 'high';
  dependencies: string[];
  dependents: string[];
}

/** 组件 Props */
export interface KnowledgeDependencyGraphProps {
  /** 模块节点列表 */
  modules: ModuleNode[];
  /** 域定义 */
  domains?: Domain[];
  /** 选中的模块 ID */
  selectedModuleId?: string;
  /** 点击节点回调 */
  onNodeClick?: (moduleId: string) => void;
  /** 是否显示依赖方向（上游/下游/全部） */
  direction?: 'all' | 'upstream' | 'downstream';
  /** 是否按 Domain 分组 */
  groupByDomain?: boolean;
  /** 最小高度 */
  minHeight?: number;
}

/** 默认域配置 - 匹配 index.v2.json */
const DEFAULT_DOMAINS: Domain[] = [
  { id: 'ai-conversation', name: 'AI 对话', color: '#3B82F6' },    // primary blue
  { id: 'data-management', name: '数据与持久化', color: '#34D399' }, // success green
  { id: 'developer-tools', name: '开发者工具', color: '#FBBF24' },   // warning yellow
  { id: 'platform-integration', name: '平台集成', color: '#F87171' }, // danger red
];

/** 复杂度颜色 */
const COMPLEXITY_COLORS: Record<string, string> = {
  low: '#34D399',    // green
  medium: '#FBBF24', // yellow
  high: '#F87171',   // red
};

/** 安全 ID 转换（Mermaid 节点 ID 仅支持字母数字下划线） */
function toSafeId(id: string): string {
  return id.replace(/-/g, '_');
}

/** 生成 Mermaid flowchart 代码 */
function generateMermaidCode(
  modules: ModuleNode[],
  domains: Domain[],
  options: {
    selectedModuleId?: string;
    direction?: 'all' | 'upstream' | 'downstream';
    groupByDomain?: boolean;
  }
): string {
  const { selectedModuleId, direction = 'all', groupByDomain = true } = options;
  const lines: string[] = ['flowchart TD'];

  const domainMap = new Map(domains.map(d => [d.id, d]));
  const safeIdMap = new Map<string, string>();
  modules.forEach(m => safeIdMap.set(m.id, toSafeId(m.id)));

  // 确定要渲染的模块
  let visibleModules = modules;
  let highlightNodes = new Set<string>();

  if (selectedModuleId) {
    const selected = modules.find(m => m.id === selectedModuleId);
    if (selected) {
      highlightNodes.add(selectedModuleId);
      if (direction === 'upstream') {
        // 只显示上游依赖
        const upstream = new Set<string>();
        const collectUpstream = (id: string) => {
          const mod = modules.find(m => m.id === id);
          if (mod) {
            mod.dependencies.forEach(dep => {
              if (!upstream.has(dep)) {
                upstream.add(dep);
                collectUpstream(dep);
              }
            });
          }
        };
        collectUpstream(selectedModuleId);
        visibleModules = modules.filter(m => m.id === selectedModuleId || upstream.has(m.id));
        upstream.forEach(id => highlightNodes.add(id));
      } else if (direction === 'downstream') {
        // 只显示下游被依赖
        const downstream = new Set<string>();
        const collectDownstream = (id: string) => {
          const mod = modules.find(m => m.id === id);
          if (mod) {
            mod.dependents.forEach(dep => {
              if (!downstream.has(dep)) {
                downstream.add(dep);
                collectDownstream(dep);
              }
            });
          }
        };
        collectDownstream(selectedModuleId);
        visibleModules = modules.filter(m => m.id === selectedModuleId || downstream.has(m.id));
        downstream.forEach(id => highlightNodes.add(id));
      } else {
        // 全部显示，但高亮相关
        selected.dependencies.forEach(id => highlightNodes.add(id));
        selected.dependents.forEach(id => highlightNodes.add(id));
      }
    }
  }

  // 按 Domain 分组
  if (groupByDomain) {
    const byDomain = new Map<string, ModuleNode[]>();
    visibleModules.forEach(m => {
      const list = byDomain.get(m.domain) || [];
      list.push(m);
      byDomain.set(m.domain, list);
    });

    byDomain.forEach((mods, domainId) => {
      const domain = domainMap.get(domainId);
      const domainName = domain?.name ?? domainId;
      const domainColor = domain?.color ?? '#6B7280';
      const safeDomainId = toSafeId(`domain_${domainId}`);

      lines.push(`  subgraph ${safeDomainId} ["${domainName}"]`);
      lines.push(`    style ${safeDomainId} fill:${domainColor}11,stroke:${domainColor},stroke-width:1px,color:#F8F8F8`);

      mods.forEach(mod => {
        const safeId = safeIdMap.get(mod.id)!;
        const color = COMPLEXITY_COLORS[mod.complexity] || '#6B7280';
        const isHighlighted = highlightNodes.has(mod.id);
        const isSelected = mod.id === selectedModuleId;

        // 节点标签：名称 + ID
        // NOTE: Mermaid 11.x 要求节点 ID 和 ["label"] 之间不能有空格
        const label = `${mod.name}<br/>${mod.id}`;
        lines.push(`    ${safeId}["${label}"]`);

        // 样式：复杂度着色，选中/高亮增强
        const borderWidth = isSelected ? 3 : isHighlighted ? 2 : 1;
        const opacity = selectedModuleId && !isHighlighted ? 0.4 : 1;
        lines.push(`    style ${safeId} fill:${color}${opacity < 1 ? '66' : '33'},stroke:${color},stroke-width:${borderWidth}px,color:#F8F8F8`);
      });

      lines.push('  end');
    });
  } else {
    // 不分组，直接渲染
    visibleModules.forEach(mod => {
      const safeId = safeIdMap.get(mod.id)!;
      const color = COMPLEXITY_COLORS[mod.complexity] || '#6B7280';
      const isHighlighted = highlightNodes.has(mod.id);
      const isSelected = mod.id === selectedModuleId;

      const label = `${mod.name}<br/>${mod.id}`;
      lines.push(`  ${safeId}["${label}"]`);

      const borderWidth = isSelected ? 3 : isHighlighted ? 2 : 1;
      const opacity = selectedModuleId && !isHighlighted ? 0.4 : 1;
      lines.push(`  style ${safeId} fill:${color}${opacity < 1 ? '66' : '33'},stroke:${color},stroke-width:${borderWidth}px,color:#F8F8F8`);
    });
  }

  // 渲染依赖边
  // NOTE: Mermaid 不支持边上的内联 style="" 属性
  // 非高亮边使用虚线 -.-> 视觉区分
  visibleModules.forEach(mod => {
    const safeId = safeIdMap.get(mod.id)!;
    mod.dependencies.forEach(depId => {
      const depSafeId = safeIdMap.get(depId);
      if (depSafeId && visibleModules.some(m => m.id === depId)) {
        const isHighlighted = highlightNodes.has(mod.id) && highlightNodes.has(depId);
        const arrow = isHighlighted ? '-->' : '-.->';
        lines.push(`  ${depSafeId} ${arrow} ${safeId}`);
      }
    });
  });

  // 添加交互脚本（点击事件）
  lines.push('');
  modules.forEach(mod => {
    const safeId = safeIdMap.get(mod.id)!;
    lines.push(`  click ${safeId} "javascript:window.__knowledgeGraphClick?.('${mod.id}')"`);
  });

  return lines.join('\n');
}

export const KnowledgeDependencyGraph = memo(function KnowledgeDependencyGraph({
  modules,
  domains = DEFAULT_DOMAINS,
  selectedModuleId,
  onNodeClick,
  direction = 'all',
  groupByDomain = true,
  minHeight = 300,
}: KnowledgeDependencyGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 生成 Mermaid 代码
  const code = useMemo(() => {
    if (modules.length === 0) return '';
    return generateMermaidCode(modules, domains, {
      selectedModuleId,
      direction,
      groupByDomain,
    });
  }, [modules, domains, selectedModuleId, direction, groupByDomain]);

  // 注册全局点击回调
  useEffect(() => {
    if (!onNodeClick) return;
    window.__knowledgeGraphClick = onNodeClick;
    return () => {
      delete window.__knowledgeGraphClick;
    };
  }, [onNodeClick]);

  // 渲染 Mermaid
  useEffect(() => {
    if (!code || !containerRef.current) return;

    let cancelled = false;

    const render = async () => {
      try {
        const mermaidModule = await import('mermaid');
        const mermaid = mermaidModule.default;

        const config = getMermaidConfig('dark');
        mermaid.initialize(config);

        const id = `knowledge-graph-${Date.now()}`;
        const { svg } = await mermaid.render(id, code);

        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg;
          setRendered(true);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error('Mermaid 渲染失败', err instanceof Error ? err : new Error(msg));
          setError(msg);
          setRendered(false);
        }
      }
    };

    render();

    return () => {
      cancelled = true;
    };
  }, [code]);

  if (modules.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-text-tertiary text-xs">
        暂无模块数据
      </div>
    );
  }

  return (
    <div className="relative">
      <div
        ref={containerRef}
        className="w-full overflow-x-auto"
        style={{ minHeight: rendered ? undefined : minHeight }}
      />
      {!rendered && !error && (
        <div className="flex justify-center py-4">
          <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      )}
      {error && (
        <div className="p-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-400">
          渲染失败: {error}
        </div>
      )}
    </div>
  );
});

KnowledgeDependencyGraph.displayName = 'KnowledgeDependencyGraph';

// 扩展 Window 接口
declare global {
  interface Window {
    __knowledgeGraphClick?: (moduleId: string) => void;
  }
}

/**
 * WorkflowDiagram Component
 * 工作流图形化展示组件
 */

import { useMemo, useCallback } from 'react';
import clsx from 'clsx';
import type {
  WorkflowDiagramProps,
  NodePosition,
  ConnectionLine,
} from './types';
import { getNodeStatusConfig } from './types';
import type { WorkflowNode } from '../types';

/**
 * 计算节点位置
 * 使用简单的分层布局算法
 */
function calculateNodePositions(
  nodes: WorkflowNode[],
  direction: 'horizontal' | 'vertical' = 'horizontal'
): NodePosition[] {
  const nodeWidth = 180;
  const nodeHeight = 80;
  const gap = 60;

  // 构建依赖图
  const dependencyMap = new Map<string, string[]>();
  const dependentsMap = new Map<string, string[]>();

  nodes.forEach((node) => {
    dependencyMap.set(node.id, node.dependencies || []);
    dependentsMap.set(node.id, []);
  });

  nodes.forEach((node) => {
    (node.dependencies || []).forEach((depId) => {
      const dependents = dependentsMap.get(depId) || [];
      dependents.push(node.id);
      dependentsMap.set(depId, dependents);
    });
  });

  // 计算层级 (拓扑排序)
  const levels = new Map<string, number>();
  const visited = new Set<string>();
  const queue: string[] = [];

  // 找到没有依赖的节点作为起点
  nodes.forEach((node) => {
    if ((node.dependencies || []).length === 0) {
      queue.push(node.id);
      levels.set(node.id, 0);
    }
  });

  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId || visited.has(nodeId)) continue;
    visited.add(nodeId);

    const currentLevel = levels.get(nodeId) || 0;
    const dependents = dependentsMap.get(nodeId) || [];

    dependents.forEach((depId) => {
      const existingLevel = levels.get(depId) || 0;
      const newLevel = Math.max(existingLevel, currentLevel + 1);
      levels.set(depId, newLevel);

      if (!visited.has(depId)) {
        queue.push(depId);
      }
    });
  }

  // 未访问的节点放在最后一层
  const maxLevel = Math.max(...Array.from(levels.values()), 0);
  nodes.forEach((node) => {
    if (!levels.has(node.id)) {
      levels.set(node.id, maxLevel + 1);
    }
  });

  // 按层级分组
  const levelGroups = new Map<number, string[]>();
  nodes.forEach((node) => {
    const level = levels.get(node.id) || 0;
    const group = levelGroups.get(level) || [];
    group.push(node.id);
    levelGroups.set(level, group);
  });

  // 计算位置
  const positions: NodePosition[] = [];

  levelGroups.forEach((nodeIds, level) => {
    nodeIds.forEach((nodeId, index) => {
      if (direction === 'horizontal') {
        positions.push({
          nodeId,
          x: level * (nodeWidth + gap),
          y: index * (nodeHeight + gap),
          width: nodeWidth,
          height: nodeHeight,
        });
      } else {
        positions.push({
          nodeId,
          x: index * (nodeWidth + gap),
          y: level * (nodeHeight + gap),
          width: nodeWidth,
          height: nodeHeight,
        });
      }
    });
  });

  return positions;
}

/**
 * 构建连线数据
 */
function buildConnectionLines(
  nodes: WorkflowNode[],
  showDependencies: boolean,
  _showEventConnections?: boolean
): ConnectionLine[] {
  const lines: ConnectionLine[] = [];

  nodes.forEach((node) => {
    // 依赖连线
    if (showDependencies && node.dependencies) {
      node.dependencies.forEach((depId) => {
        lines.push({
          fromNodeId: depId,
          toNodeId: node.id,
          type: 'dependency',
        });
      });
    }

    // Next nodes 连线
    if (showDependencies && node.nextNodes) {
      node.nextNodes.forEach((nextId) => {
        lines.push({
          fromNodeId: node.id,
          toNodeId: nextId,
          type: 'next',
        });
      });
    }
  });

  // TODO: 事件连线需要在更高层级构建

  return lines;
}

/**
 * 工作流图形化展示组件
 */
export function WorkflowDiagram({
  workflow: _workflow,
  nodes,
  selectedNodeId,
  onNodeClick,
  showDependencies = true,
  showEventConnections = false,
  direction = 'horizontal',
  zoom = 1,
  className,
}: WorkflowDiagramProps) {
  const positions = useMemo(
    () => calculateNodePositions(nodes, direction),
    [nodes, direction]
  );

  const connections = useMemo(
    () => buildConnectionLines(nodes, showDependencies, showEventConnections),
    [nodes, showDependencies, showEventConnections]
  );

  const positionMap = useMemo(() => {
    const map = new Map<string, NodePosition>();
    positions.forEach((pos) => map.set(pos.nodeId, pos));
    return map;
  }, [positions]);

  const getNodePosition = useCallback(
    (nodeId: string): NodePosition | undefined => positionMap.get(nodeId),
    [positionMap]
  );

  // 计算画布大小
  const canvasSize = useMemo(() => {
    if (positions.length === 0) return { width: 400, height: 300 };

    let maxX = 0;
    let maxY = 0;

    positions.forEach((pos) => {
      maxX = Math.max(maxX, pos.x + pos.width);
      maxY = Math.max(maxY, pos.y + pos.height);
    });

    return {
      width: maxX + 60,
      height: maxY + 60,
    };
  }, [positions]);

  return (
    <div
      className={clsx('relative overflow-auto bg-gray-50 rounded-lg', className)}
      style={{ minHeight: 300 }}
    >
      <svg
        width={canvasSize.width * zoom}
        height={canvasSize.height * zoom}
        viewBox={`0 0 ${canvasSize.width} ${canvasSize.height}`}
        className="block"
      >
        {/* 连线层 */}
        <g className="connections">
          {connections.map((conn, index) => {
            const fromPos = getNodePosition(conn.fromNodeId);
            const toPos = getNodePosition(conn.toNodeId);

            if (!fromPos || !toPos) return null;

            const fromX = fromPos.x + fromPos.width / 2;
            const fromY = fromPos.y + fromPos.height;
            const toX = toPos.x + toPos.width / 2;
            const toY = toPos.y;

            return (
              <ConnectionLineElement
                key={`${conn.fromNodeId}-${conn.toNodeId}-${index}`}
                fromX={fromX}
                fromY={fromY}
                toX={toX}
                toY={toY}
                type={conn.type}
              />
            );
          })}
        </g>

        {/* 节点层 */}
        <g className="nodes">
          {positions.map((pos) => {
            const node = nodes.find((n) => n.id === pos.nodeId);
            if (!node) return null;

            return (
              <DiagramNode
                key={node.id}
                node={node}
                position={pos}
                selected={selectedNodeId === node.id}
                onClick={() => onNodeClick?.(node.id)}
              />
            );
          })}
        </g>
      </svg>
    </div>
  );
}

/**
 * 连线元素
 */
function ConnectionLineElement({
  fromX,
  fromY,
  toX,
  toY,
  type,
}: {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  type: ConnectionLine['type'];
}) {
  const colors = {
    dependency: '#6366F1',
    event: '#8B5CF6',
    next: '#10B981',
  };

  // 计算控制点 (贝塞尔曲线)
  const midY = (fromY + toY) / 2;

  return (
    <g>
      <path
        d={`M ${fromX} ${fromY} C ${fromX} ${midY}, ${toX} ${midY}, ${toX} ${toY}`}
        fill="none"
        stroke={colors[type]}
        strokeWidth={2}
        strokeDasharray={type === 'event' ? '5,5' : undefined}
        className="transition-all duration-200"
      />
      {/* 箭头 */}
      <polygon
        points={`${toX},${toY} ${toX - 6},${toY - 10} ${toX + 6},${toY - 10}`}
        fill={colors[type]}
        transform={`rotate(180, ${toX}, ${toY - 5})`}
      />
    </g>
  );
}

/**
 * 图形节点
 */
function DiagramNode({
  node,
  position,
  selected,
  onClick,
}: {
  node: WorkflowNode;
  position: NodePosition;
  selected: boolean;
  onClick: () => void;
}) {
  const config = getNodeStatusConfig(node.state);

  return (
    <g
      onClick={onClick}
      className="cursor-pointer"
      style={{ transform: `translate(${position.x}px, ${position.y}px)` }}
    >
      {/* 背景 */}
      <rect
        x={0}
        y={0}
        width={position.width}
        height={position.height}
        rx={8}
        fill="white"
        stroke={selected ? '#3B82F6' : '#E5E7EB'}
        strokeWidth={selected ? 2 : 1}
        className="transition-all duration-200"
      />

      {/* 状态指示条 */}
      <rect
        x={0}
        y={0}
        width={4}
        height={position.height}
        rx={4}
        fill={config.color.replace('text-', '').replace('-500', '')}
        className={config.color}
        style={{
          backgroundColor: config.color.includes('green')
            ? '#22C55E'
            : config.color.includes('amber')
            ? '#F59E0B'
            : config.color.includes('blue')
            ? '#3B82F6'
            : config.color.includes('red')
            ? '#EF4444'
            : config.color.includes('purple')
            ? '#A855F7'
            : '#6B7280',
        }}
      />

      {/* 节点名称 */}
      <text
        x={16}
        y={24}
        fontSize={12}
        fontWeight={500}
        fill="#374151"
        className="select-none"
      >
        {node.name.length > 16 ? `${node.name.slice(0, 14)}...` : node.name}
      </text>

      {/* 角色 */}
      <text
        x={16}
        y={40}
        fontSize={10}
        fill="#6B7280"
        className="select-none"
      >
        {node.role}
      </text>

      {/* 状态徽章 */}
      <rect
        x={16}
        y={52}
        width={40}
        height={16}
        rx={4}
        fill={
          config.bgColor.includes('green')
            ? '#DCFCE7'
            : config.bgColor.includes('amber')
            ? '#FEF3C7'
            : config.bgColor.includes('blue')
            ? '#DBEAFE'
            : config.bgColor.includes('red')
            ? '#FEE2E2'
            : '#F3F4F6'
        }
      />
      <text
        x={36}
        y={63}
        fontSize={8}
        fill="#374151"
        textAnchor="middle"
        className="select-none"
      >
        {config.label}
      </text>
    </g>
  );
}

/**
 * 简单工作流图
 * 使用 HTML 而非 SVG，更轻量
 */
export function SimpleWorkflowDiagram({
  nodes,
  selectedNodeId,
  onNodeClick,
  className,
}: {
  nodes: Array<{
    id: string;
    name: string;
    state: string;
    role: string;
    dependencies?: string[];
  }>;
  selectedNodeId?: string;
  onNodeClick?: (nodeId: string) => void;
  className?: string;
}) {
  // 按依赖关系分层
  const layers = useMemo(() => {
    const result: Array<typeof nodes> = [];
    const assigned = new Set<string>();

    while (assigned.size < nodes.length) {
      const layer = nodes.filter((node) => {
        if (assigned.has(node.id)) return false;
        const deps = node.dependencies || [];
        return deps.every((d) => assigned.has(d));
      });

      if (layer.length === 0) {
        // 防止死循环，将剩余节点放入最后一层
        const remaining = nodes.filter((n) => !assigned.has(n.id));
        result.push(remaining);
        break;
      }

      result.push(layer);
      layer.forEach((n) => assigned.add(n.id));
    }

    return result;
  }, [nodes]);

  return (
    <div className={clsx('space-y-4', className)}>
      {layers.map((layer, layerIndex) => (
        <div key={layerIndex}>
          {/* Layer label */}
          {layers.length > 1 && (
            <div className="text-xs text-gray-400 mb-2 ml-1">
              层级 {layerIndex + 1}
            </div>
          )}
          {/* Nodes */}
          <div className="flex flex-wrap gap-2">
            {layer.map((node) => (
              <div
                key={node.id}
                onClick={() => onNodeClick?.(node.id)}
                className={clsx(
                  'flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-all',
                  selectedNodeId === node.id
                    ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200'
                    : 'border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm'
                )}
              >
                <span
                  className={clsx(
                    'w-2 h-2 rounded-full',
                    node.state === 'DONE'
                      ? 'bg-green-500'
                      : node.state === 'RUNNING'
                      ? 'bg-amber-500 animate-pulse'
                      : node.state === 'FAILED'
                      ? 'bg-red-500'
                      : node.state === 'READY'
                      ? 'bg-blue-500'
                      : 'bg-gray-300'
                  )}
                />
                <span className="text-sm font-medium text-gray-700">
                  {node.name}
                </span>
                <span className="text-xs text-gray-400">{node.role}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

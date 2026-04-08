/**
 * Mermaid 图表共享状态管理
 *
 * 合并 MermaidDiagram 和 DeferredMermaidDiagram 的重复状态逻辑。
 * 单一 Map 实例，统一 FIFO 淘汰策略。
 */

/** 视图模式 */
export type ViewMode = 'chart' | 'source';

/** 图表交互状态 */
export interface DiagramState {
  viewMode: ViewMode;
  scale: number;
}

/** 缩放配置 */
export const SCALE_CONFIG = {
  min: 0.5,
  max: 2.0,
  step: 0.1,
  default: 1.0,
} as const;

const MAX_DIAGRAM_STATES = 30;
const diagramStates = new Map<string, DiagramState>();

/** 获取图表状态（不存在时创建默认值） */
export function getDiagramState(id: string): DiagramState {
  if (!diagramStates.has(id)) {
    if (diagramStates.size >= MAX_DIAGRAM_STATES) {
      const firstKey = diagramStates.keys().next().value;
      if (firstKey !== undefined) diagramStates.delete(firstKey);
    }
    diagramStates.set(id, {
      viewMode: 'chart',
      scale: SCALE_CONFIG.default,
    });
  }
  return diagramStates.get(id)!;
}

/** 保存图表状态 */
export function saveDiagramState(id: string, state: DiagramState) {
  diagramStates.set(id, state);
}

/** 移除图表状态（组件卸载时调用） */
export function removeDiagramState(id: string) {
  diagramStates.delete(id);
}

/**
 * 编辑器组件导出
 *
 * FE-2: 仅保留轻组件 re-export。EditorPanel/CodeMirrorEditor/NarrowTabOverlay
 * 会静态传导 @codemirror 全家（vite manualChunks 将所有 @codemirror/* 钉进单一
 * codemirror chunk，~1MB，任一静态边都使其进首载 modulepreload），
 * 需要编辑器的消费方一律 React.lazy + 深度路径引入（App.tsx / CenterStage.tsx 范式）。
 */

export { EditorHeader } from './EditorHeader';
export { BreadcrumbBar } from './BreadcrumbBar';
export { StatusBar } from './StatusBar';

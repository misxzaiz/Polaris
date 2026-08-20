/**
 * 全局类型扩展声明
 */

// requestIdleCallback / cancelIdleCallback — 非标准但广泛支持的 API
interface Window {
  requestIdleCallback(callback: (deadline: { didTimeout: boolean; timeRemaining: () => number }) => void, options?: { timeout?: number }): number;
  cancelIdleCallback(handle: number): void;
}

// mermaid 模块类型声明（库自带类型不完整）
declare module 'mermaid' {
  export interface MermaidConfig {
    theme?: string;
    startOnLoad?: boolean;
    securityLevel?: string;
    fontFamily?: string;
    themeVariables?: Record<string, string>;
    [key: string]: unknown;
  }

  export interface MermaidAPI {
    initialize(config: MermaidConfig): void;
    isInitialized?(): boolean;
    render(id: string, code: string): Promise<{ svg: string }>;
  }

  const mermaid: MermaidAPI;
  export default mermaid;
}

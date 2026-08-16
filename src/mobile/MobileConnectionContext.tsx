/**
 * MobileConnectionContext
 *
 * 提供 MobileConnectionGate 的连接状态与控制接口给深层子组件（如 GeneralTab）。
 * 桌面端不挂载 Provider，useMobileConnection 返回 null，消费方需守卫。
 */
import { createContext, useContext, type ReactNode } from 'react';

export interface MobileConnectionContextValue {
  /** 跳转到连接配置页（MobileConnectionGate 的设置视图） */
  openConnectionSettings: () => void;
  /** 当前是否已连接到服务端 */
  connected: boolean;
}

const MobileConnectionContext = createContext<MobileConnectionContextValue | null>(null);

interface MobileConnectionProviderProps {
  value: MobileConnectionContextValue;
  children: ReactNode;
}

export function MobileConnectionProvider({ value, children }: MobileConnectionProviderProps) {
  return (
    <MobileConnectionContext.Provider value={value}>
      {children}
    </MobileConnectionContext.Provider>
  );
}

/**
 * 消费 MobileConnectionContext。
 * 桌面端没有 Provider 时返回 null，调用方需做空值判断。
 */
export function useMobileConnection(): MobileConnectionContextValue | null {
  return useContext(MobileConnectionContext);
}
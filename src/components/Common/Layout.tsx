/**
 * 基础布局组件
 */

import { ReactNode } from 'react';

interface LayoutProps {
  children: ReactNode;
}

interface HeaderProps {
  title: string;
  children?: ReactNode;
}

interface SidebarProps {
  children: ReactNode;
  className?: string;
  width?: number; // 可选的自定义宽度
}

interface MainProps {
  children: ReactNode;
  className?: string;
}

interface AsideProps {
  children: ReactNode;
  className?: string;
  width?: number; // 可选的自定义宽度
}

/** 主布局容器 */
export function Layout({ children }: LayoutProps) {
  return (
    // h-screen 为不支持 dvh 的浏览器兜底；内联 100dvh 在移动端浏览器
    // 排除地址栏占位，避免底部输入框被遮挡（不支持 dvh 时该值被忽略）
    <div
      className="flex flex-col h-screen w-screen overflow-hidden bg-background-base"
      style={{ height: '100dvh' }}
    >
      {children}
    </div>
  );
}

/** 头部 */
export function Header({ title, children }: HeaderProps) {
  return (
    <header className="flex items-center justify-between px-5 h-14 bg-background-elevated border-b border-border shrink-0">
      <h1 className="text-base font-semibold text-text-primary">{title}</h1>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </header>
  );
}

/** 左侧边栏 */
export function Sidebar({ children, className = '', width }: SidebarProps) {
  const widthClass = width ? undefined : 'w-[180px]';
  const style = width ? { width: `${width}px` } : undefined;

  return (
    <aside
      className={`flex flex-col bg-background-elevated border-r border-border shrink-0 ${className}`}
      style={style}
      {...(width && { className: className + ' ' + widthClass })}
      {...(!width && { className: (widthClass || '') + ' ' + className })}
    >
      {children}
    </aside>
  );
}

/** 主内容区 */
export function Main({ children, className = '' }: MainProps) {
  return (
    <main className={`flex-1 flex overflow-hidden bg-background-base ${className}`}>
      {children}
    </main>
  );
}

/** 右侧面板 */
export function Aside({ children, className = '', width }: AsideProps) {
  const widthClass = width ? undefined : 'w-[280px]';
  const style = width ? { width: `${width}px` } : undefined;

  return (
    <aside
      className={`flex flex-col bg-background-elevated border-l border-border shrink-0 ${className}`}
      style={style}
      {...(width && { className: className + ' ' + widthClass })}
      {...(!width && { className: (widthClass || '') + ' ' + className })}
    >
      {children}
    </aside>
  );
}

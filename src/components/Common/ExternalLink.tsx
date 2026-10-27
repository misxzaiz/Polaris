/**
 * 统一外部链接组件
 *
 * 移动端（isMobileTauriRuntime）点击外链时 preventDefault + openExternalLink，
 * 避免单 WebView 被新页面替换导致 SPA 状态丢失。
 * 桌面端 / 纯浏览器：透传为普通 `<a target="_blank" rel="noopener noreferrer">`。
 *
 * 适用：项目内所有手写 `target="_blank"` 外链（markdown renderer 走全局 capture）。
 */

import { isMobileTauriRuntime } from '@/mobile/platform';
import { openExternalLink } from '@/services/linkExternal';
import { forwardRef } from 'react';

export interface ExternalLinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
}

/**
 * 移动端：preventDefault → openExternalLink
 * 桌面端：原样 a 标签，target="_blank"
 */
export const ExternalLink = forwardRef<HTMLAnchorElement, ExternalLinkProps>(
  function ExternalLink({ href, onClick, target = '_blank', rel = 'noopener noreferrer', children, ...rest }, ref) {
    const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (!isMobileTauriRuntime()) return;
      e.preventDefault();
      e.stopPropagation();
      void openExternalLink(href);
      // 仍转发 onClick（如果调用方有副作用）
      onClick?.(e);
    };

    return (
      <a
        ref={ref}
        href={href}
        target={target}
        rel={rel}
        onClick={handleClick}
        {...rest}
      >
        {children}
      </a>
    );
  },
);
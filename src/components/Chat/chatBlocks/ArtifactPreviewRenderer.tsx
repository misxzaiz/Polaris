import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Code2, Copy, Download, ExternalLink, FileText, Maximize2, X } from 'lucide-react';
import { clsx } from 'clsx';
import type { ArtifactPreviewBlock } from '@/types';
import { copyToClipboard } from '@/utils/clipboard';
import { isTauri } from '@/utils/platform';
import {
  openInDefaultApp,
  setFullscreen as tauriSetFullscreen,
  isFullscreen as tauriIsFullscreen,
  onFullscreenChange,
} from '@/services/tauri/windowService';

function safeFileName(value: string): string {
  // 控制字符 \x00-\x1F 通过 String.fromCharCode 构造，避免在正则字面量中直接出现（触发 no-control-regex）
  const controlChars = Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join('');
  const controlRe = new RegExp(`[<>:"/\\\\|?*${controlChars}]`, 'g');
  const normalized = value
    .trim()
    .replace(controlRe, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return (normalized || 'prd-preview').slice(0, 80);
}

function createHtmlBlobUrl(html: string): string {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  return URL.createObjectURL(blob);
}

/**
 * 全屏覆盖层距顶距离：保留顶部 TopMenuBar（h-10 = 40px）。
 * 用常量便于后续统一维护。
 */
const TOPBAR_HEIGHT = 40;

export const ArtifactPreviewRenderer = memo(function ArtifactPreviewRenderer({
  block,
}: {
  block: ArtifactPreviewBlock;
}) {
  const [showSource, setShowSource] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [copied, setCopied] = useState<'html' | 'path' | null>(null);

  const sizeLabel = useMemo(() => {
    const bytes = new Blob([block.html]).size;
    if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    if (bytes > 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
  }, [block.html]);

  const createdLabel = useMemo(() => {
    if (!block.createdAt) return null;
    const date = new Date(block.createdAt);
    if (Number.isNaN(date.getTime())) return null;
    return new Intl.DateTimeFormat(undefined, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  }, [block.createdAt]);

  const versionLabel = block.versionLabel || (block.version ? `v${block.version}` : null);

  const copyHtml = useCallback(async () => {
    await copyToClipboard(block.html);
    setCopied('html');
    window.setTimeout(() => setCopied(null), 1400);
  }, [block.html]);

  const copyPath = useCallback(async () => {
    if (!block.sourcePath) return;
    await copyToClipboard(block.sourcePath);
    setCopied('path');
    window.setTimeout(() => setCopied(null), 1400);
  }, [block.sourcePath]);

  const openBlobPreview = useCallback(() => {
    const url = createHtmlBlobUrl(block.html);
    const opened = window.open(url, '_blank', 'noopener,noreferrer');
    window.setTimeout(() => URL.revokeObjectURL(url), opened ? 30_000 : 1_000);
  }, [block.html]);

  const openInBrowser = useCallback(async () => {
    if (isTauri() && block.sourcePath) {
      try {
        await openInDefaultApp(block.sourcePath);
        return;
      } catch {
        openBlobPreview();
        return;
      }
    }
    openBlobPreview();
  }, [block.sourcePath, openBlobPreview]);

  const downloadHtml = useCallback(() => {
    const url = createHtmlBlobUrl(block.html);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${safeFileName(block.title)}.html`;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }, [block.html, block.title]);

  // 进入全屏：让整个应用窗口全屏（Tauri setFullscreen / 浏览器 Fullscreen API）
  const handleEnterFullscreen = useCallback(async () => {
    try {
      if (isTauri()) {
        await tauriSetFullscreen(true);
      } else {
        await document.documentElement.requestFullscreen();
      }
      setIsFullscreen(true);
    } catch {
      // 浏览器可能因用户交互要求限制拒绝 requestFullscreen，静默失败
    }
  }, []);

  // 退出全屏
  const handleExitFullscreen = useCallback(async () => {
    try {
      if (isTauri()) {
        await tauriSetFullscreen(false);
      } else if (document.fullscreenElement) {
        await document.exitFullscreen();
      }
    } catch {
      // 静默失败
    }
    setIsFullscreen(false);
  }, []);

  // 状态同步：挂载时初始化 + 监听全屏状态变化
  // Tauri 模式下 setFullscreen 是窗口级操作，不触发 DOM fullscreenchange，
  // 因此用 onResized + isFullscreen() 检测；Web 模式用原生 fullscreenchange。
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    if (isTauri()) {
      // 挂载时同步当前状态（防止重挂载时状态错位）
      tauriIsFullscreen().then(setIsFullscreen).catch(() => {});
      // 监听窗口大小变化（全屏切换会触发 onResized）
      onFullscreenChange((fs) => setIsFullscreen(fs))
        .then((fn) => { unlisten = fn; })
        .catch(() => {});
    } else {
      const handler = () => setIsFullscreen(!!document.fullscreenElement);
      document.addEventListener('fullscreenchange', handler);
      return () => document.removeEventListener('fullscreenchange', handler);
    }

    return () => { unlisten?.(); };
  }, []);

  // Escape 兜底退出（onResized 在窗口大小未变化时可能不触发，需保留键盘兜底）
  useEffect(() => {
    if (!isFullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        void handleExitFullscreen();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isFullscreen, handleExitFullscreen]);

  const previewFrame = (
    <iframe
      title={block.title}
      srcDoc={block.html}
      sandbox="allow-scripts allow-forms allow-popups allow-modals"
      className="h-full w-full bg-white"
      loading="lazy"
      referrerPolicy="no-referrer"
    />
  );

  return (
    <>
    <section className="my-2 w-full overflow-hidden rounded-lg border border-border bg-background-elevated">
      <header className="flex min-w-0 items-center gap-2 border-b border-border bg-background-surface px-3 py-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-cyan-500/10 text-cyan-400">
          <FileText className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-text-primary">{block.title}</div>
          {block.description && (
            <div className="mt-0.5 truncate text-[11px] text-text-secondary" title={block.description}>
              {block.description}
            </div>
          )}
          <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-text-tertiary">
            <span className="shrink-0">HTML</span>
            <span className="h-1 w-1 shrink-0 rounded-full bg-text-muted" />
            <span className="shrink-0">{sizeLabel}</span>
            {versionLabel && (
              <>
                <span className="h-1 w-1 shrink-0 rounded-full bg-text-muted" />
                <span className="shrink-0">{versionLabel}</span>
              </>
            )}
            {createdLabel && (
              <>
                <span className="h-1 w-1 shrink-0 rounded-full bg-text-muted" />
                <span className="shrink-0">{createdLabel}</span>
              </>
            )}
            {block.requirementId && (
              <>
                <span className="h-1 w-1 shrink-0 rounded-full bg-text-muted" />
                <span className="max-w-[10rem] truncate" title={block.requirementId}>
                  {block.requirementId}
                </span>
              </>
            )}
            {block.sourcePath && (
              <>
                <span className="h-1 w-1 shrink-0 rounded-full bg-text-muted" />
                <button
                  type="button"
                  className="truncate text-left hover:text-text-secondary"
                  onClick={copyPath}
                  title={block.sourcePath}
                >
                  {copied === 'path' ? '已复制路径' : block.sourcePath}
                </button>
              </>
            )}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-background-hover hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
            onClick={copyHtml}
            title={copied === 'html' ? '已复制 HTML' : '复制 HTML'}
          >
            {copied === 'html' ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-background-hover hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
            onClick={() => setShowSource((value) => !value)}
            title={showSource ? '收起源码' : '查看源码'}
          >
            <Code2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-background-hover hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
            onClick={downloadHtml}
            title="下载 HTML"
          >
            <Download className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-background-hover hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
            onClick={handleEnterFullscreen}
            title="全屏预览"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-background-hover hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
            onClick={openInBrowser}
            title={isTauri() && block.sourcePath ? '在浏览器打开' : '在新标签页打开'}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <div className="bg-background-base p-2">
        <div className="h-[420px] min-h-[320px] overflow-hidden rounded-md border border-border bg-white">
          {previewFrame}
        </div>
      </div>

      {showSource && (
        <div className="border-t border-border bg-background-surface p-3">
          <pre
            className={clsx(
              'max-h-72 overflow-auto rounded-md bg-background-surface p-3',
              'font-mono text-xs leading-relaxed text-text-secondary'
            )}
          >
            {block.html}
          </pre>
        </div>
      )}
    </section>

    {isFullscreen && createPortal(
      <div
        className="fixed inset-x-0 bottom-0 z-[60] flex flex-col bg-background-base"
        style={{ top: `${TOPBAR_HEIGHT}px` }}
        role="dialog"
        aria-modal="true"
        aria-label={`${block.title} 全屏预览`}
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background-elevated px-4">
          <FileText className="h-4 w-4 text-cyan-400" />
          <div className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{block.title}</div>
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-background-hover hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
            onClick={openInBrowser}
            title={isTauri() && block.sourcePath ? '在浏览器打开' : '在新标签页打开'}
          >
            <ExternalLink className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md bg-red-500 px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-red-600 focus:outline-none focus:ring-2 focus:ring-red-500/50"
            onClick={handleExitFullscreen}
            title="退出全屏"
          >
            <X className="h-3.5 w-3.5" />
            退出全屏
          </button>
        </div>
        <div className="min-h-0 flex-1 bg-white">
          {previewFrame}
        </div>
      </div>,
      document.body
    )}
    </>
  );
});
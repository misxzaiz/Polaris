import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Code2, Copy, Download, ExternalLink, FileText, Maximize2, X } from 'lucide-react';
import { clsx } from 'clsx';
import type { ArtifactPreviewBlock } from '@/types';
import { copyToClipboard } from '@/utils/clipboard';
import { isTauri } from '@/utils/platform';
import { openInDefaultApp } from '@/services/tauri/windowService';

function safeFileName(value: string): string {
  const normalized = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return (normalized || 'prd-preview').slice(0, 80);
}

function createHtmlBlobUrl(html: string): string {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  return URL.createObjectURL(blob);
}

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

  useEffect(() => {
    if (!isFullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsFullscreen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isFullscreen]);

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
            onClick={() => setIsFullscreen(true)}
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
        <div className="border-t border-border bg-background-subtle p-3">
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

    {isFullscreen && (
      <div
        className="fixed inset-0 z-[60] flex flex-col bg-background-base"
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
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-background-hover hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
            onClick={() => setIsFullscreen(false)}
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 bg-white">
          {previewFrame}
        </div>
      </div>
    )}
    </>
  );
});

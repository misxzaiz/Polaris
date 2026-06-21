import { memo, useCallback, useMemo, useState } from 'react';
import { Check, Code2, Copy, ExternalLink, FileText } from 'lucide-react';
import { clsx } from 'clsx';
import type { ArtifactPreviewBlock } from '@/types';
import { copyToClipboard } from '@/utils/clipboard';

export const ArtifactPreviewRenderer = memo(function ArtifactPreviewRenderer({
  block,
}: {
  block: ArtifactPreviewBlock;
}) {
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState<'html' | 'path' | null>(null);

  const sizeLabel = useMemo(() => {
    const bytes = new Blob([block.html]).size;
    if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    if (bytes > 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
  }, [block.html]);

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

  const openInNewTab = useCallback(() => {
    const blob = new Blob([block.html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const opened = window.open(url, '_blank', 'noopener,noreferrer');
    window.setTimeout(() => URL.revokeObjectURL(url), opened ? 30_000 : 1_000);
  }, [block.html]);

  return (
    <section className="my-2 w-full overflow-hidden rounded-lg border border-border bg-background-elevated">
      <header className="flex min-w-0 items-center gap-2 border-b border-border bg-background-surface px-3 py-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-cyan-500/10 text-cyan-400">
          <FileText className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-text-primary">{block.title}</div>
          <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-text-tertiary">
            <span className="shrink-0">HTML</span>
            <span className="h-1 w-1 shrink-0 rounded-full bg-text-muted" />
            <span className="shrink-0">{sizeLabel}</span>
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
            onClick={openInNewTab}
            title="在新标签页打开"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <div className="bg-background-base p-2">
        <div className="h-[420px] min-h-[320px] overflow-hidden rounded-md border border-border bg-white">
          <iframe
            title={block.title}
            srcDoc={block.html}
            sandbox="allow-scripts allow-forms allow-popups allow-modals"
            className="h-full w-full bg-white"
            loading="lazy"
            referrerPolicy="no-referrer"
          />
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
  );
});

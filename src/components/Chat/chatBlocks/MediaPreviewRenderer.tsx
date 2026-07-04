import { memo, useCallback, useMemo, useState } from 'react';
import { Check, Copy, Download, ExternalLink, Image, Loader2, Video, X } from 'lucide-react';
import { clsx } from 'clsx';
import type { MediaPreviewBlock } from '@/types';
import { copyToClipboard } from '@/utils/clipboard';

export const MediaPreviewRenderer = memo(function MediaPreviewRenderer({
  block,
}: {
  block: MediaPreviewBlock;
}) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [copied, setCopied] = useState<'url' | 'prompt' | null>(null);
  const [imgError, setImgError] = useState(false);

  const isImage = block.mediaType === 'image';
  const isVideo = block.mediaType === 'video';

  const mediaSrc = useMemo(() => {
    if (block.url) return block.url;
    if (block.base64 && block.mimeType) {
      return `data:${block.mimeType};base64,${block.base64}`;
    }
    return null;
  }, [block.url, block.base64, block.mimeType]);

  const copyUrl = useCallback(async () => {
    if (block.url) {
      await copyToClipboard(block.url);
      setCopied('url');
      window.setTimeout(() => setCopied(null), 1400);
    }
  }, [block.url]);

  const copyPrompt = useCallback(async () => {
    if (block.prompt) {
      await copyToClipboard(block.prompt);
      setCopied('prompt');
      window.setTimeout(() => setCopied(null), 1400);
    }
  }, [block.prompt]);

  const downloadMedia = useCallback(() => {
    if (!mediaSrc) return;
    const anchor = document.createElement('a');
    anchor.href = mediaSrc;
    anchor.download = isImage ? 'agnes-image.png' : 'agnes-video.mp4';
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  }, [mediaSrc, isImage]);

  const openInNewTab = useCallback(() => {
    if (mediaSrc) {
      window.open(mediaSrc, '_blank', 'noopener,noreferrer');
    }
  }, [mediaSrc]);

  if (block.waiting || (block.status && block.status !== 'completed' && block.status !== 'failed')) {
    return (
      <section className="my-2 w-full overflow-hidden rounded-lg border border-border bg-background-elevated">
        <header className="flex min-w-0 items-center gap-2 border-b border-border bg-background-surface px-3 py-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-amber-500/10 text-amber-400">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-text-primary">
              {isVideo ? '视频生成中' : '图片生成中'}
            </div>
            <div className="mt-0.5 text-[11px] text-text-tertiary">
              {block.progress !== undefined && `进度: ${block.progress}%`}
              {block.status && ` · 状态: ${block.status}`}
            </div>
          </div>
        </header>
        <div className="flex items-center justify-center bg-background-base p-8">
          <Loader2 className="h-8 w-8 animate-spin text-text-muted" />
        </div>
      </section>
    );
  }

  if (block.status === 'failed' || block.error) {
    return (
      <section className="my-2 w-full overflow-hidden rounded-lg border border-red-500/30 bg-background-elevated">
        <header className="flex min-w-0 items-center gap-2 border-b border-border bg-background-surface px-3 py-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-red-500/10 text-red-400">
            <X className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-text-primary">
              {isVideo ? '视频生成失败' : '图片生成失败'}
            </div>
            {block.error && (
              <div className="mt-0.5 truncate text-[11px] text-red-400">{block.error}</div>
            )}
          </div>
        </header>
      </section>
    );
  }

  if (!mediaSrc) {
    return (
      <section className="my-2 w-full overflow-hidden rounded-lg border border-border bg-background-elevated">
        <header className="flex min-w-0 items-center gap-2 bg-background-surface px-3 py-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-text-muted/10 text-text-muted">
            {isImage ? <Image className="h-4 w-4" /> : <Video className="h-4 w-4" />}
          </div>
          <div className="text-sm text-text-secondary">无可用媒体资源</div>
        </header>
      </section>
    );
  }

  const mediaElement = isImage ? (
    <img
      src={mediaSrc}
      alt={block.prompt || 'Generated image'}
      className="max-h-[600px] w-full object-contain"
      onError={() => setImgError(true)}
    />
  ) : (
    <video
      src={mediaSrc}
      controls
      autoPlay={false}
      className="max-h-[600px] w-full object-contain"
    />
  );

  return (
    <>
      <section className="my-2 w-full overflow-hidden rounded-lg border border-border bg-background-elevated">
        <header className="flex min-w-0 items-center gap-2 border-b border-border bg-background-surface px-3 py-2">
          <div
            className={clsx(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
              isImage ? 'bg-blue-500/10 text-blue-400' : 'bg-purple-500/10 text-purple-400'
            )}
          >
            {isImage ? <Image className="h-4 w-4" /> : <Video className="h-4 w-4" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-text-primary">
              {isImage ? 'AI 生成图片' : 'AI 生成视频'}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-text-tertiary">
              {block.model && (
                <>
                  <span className="shrink-0">{block.model}</span>
                  <span className="h-1 w-1 shrink-0 rounded-full bg-text-muted" />
                </>
              )}
              {block.size && (
                <>
                  <span className="shrink-0">{block.size}</span>
                  <span className="h-1 w-1 shrink-0 rounded-full bg-text-muted" />
                </>
              )}
              {isVideo && block.seconds && (
                <>
                  <span className="shrink-0">{block.seconds}s</span>
                  <span className="h-1 w-1 shrink-0 rounded-full bg-text-muted" />
                </>
              )}
            </div>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {block.url && (
              <button
                type="button"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-background-hover hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
                onClick={copyUrl}
                title={copied === 'url' ? '已复制 URL' : '复制 URL'}
              >
                {copied === 'url' ? (
                  <Check className="h-3.5 w-3.5 text-success" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </button>
            )}
            {block.prompt && (
              <button
                type="button"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-background-hover hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
                onClick={copyPrompt}
                title={copied === 'prompt' ? '已复制提示词' : '复制提示词'}
              >
                {copied === 'prompt' ? (
                  <Check className="h-3.5 w-3.5 text-success" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </button>
            )}
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-background-hover hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
              onClick={downloadMedia}
              title="下载"
            >
              <Download className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-background-hover hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
              onClick={() => setIsFullscreen(true)}
              title="全屏预览"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </button>
          </div>
        </header>

        <div className="bg-background-base p-2">
          <div className="overflow-hidden rounded-md border border-border bg-black">
            {imgError ? (
              <div className="flex items-center justify-center p-8 text-text-secondary">
                图片加载失败
              </div>
            ) : (
              mediaElement
            )}
          </div>
        </div>

        {block.prompt && (
          <div className="border-t border-border bg-background-subtle px-3 py-2">
            <div className="text-[11px] text-text-tertiary">
              <span className="font-medium text-text-secondary">提示词：</span>
              <span className="ml-1">{block.prompt}</span>
            </div>
          </div>
        )}
      </section>

      {isFullscreen && (
        <div
          className="fixed inset-0 z-[60] flex flex-col bg-black"
          role="dialog"
          aria-modal="true"
          aria-label={isImage ? '图片全屏预览' : '视频全屏预览'}
        >
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background-elevated px-4">
            <div
              className={clsx(
                'flex h-6 w-6 items-center justify-center rounded-md',
                isImage ? 'bg-blue-500/10 text-blue-400' : 'bg-purple-500/10 text-purple-400'
              )}
            >
              {isImage ? <Image className="h-3.5 w-3.5" /> : <Video className="h-3.5 w-3.5" />}
            </div>
            <div className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
              {isImage ? 'AI 生成图片' : 'AI 生成视频'}
            </div>
            {block.url && (
              <button
                type="button"
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-background-hover px-2.5 text-xs text-text-secondary transition-colors hover:text-text-primary"
                onClick={openInNewTab}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                新标签页打开
              </button>
            )}
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-background-hover hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
              onClick={() => setIsFullscreen(false)}
              title="关闭"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 flex items-center justify-center bg-black p-4">
            {imgError ? (
              <div className="text-text-secondary">图片加载失败</div>
            ) : isImage ? (
              <img
                src={mediaSrc}
                alt={block.prompt || 'Generated image'}
                className="max-h-full max-w-full object-contain"
              />
            ) : (
              <video
                src={mediaSrc}
                controls
                autoPlay
                className="max-h-full max-w-full object-contain"
              />
            )}
          </div>
        </div>
      )}
    </>
  );
});

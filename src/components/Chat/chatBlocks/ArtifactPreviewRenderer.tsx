import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Code2, Copy, Download, Expand, ExternalLink, FileText, Maximize2, Minimize2, MoreHorizontal, Scan, X } from 'lucide-react';
import { clsx } from 'clsx';
import type { ArtifactPreviewBlock } from '@/types';
import { copyToClipboard } from '@/utils/clipboard';
import { isTauri } from '@/utils/platform';
import { invoke } from '@/services/transport';
import {
  openInDefaultApp,
} from '@/services/tauri/windowService';
import { forwardCardCapRequest } from '@/utils/htmlCardCapBridge';

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
 * 预览页滚动条细化：iframe 内页超出视口时出现的是浏览器原生宽滚动条，观感突兀。
 * 在展示层向 srcDoc 注入一段 CSS（细滚动条、悬停加深、Firefox 走 scrollbar-width: thin），
 * 仅作用于渲染派生串，不回写存储的 html（下载/浏览器打开仍是原始文件）。
 */
const PREVIEW_SCROLL_CSS = [
  '<style>',
  '::-webkit-scrollbar { width: 6px; height: 6px; }',
  '::-webkit-scrollbar-track { background: transparent; }',
  '::-webkit-scrollbar-thumb { background: rgba(127,127,140,0.45); border-radius: 3px; }',
  '::-webkit-scrollbar-thumb:hover { background: rgba(127,127,140,0.65); }',
  '* { scrollbar-width: thin; scrollbar-color: rgba(127,127,140,0.45) transparent; }',
  '</style>',
].join('');

/** 注入点优先级：</head> → <body> 开标签后 → doctype 后；避免插到 doctype 之前（触发怪异模式） */
function withPreviewChrome(html: string): string {
  const closeHead = html.search(/<\/head>/i);
  if (closeHead >= 0) {
    return html.slice(0, closeHead) + PREVIEW_SCROLL_CSS + html.slice(closeHead);
  }
  const bodyMatch = /<body[^>]*>/i.exec(html);
  if (bodyMatch && bodyMatch.index !== undefined) {
    const end = bodyMatch.index + bodyMatch[0].length;
    return html.slice(0, end) + PREVIEW_SCROLL_CSS + html.slice(end);
  }
  if (/^<!doctype\s/i.test(html)) {
    const gt = html.indexOf('>');
    if (gt >= 0) return html.slice(0, gt + 1) + PREVIEW_SCROLL_CSS + html.slice(gt + 1);
  }
  return PREVIEW_SCROLL_CSS + html;
}

/**
 * 全屏覆盖层距顶距离：保留顶部 TopMenuBar（h-10 = 40px）。
 */
const TOPBAR_HEIGHT = 40;
/** 全屏工具栏高度（h-12 = 48px）与内容区上下 padding（16×2）：等比档可用高度扣减项 */
const FS_TOOLBAR_HEIGHT = 48;
const FS_CONTENT_PADDING = 32;

/**
 * 内嵌预览高度：min(50vh, 480px)，所有卡片宽度统一。
 * 首轮 75vh/760px 实测偏高大半屏；调低为 50vh/480px（约对话面板高度一半），
 * 兼顾预览信息密度与聊天上下文可见性。
 */
const FRAME_VH_RATIO = 0.5;
const FRAME_HEIGHT_CAP = 480;
/**
 * localStorage 记忆全屏档位 key。v2：默认档由等比改为铺满（用户定），换 key
 * 使旧档位记忆不覆盖新默认。
 */
const FS_MODE_KEY = 'polaris.preview.fsmode.v2';

/** 底部状态条图标按钮（24px，条高 32px 内） */
const ICON_BTN_CLS =
  'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-background-hover hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50';

/** 「更多」菜单项（底部状态条向上展开） */
function MoreMenuItem({ icon: Icon, label, onClick }: { icon: typeof Copy; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-text-secondary hover:bg-background-hover hover:text-text-primary"
      onClick={onClick}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

export const ArtifactPreviewRenderer = memo(function ArtifactPreviewRenderer({
  block,
  versions,
}: {
  block: ArtifactPreviewBlock;
  /** 同 requirementId 的全部版本（升序、含本块）；≥2 版时状态条显示版本 pills */
  versions?: ArtifactPreviewBlock[];
}) {
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState<'html' | 'path' | null>(null);
  // 应用内全屏覆盖层（放大本卡片，等比 letterbox / 铺满两档）
  const [isFullscreen, setIsFullscreen] = useState(false);
  // 全屏档位：'fill'（铺满，默认）/ 'ratio'（等比 letterbox）。选择写 localStorage 记忆
  const [fsMode, setFsMode] = useState<'ratio' | 'fill'>(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(FS_MODE_KEY) : null;
    return saved === 'ratio' ? 'ratio' : 'fill';
  });
  // 更多操作菜单（复制 HTML / 下载 / 查看源码 收敛其后）
  const [moreOpen, setMoreOpen] = useState(false);

  // 版本 pills：null = 跟随最新版；切 pills 记录绝对下标（新版本追加不丢用户定位），
  // 版本数变化时归位最新
  const [activeVersionIdx, setActiveVersionIdx] = useState<number | null>(null);
  const displayBlock = useMemo<ArtifactPreviewBlock>(() => {
    if (versions && versions.length > 0) {
      const idx = activeVersionIdx != null
        ? Math.min(activeVersionIdx, versions.length - 1)
        : versions.length - 1;
      return versions[idx] ?? block;
    }
    return block;
  }, [versions, activeVersionIdx, block]);
  useEffect(() => {
    setActiveVersionIdx(null);
  }, [versions?.length]);

  // 加载骨架：iframe onLoad 前显示与聊天背景同色的骨架，避免白底首帧直现（白闪）
  const [frameLoaded, setFrameLoaded] = useState(false);
  useEffect(() => {
    setFrameLoaded(false);
  }, [displayBlock.html]);

  // 滚动条细化注入：仅渲染派生串（源码查看/下载/新窗仍用原始 html）
  const previewHtml = useMemo(() => withPreviewChrome(displayBlock.html), [displayBlock.html]);

  const previewFrameRef = useRef<HTMLIFrameElement | null>(null);
  // 内嵌预览盒：进全屏前实测宽高比用
  const previewBoxRef = useRef<HTMLDivElement | null>(null);
  // 卡片根元素：弹出加宽时捕获锚定矩形用
  const cardRef = useRef<HTMLElement | null>(null);

  // iframe 高度：min(50vh, 480px)，与卡片宽度解耦（详见 FRAME_VH_RATIO 注释）
  const frameHeight = useMemo(() => {
    const vh = typeof window !== 'undefined' ? window.innerHeight : 900;
    return Math.round(Math.min(vh * FRAME_VH_RATIO, FRAME_HEIGHT_CAP));
  }, []);

  const sizeLabel = useMemo(() => {
    const bytes = new Blob([displayBlock.html]).size;
    if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    if (bytes > 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
  }, [displayBlock.html]);

  const createdLabel = useMemo(() => {
    if (!displayBlock.createdAt) return null;
    const date = new Date(displayBlock.createdAt);
    if (Number.isNaN(date.getTime())) return null;
    return new Intl.DateTimeFormat(undefined, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  }, [displayBlock.createdAt]);

  const copyHtml = useCallback(async () => {
    await copyToClipboard(displayBlock.html);
    setCopied('html');
    window.setTimeout(() => setCopied(null), 1400);
  }, [displayBlock.html]);

  const copyPath = useCallback(async () => {
    if (!displayBlock.sourcePath) return;
    await copyToClipboard(displayBlock.sourcePath);
    setCopied('path');
    window.setTimeout(() => setCopied(null), 1400);
  }, [displayBlock.sourcePath]);

  const openBlobPreview = useCallback(() => {
    const url = createHtmlBlobUrl(displayBlock.html);
    const opened = window.open(url, '_blank', 'noopener,noreferrer');
    window.setTimeout(() => URL.revokeObjectURL(url), opened ? 30_000 : 1_000);
  }, [displayBlock.html]);

  const openInBrowser = useCallback(async () => {
    if (isTauri() && displayBlock.sourcePath) {
      try {
        await openInDefaultApp(displayBlock.sourcePath);
        return;
      } catch {
        openBlobPreview();
        return;
      }
    }
    openBlobPreview();
  }, [displayBlock.sourcePath, openBlobPreview]);

  const downloadHtml = useCallback(() => {
    const url = createHtmlBlobUrl(displayBlock.html);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${safeFileName(displayBlock.title)}.html`;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }, [displayBlock.html, displayBlock.title]);

  // ===== 应用内全屏（只放大本卡片，替代 Tauri 窗口级全屏） =====
  // 根因（plans/prd-preview-card-ui-overhaul.md §二.1）：Tauri setFullscreen 是窗口级，
  // 多会话并排时点「全屏」整窗全屏且停在旧滚动位置 → 观感「第二个会话显示第一个」。
  // 改为应用内覆盖层，只放大目标卡片；退出回归原位。
  // 进全屏前实测内嵌预览盒宽高比（plans/prd-preview-ux-optimization.md 线2 验收：
  // 全屏 = 内嵌同比例放大，非固定正方形）
  const [fsRatio, setFsRatio] = useState(9 / 16);
  // ===== 弹出加宽（×2）：fixed 浮层 portal 到 body =====
  // 卡片宽度被多会话格宽（默认 350px）锁死，这是"预览窄"的根因；组件树内
  // position:fixed 会被 Virtuoso 的 transform 定位劫持为相对定位 —— 必须
  // portal 到 document.body（与全屏覆盖层同模式）。
  const [isExpanded, setIsExpanded] = useState(false);
  const [expandedLayout, setExpandedLayout] = useState({ left: 0, top: 0, width: 0, frameHeight: 0 });

  const handleEnterFullscreen = useCallback(() => {
    const rect = previewBoxRef.current?.getBoundingClientRect();
    const w = rect?.width ?? 0;
    const h = rect?.height ?? 0;
    if (w > 0 && h > 0) setFsRatio(w / h);
    setIsExpanded(false); // 与弹出加宽互斥
    setIsFullscreen(true);
  }, []);

  const handleExitFullscreen = useCallback(() => {
    setIsFullscreen(false);
  }, []);

  const toggleFsMode = useCallback(() => {
    setFsMode((prev) => {
      const next = prev === 'ratio' ? 'fill' : 'ratio';
      try {
        localStorage.setItem(FS_MODE_KEY, next);
      } catch {
        // 隐私模式等场景静默失败
      }
      return next;
    });
  }, []);

  const handleToggleExpanded = useCallback(() => {
    if (isExpanded) {
      setIsExpanded(false);
      return;
    }
    setIsFullscreen(false); // 与全屏互斥
    const rect = cardRef.current?.getBoundingClientRect();
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 900;
    // ×2 落点：面板宽 = 卡片宽 ×2，视口装不下则取可用宽
    const width = Math.max(280, Math.min((rect?.width ?? 0) * 2, vw - 32));
    const expandedFrameHeight = Math.round(vh * 0.5);
    const panelHeight = expandedFrameHeight + 64; // 迷你工具栏 h-10 + padding
    const left = Math.min(Math.max(rect?.left ?? 16, 16), Math.max(16, vw - width - 16));
    const top = Math.min(
      Math.max(rect?.top ?? TOPBAR_HEIGHT + 8, TOPBAR_HEIGHT + 8),
      Math.max(TOPBAR_HEIGHT + 8, vh - panelHeight - 8)
    );
    setExpandedLayout({ left, top, width, frameHeight: expandedFrameHeight });
    setIsExpanded(true);
  }, [isExpanded, cardRef]);

  // Escape 兜底退出：先收弹出加宽，再退全屏
  useEffect(() => {
    if (!isFullscreen && !isExpanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (isExpanded) setIsExpanded(false);
      else handleExitFullscreen();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isFullscreen, isExpanded, handleExitFullscreen]);

  // 更多菜单：点击外部关闭（菜单本体 stopPropagation 自持）
  useEffect(() => {
    if (!moreOpen) return;
    const onPointerDown = () => setMoreOpen(false);
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [moreOpen]);

  // HTML 卡片 Cap 桥：监听卡片 iframe 的 postMessage 请求并转发 RouterBus。
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const source = event.source
      const frameWin = previewFrameRef.current?.contentWindow
      if (!source || !frameWin || source !== frameWin) return
      const data = event.data
      if (!data || typeof data !== 'object') return

      void forwardCardCapRequest(data, invoke).then((reply) => {
        if (!reply) return
        try {
          frameWin.postMessage(reply, '*')
        } catch {
          // 卡片已卸载/跨源异常：忽略
        }
      })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, []);

  // previewFrame 同一元素在内嵌/全屏/加宽三处按互斥条件复用：非激活位置不渲染，
  // 避免同屏多份 iframe 副本；切回时 srcDoc 重载（KB 级本地 HTML，骨架兜住白闪）。
  const previewFrame = (
    <iframe
      ref={previewFrameRef}
      title={displayBlock.title}
      srcDoc={previewHtml}
      sandbox="allow-scripts allow-forms allow-popups allow-modals"
      className="h-full w-full bg-white"
      loading="lazy"
      referrerPolicy="no-referrer"
      onLoad={() => setFrameLoaded(true)}
    />
  );

  // 版本 pills：≥2 版时渲染为分段控件，底部状态条与全屏/加宽工具栏共用
  const versionPills = versions && versions.length > 1 ? (
    <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-background-base p-0.5" role="tablist" aria-label="历史版本切换">
      {versions.map((v, i) => {
        const active = displayBlock.previewId === v.previewId;
        return (
          <button
            key={v.previewId}
            type="button"
            role="tab"
            aria-selected={active}
            className={clsx(
              'rounded px-2 py-0.5 text-[10px] font-medium transition-colors',
              active
                ? 'bg-background-elevated text-cyan-400 shadow-sm'
                : 'text-text-tertiary hover:text-text-primary'
            )}
            onClick={() => setActiveVersionIdx(i)}
            title={v.title}
          >
            {v.versionLabel || (v.version != null ? `v${v.version}` : `#${i + 1}`)}
          </button>
        );
      })}
    </div>
  ) : null;

  return (
    <>
    <section ref={cardRef} className="my-2 w-full overflow-hidden border bg-background-elevated" style={{ borderRadius: 'var(--chat-bubble-radius, 16px)' }}>
      {/* 预览区直通卡片上缘（无头部栏）；onLoad 前骨架防白闪 */}
      <div
        ref={previewBoxRef}
        className="relative overflow-hidden bg-white"
        style={{ height: frameHeight }}
      >
        {previewFrame}
        {!frameLoaded && (
          <div className="absolute inset-0 flex items-center justify-center bg-background-surface" aria-hidden="true">
            <div className="h-8 w-8 animate-pulse rounded-lg bg-background-hover" />
          </div>
        )}
      </div>

      {/* 底部沉浸状态条（定稿方案 A：悬浮条依赖 hover 在触屏 App 上不可操作，故选
          常驻底栏）——常驻仅 全屏/更多 两键；加宽/新窗/复制路径与元信息收进更多菜单 */}
      <footer className="flex h-8 min-w-0 items-center gap-2 border-t bg-background-elevated pl-2.5 pr-1.5">
        <span
          className="flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[5px] bg-cyan-500/10 text-cyan-400"
          aria-hidden="true"
        >
          <FileText className="h-2.5 w-2.5" />
        </span>
        <div
          className="min-w-0 flex-1 truncate text-xs font-medium text-text-primary"
          title={[displayBlock.title, displayBlock.description].filter(Boolean).join('\n')}
        >
          {displayBlock.title}
        </div>
        {versionPills}
        <button type="button" className={ICON_BTN_CLS} onClick={handleEnterFullscreen} title="全屏预览" aria-label="全屏预览">
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className={clsx(ICON_BTN_CLS, isExpanded && 'bg-background-hover text-text-primary')}
          onClick={handleToggleExpanded}
          title="加宽预览（×2）"
          aria-pressed={isExpanded}
        >
          <Expand className="h-3.5 w-3.5" />
        </button>
        <div className="relative flex-none">
          <button
            type="button"
            className={ICON_BTN_CLS}
            onClick={(e) => {
              e.stopPropagation();
              setMoreOpen((v) => !v);
            }}
            title="更多操作"
            aria-expanded={moreOpen}
            aria-haspopup="menu"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
          {moreOpen && (
            <div
              className="absolute bottom-full right-0 z-dropdown mb-1 min-w-[10.5rem] overflow-hidden rounded-md border border-border bg-background-elevated py-1 shadow-xl"
              role="menu"
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
            >
              {/* 元信息行：原头部元信息收纳于此 */}
              <div className="border-b border-border px-3 py-1.5 text-[11px] leading-relaxed text-text-muted">
                HTML · {sizeLabel}
                {createdLabel ? ` · ${createdLabel}` : ''}
                {displayBlock.requirementId ? ` · ${displayBlock.requirementId}` : ''}
              </div>
              <MoreMenuItem
                icon={ExternalLink}
                label={isTauri() && displayBlock.sourcePath ? '在浏览器打开' : '在新标签页打开'}
                onClick={() => { void openInBrowser(); setMoreOpen(false); }}
              />
              <MoreMenuItem
                icon={copied === 'html' ? Check : Copy}
                label={copied === 'html' ? '已复制 HTML' : '复制 HTML'}
                onClick={() => { void copyHtml(); setMoreOpen(false); }}
              />
              {displayBlock.sourcePath && (
                <MoreMenuItem
                  icon={copied === 'path' ? Check : Copy}
                  label={copied === 'path' ? '已复制路径' : '复制路径'}
                  onClick={() => { void copyPath(); setMoreOpen(false); }}
                />
              )}
              <MoreMenuItem
                icon={Download}
                label="下载 HTML"
                onClick={() => { downloadHtml(); setMoreOpen(false); }}
              />
              <MoreMenuItem
                icon={Code2}
                label={showSource ? '收起源码' : '查看源码'}
                onClick={() => { setShowSource((v) => !v); setMoreOpen(false); }}
              />
            </div>
          )}
        </div>
      </footer>

      {showSource && (
        <div className="border-t border-border bg-background-surface p-3">
          <pre
            className={clsx(
              'max-h-72 overflow-auto rounded-md bg-background-surface p-3',
              'font-mono text-xs leading-relaxed text-text-secondary'
            )}
          >
            {displayBlock.html}
          </pre>
        </div>
      )}
    </section>

    {isExpanded && createPortal(
      <div
        className="fixed z-overlay flex flex-col overflow-hidden border border-border bg-background-elevated shadow-2xl"
        style={{
          left: expandedLayout.left,
          top: expandedLayout.top,
          width: expandedLayout.width,
          borderRadius: 'var(--chat-bubble-radius, 16px)',
        }}
        role="dialog"
        aria-label={`${displayBlock.title} 加宽预览`}
      >
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-background-surface px-3">
          <FileText className="h-4 w-4 shrink-0 text-cyan-400" />
          <div className="min-w-0 flex-1 truncate text-xs font-medium text-text-primary">{displayBlock.title}</div>
          {versionPills}
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-text-tertiary transition-colors hover:bg-background-hover hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
            onClick={handleToggleExpanded}
            title="收起加宽"
          >
            <Minimize2 className="h-3.5 w-3.5" />
            收起
          </button>
        </div>
        <div className="p-1.5">
          <div
            className="overflow-hidden bg-white"
            style={{
              height: expandedLayout.frameHeight,
              borderRadius: 'calc(var(--chat-bubble-radius, 16px) - 4px)',
            }}
          >
            {previewFrame}
          </div>
        </div>
      </div>,
      document.body
    )}

    {isFullscreen && createPortal(
      <div
        className="fixed inset-x-0 bottom-0 z-overlay flex flex-col bg-background-base"
        style={{ top: `${TOPBAR_HEIGHT}px` }}
        role="dialog"
        aria-modal="true"
        aria-label={`${displayBlock.title} 全屏预览`}
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background-elevated px-4">
          <FileText className="h-4 w-4 text-cyan-400" />
          <div className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{displayBlock.title}</div>
          {/* 等比 / 铺满 切换 */}
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium text-text-tertiary transition-colors hover:bg-background-hover hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
            onClick={toggleFsMode}
            title={fsMode === 'ratio' ? '切换为铺满' : '切换为等比'}
          >
            {fsMode === 'ratio' ? <Scan className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            {fsMode === 'ratio' ? '等比' : '铺满'}
          </button>
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-background-hover hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
            onClick={openInBrowser}
            title={isTauri() && displayBlock.sourcePath ? '在浏览器打开' : '在新标签页打开'}
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
        {/* 内容区：等比档按实测内嵌盒宽高比 letterbox 居中；铺满档 h-full w-full */}
        {fsMode === 'ratio' ? (
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden" style={{ padding: 16 }}>
            <div
              className="overflow-hidden bg-white shadow-xl"
              style={{
                width: `min(100%, calc((100vh - ${TOPBAR_HEIGHT + FS_TOOLBAR_HEIGHT + FS_CONTENT_PADDING}px) * ${fsRatio.toFixed(4)}))`,
                aspectRatio: `${fsRatio}`,
                borderRadius: 4,
              }}
            >
              {previewFrame}
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 bg-white">
            {previewFrame}
          </div>
        )}
      </div>,
      document.body
    )}
    </>
  );
});

/**
 * FilePage — 本地文件管理器
 *
 * 功能：
 * 1. 浏览 app_data_dir 下的文件目录（面包屑 + 列表）
 * 2. 查看：文本内联预览（代码高亮/Markdown）、图片 base64 inline
 * 3. 管理：重命名 / 删除 / 创建目录
 * 4. "发送到 AI"：读取文件内容后跳转到 AI 对话页
 *
 * 后端依赖：
 * - file_manager_ls(path) → JSON 数组 [ { name, is_dir, size, modified } ]
 * - file_read_base64(path) → { content(base64), size, mime }
 * - file_rename(old_path, new_name)
 * - file_delete_file(path, recursive?)
 * - create_directory(path)
 * - write_file(path, content)
 *
 * 设计原则：
 * - 不依赖重型文档预览库（Android WebView 兼容问题）
 * - 文本/代码/Markdown 用已有 highlight.js 渲染
 * - 图片用 base64 inline
 * - 大文件（>2MB）提示无法预览
 */

import { useState, useEffect, useCallback, useMemo, useRef } from "react";

// ============================================================================
// 类型
// ============================================================================

interface FileEntry {
  name: string;
  is_dir: boolean;
  size: number;
  modified: number; // Unix 秒
}

interface FileContent {
  content: string; // base64
  size: number;
  mime: string;
}

// ============================================================================
// 工具函数
// ============================================================================

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatModified(unixSec: number): string {
  if (!unixSec) return "";
  const d = new Date(unixSec * 1000);
  const now = Date.now();
  const diff = now - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

/** 判断是否为可内联预览的文本/代码文件 */
function isTextMime(mime: string): boolean {
  const textMimes = [
    "text/plain", "text/markdown", "application/json", "text/html", "text/xml",
    "text/css", "text/csv", "text/x-python", "text/javascript", "text/typescript",
    "text/x-rust", "text/x-java", "text/x-go", "text/x-yaml", "text/x-toml",
    "text/x-shellscript", "image/svg+xml", "application/xml", "application/json",
  ];
  return textMimes.some(t => mime.startsWith(t)) || mime.startsWith("text/");
}

/** 判断是否为图片 */
function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

/** 从文件名推断是否文本 */
function isLikelyText(name: string): boolean {
  const textExts = new Set([
    "txt", "md", "json", "html", "htm", "xml", "css", "csv", "py", "js", "ts",
    "tsx", "rs", "java", "go", "yaml", "yml", "toml", "sh", "bat", "ps1",
    "c", "cpp", "h", "hpp", "rb", "php", "swift", "kt", "kts", "cfg", "ini",
    "conf", "log", "env", "lock", "jsonl", "graphql", "sql",
  ]);
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return textExts.has(ext);
}

function getExtension(name: string): string {
  const parts = name.split(".");
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "";
}

// ============================================================================
// Invoke 封装（Tauri 命令调用）
// ============================================================================

async function invoke(cmd: string, payload?: Record<string, unknown>): Promise<string> {
  try {
    const { invoke: tInvoke } = await import("@tauri-apps/api/core");
    return tInvoke(cmd, payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(msg);
  }
}

// ============================================================================
// 文件类型图标
// ============================================================================

const FILE_ICON: Record<string, { emoji: string; color: string }> = {
  folder: { emoji: "📁", color: "text-warning" },
  txt: { emoji: "📄", color: "text-text-secondary" },
  md: { emoji: "📝", color: "text-primary" },
  json: { emoji: "{}", color: "text-[#89b4fa]" },
  js: { emoji: "📜", color: "text-warning" },
  ts: { emoji: "📜", color: "text-[#89b4fa]" },
  rs: { emoji: "🦀", color: "text-warning" },
  py: { emoji: "🐍", color: "text-warning" },
  html: { emoji: "🌐", color: "text-warning" },
  css: { emoji: "🎨", color: "text-primary" },
  svg: { emoji: "🖼", color: "text-primary" },
  png: { emoji: "🖼", color: "text-primary" },
  jpg: { emoji: "🖼", color: "text-primary" },
  jpeg: { emoji: "🖼", color: "text-primary" },
  gif: { emoji: "🖼", color: "text-primary" },
  webp: { emoji: "🖼", color: "text-primary" },
  docx: { emoji: "📄", color: "text-[#89b4fa]" },
  doc: { emoji: "📄", color: "text-[#89b4fa]" },
  pdf: { emoji: "📕", color: "text-danger" },
  pptx: { emoji: "📊", color: "text-warning" },
  zip: { emoji: "📦", color: "text-text-secondary" },
  log: { emoji: "📋", color: "text-text-secondary" },
};

function getFileIcon(name: string, isDir: boolean): { label: string; color: string } {
  if (isDir) return { label: "📁", color: "text-warning" };
  const ext = getExtension(name);
  const icon = FILE_ICON[ext] || FILE_ICON.txt;
  return { label: icon.emoji, color: icon.color };
}

// ============================================================================
// 主组件
// ============================================================================

export function FilePage() {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 查看器状态
  const [preview, setPreview] = useState<FileContent | null>(null);
  const [previewName, setPreviewName] = useState("");
  const [previewPath, setPreviewPath] = useState("");
  const [previewError, setPreviewError] = useState<string | null>(null);

  // 操作弹窗
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [createDirName, setCreateDirName] = useState("");
  const [showCreateDir, setShowCreateDir] = useState(false);

  // 搜索
  const [search, setSearch] = useState("");

  // 刷新
  const refresh = useCallback(async (path = currentPath) => {
    setLoading(true);
    setError(null);
    try {
      const raw = await invoke("file_manager_ls", { path });
      const data: FileEntry[] = JSON.parse(raw);
      setEntries(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [currentPath]);

  useEffect(() => { refresh(); }, [refresh]);

  // 面包屑
  const breadcrumbs = useMemo(() => {
    if (!currentPath) return [{ name: "根目录", path: "" }];
    const parts = currentPath.split("/").filter(Boolean);
    return [
      { name: "根目录", path: "" },
      ...parts.map((p, i) => ({ name: p, path: parts.slice(0, i + 1).join("/") })),
    ];
  }, [currentPath]);

  // 过滤后的列表
  const filtered = useMemo(() => {
    if (!search.trim()) return entries;
    const q = search.toLowerCase();
    return entries.filter(e => e.name.toLowerCase().includes(q));
  }, [entries, search]);

  // 导航
  const navigateTo = useCallback((path: string) => {
    setCurrentPath(path);
    setSearch("");
    setPreview(null);
    setPreviewError(null);
  }, []);

  const goBack = useCallback(() => {
    if (!currentPath) return;
    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    setCurrentPath(parts.join("/"));
    setSearch("");
    setPreview(null);
    setPreviewError(null);
  }, [currentPath]);

  // 打开文件（预览）
  const openFile = useCallback(async (name: string) => {
    const targetPath = currentPath ? `${currentPath}/${name}` : name;
    setPreview(null);
    setPreviewName(name);
    setPreviewPath(targetPath);
    setPreviewError(null);

    try {
      const raw = await invoke("file_read_base64", { path: targetPath });
      const data: FileContent = JSON.parse(raw);
      setPreview(data);
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : String(e));
    }
  }, [currentPath]);

  // 重命名
  const startRename = (name: string) => {
    setRenameTarget(name);
    setRenameValue(name);
  };
  const doRename = async () => {
    if (!renameTarget || !renameValue.trim()) return;
    if (renameValue.trim() === renameTarget) { setRenameTarget(null); return; }
    const oldPath = currentPath ? `${currentPath}/${renameTarget}` : renameTarget;
    try {
      await invoke("file_rename", { old_path: oldPath, new_name: renameValue.trim() });
      setRenameTarget(null);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // 删除
  const doDelete = async () => {
    if (!deleteTarget) return;
    const targetPath = currentPath ? `${currentPath}/${deleteTarget}` : deleteTarget;
    try {
      const entry = entries.find(e => e.name === deleteTarget);
      const recursive = entry?.is_dir ? true : undefined;
      await invoke("file_delete_file", { path: targetPath, recursive });
      setDeleteTarget(null);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // 创建目录
  const doCreateDir = async () => {
    if (!createDirName.trim()) return;
    const targetPath = currentPath ? `${currentPath}/${createDirName.trim()}` : createDirName.trim();
    try {
      await invoke("create_directory", { path: targetPath });
      setShowCreateDir(false);
      setCreateDirName("");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // 发送到 AI
  const sendToAI = useCallback(async (name: string) => {
    const targetPath = currentPath ? `${currentPath}/${name}` : name;
    try {
      const raw = await invoke("file_read_base64", { path: targetPath });
      const data: FileContent = JSON.parse(raw);
      // 尝试解码为文本（文本文件直接放入 AI，二进制文件提示无法直接处理）
      let content: string | null = null;
      if (isTextMime(data.mime) || isLikelyText(name)) {
        try {
          content = new TextDecoder().decode(
            Uint8Array.from(atob(data.content), c => c.charCodeAt(0))
          );
        } catch { content = null; }
      }
      // 通过事件通知 ChatPage 或跳转
      window.dispatchEvent(new CustomEvent("pocket-ai-send-file", {
        detail: { path: targetPath, name, content, size: data.size, mime: data.mime },
      }));
      // 跳转到 AI 页（通过 header 事件）
      window.dispatchEvent(new CustomEvent("pocket-navigate-to-ai", {}));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [currentPath]);

  const clearError = useCallback(() => setError(null), []);

  return (
    <div className="relative flex flex-col h-full">
      {/* 顶栏 */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <button onClick={goBack} disabled={currentPath === ""}
            className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px] bg-background-surface text-text-secondary transition-colors hover:bg-border disabled:opacity-30"
            title="返回">
            <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current stroke-2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l-6 6 6 6" /></svg>
          </button>
          <h3 className="text-[15px] font-semibold">文件</h3>
        </div>
        <div className="flex gap-1">
          <button onClick={() => refresh()} className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px] bg-background-surface text-text-secondary transition-colors hover:bg-border" title="刷新">
            <svg viewBox="0 0 24 24" className={`h-4 w-4 fill-none stroke-current stroke-2 ${loading ? "animate-spin" : ""}`} strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 15.6-6.3L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.6 6.3L3 16M3 21v-5h5" /></svg>
          </button>
          <button onClick={() => setShowCreateDir(true)} className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px] bg-primary text-background-base transition-opacity hover:opacity-90" title="新建文件夹">
            <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current stroke-2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          </button>
        </div>
      </div>

      {/* 面包屑 */}
      {breadcrumbs.length > 1 && (
        <div className="flex items-center gap-1.5 mb-2.5 flex-wrap">
          {breadcrumbs.map((b, i) => (
            <span key={b.path} className="flex items-center gap-1.5">
              {i > 0 && <span className="text-text-tertiary text-[10px]">›</span>}
              <button onClick={() => navigateTo(b.path)} className={`text-[11px] px-1.5 py-0.5 rounded-[6px] transition-colors ${i === breadcrumbs.length - 1 ? "font-semibold text-primary bg-primary/10" : "text-text-secondary hover:bg-background-surface"}`}>
                {b.name}
              </button>
            </span>
          ))}
        </div>
      )}

      {/* 搜索 */}
      <div className="relative mb-2.5">
        <svg viewBox="0 0 24 24" className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 fill-none stroke-text-tertiary stroke-2" strokeLinecap="round"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.3-4.3" /></svg>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索文件..."
          className="w-full rounded-[10px] border border-border bg-background-surface py-1.5 pl-9 pr-3 text-[13px] text-text-primary outline-none transition-[border-color,box-shadow] placeholder:text-text-tertiary focus:border-primary" />
      </div>

      {error && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/8 px-3 py-2">
          <span className="text-xs text-danger">{error}</span>
          <button onClick={clearError} className="ml-auto text-[10px] text-text-tertiary hover:text-text-primary">关闭</button>
        </div>
      )}

      {/* 文件列表 */}
      <div className="flex-1 space-y-1.5 overflow-y-auto">
        {loading && entries.length === 0 && <div className="py-8 text-center text-xs text-text-tertiary">加载中...</div>}
        {!loading && filtered.length === 0 && !error && (
          <div className="py-8 text-center text-xs text-text-tertiary">
            {currentPath ? "此目录为空" : "当前没有任何文件，让 AI 帮你生成一些"}
          </div>
        )}
        {filtered.map(entry => (
          <FileRow
            key={entry.name}
            entry={entry}
            onOpen={() => entry.is_dir ? navigateTo(currentPath ? `${currentPath}/${entry.name}` : entry.name) : openFile(entry.name)}
            onRename={() => startRename(entry.name)}
            onDelete={() => setDeleteTarget(entry.name)}
            onSendToAI={() => sendToAI(entry.name)}
            renameName={renameTarget === entry.name ? renameValue : undefined}
            onRenameChange={v => setRenameValue(v)}
            onRenameConfirm={() => doRename()}
            onRenameCancel={() => setRenameTarget(null)}
            highlightRename={renameTarget === entry.name}
          />
        ))}
      </div>

      {/* 文件预览底部抽屉 */}
      {preview && (
        <FilePreviewDrawer
          name={previewName}
          path={previewPath}
          content={preview}
          error={previewError}
          onClose={() => { setPreview(null); setPreviewError(null); }}
          onSendToAI={() => sendToAI(previewName)}
        />
      )}

      {/* 删除确认抽屉 */}
      {deleteTarget && (
        <ConfirmDrawer
          title="删除"
          message={`确定删除「${deleteTarget}」吗？此操作不可撤销。`}
          onConfirm={doDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {/* 新建文件夹抽屉 */}
      {showCreateDir && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50" onClick={() => setShowCreateDir(false)}>
          <div className="w-full max-w-[430px] rounded-t-2xl border border-border bg-background-elevated p-4" onClick={e => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-[15px] font-semibold">新建文件夹</h3>
              <button onClick={() => setShowCreateDir(false)} className="text-text-tertiary hover:text-text-primary">✕</button>
            </div>
            <input value={createDirName} onChange={e => setCreateDirName(e.target.value)} placeholder="文件夹名称" autoFocus
              className="input-base w-full" onKeyDown={e => { if (e.key === "Enter") doCreateDir(); }} />
            <div className="flex gap-2 mt-3">
              <button onClick={() => setShowCreateDir(false)} className="flex-1 rounded-[10px] border border-border py-2.5 text-sm text-text-secondary">取消</button>
              <button onClick={doCreateDir} disabled={!createDirName.trim()} className="flex-1 rounded-[10px] bg-primary py-2.5 text-sm font-medium text-background-base disabled:opacity-40">创建</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// 文件行
// ============================================================================

function FileRow({
  entry, onOpen, onRename, onDelete, onSendToAI,
  renameName, onRenameChange, onRenameConfirm, onRenameCancel, highlightRename,
}: {
  entry: FileEntry;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
  onSendToAI: () => void;
  renameName?: string;
  onRenameChange?: (v: string) => void;
  onRenameConfirm?: () => void;
  onRenameCancel?: () => void;
  highlightRename?: boolean;
}) {
  const { label, color } = getFileIcon(entry.name, entry.is_dir);

  const isEditable = !entry.is_dir && (isLikelyText(entry.name) || getExtension(entry.name) === "");
  const isLarge = entry.size > 2 * 1024 * 1024;

  return (
    <div
      className={`flex items-center gap-2.5 rounded-[12px] border border-border bg-background-elevated p-2.5 transition-[border-color,box-shadow] cursor-pointer ${
        highlightRename ? "border-primary bg-primary/5" : "hover:border-primary/40"
      }`}
      onClick={() => { if (!highlightRename) onOpen(); }}
    >
      <span className={`flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] bg-primary/10 ${color} text-lg`}>{label}</span>
      <div className="min-w-0 flex-1">
        {highlightRename ? (
          <div className="flex gap-1" onClick={e => e.stopPropagation()}>
            <input value={renameName} onChange={e => onRenameChange?.(e.target.value)} autoFocus
              className="flex-1 rounded-[6px] border border-primary bg-background-surface px-2 py-1 text-[12px] text-text-primary outline-none"
              onKeyDown={e => { if (e.key === "Enter") onRenameConfirm?.(); if (e.key === "Escape") onRenameCancel?.(); }} />
            <button onClick={() => onRenameConfirm?.()} className="rounded-[6px] bg-primary px-2 py-1 text-[11px] text-background-base">✓</button>
            <button onClick={() => onRenameCancel?.()} className="rounded-[6px] border border-border px-2 py-1 text-[11px] text-text-secondary">✕</button>
          </div>
        ) : (
          <>
            <span className={`truncate text-[13px] font-medium ${highlightRename ? "text-primary" : "text-text-primary"}`}>{entry.name}</span>
            <div className="mt-0.5 flex items-center gap-2">
              <span className="font-mono text-[10px] text-text-tertiary">{formatSize(entry.size)}</span>
              <span className="text-[10px] text-text-tertiary">· {formatModified(entry.modified)}</span>
              {isLarge && <span className="text-[10px] text-warning">文件过大</span>}
            </div>
          </>
        )}
      </div>

      {/* 右侧操作（长按/点击展开） */}
      <div className="flex shrink-0 gap-0.5" onClick={e => e.stopPropagation()}>
        <button onClick={onRename} className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] text-text-tertiary transition-colors hover:bg-background-surface hover:text-primary" title="重命名">
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-none stroke-current stroke-2" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
        </button>
        {isEditable && !entry.is_dir && (
          <button onClick={onSendToAI} className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] text-primary transition-colors hover:bg-primary/15" title="发送到 AI">
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-none stroke-current stroke-2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>
          </button>
        )}
        <button onClick={onDelete} className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] text-text-tertiary transition-colors hover:bg-background-surface hover:text-danger" title="删除">
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-none stroke-current stroke-2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// 文件预览抽屉
// ============================================================================

function FilePreviewDrawer({ name, path, content, error, onClose, onSendToAI }: {
  name: string;
  path: string;
  content: FileContent;
  error: string | null;
  onClose: () => void;
  onSendToAI: () => void;
}) {
  const [decodedText, setDecodedText] = useState<string | null>(null);
  const [decodeError, setDecodeError] = useState<string | null>(null);

  useEffect(() => {
    if (isTextMime(content.mime) || isLikelyText(name)) {
      try {
        const bytes = Uint8Array.from(atob(content.content), c => c.charCodeAt(0));
        setDecodedText(new TextDecoder().decode(bytes));
      } catch {
        setDecodeError("文件解码失败（可能不是文本文件）");
      }
    } else {
      setDecodedText(null);
    }
  }, [content.mime, content.content, name]);

  const isText = decodedText !== null;
  const isImage = isImageMime(content.mime);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50" onClick={onClose}>
      <div className="w-full max-w-[430px] max-h-[75vh] flex flex-col rounded-t-2xl border border-border bg-background-elevated" onClick={e => e.stopPropagation()}>
        {/* 标题栏 */}
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <span className="text-[13px] font-semibold text-text-primary">{name}</span>
            <span className="ml-2 font-mono text-[10px] text-text-tertiary">{formatSize(content.size)} · {content.mime}</span>
          </div>
          <div className="flex gap-1">
            {isText && (
              <button onClick={onSendToAI} className="rounded-[8px] border border-primary/30 bg-primary/10 px-2.5 py-1 text-[11px] text-primary transition-colors hover:bg-primary/20">发送到 AI</button>
            )}
            <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-[7px] text-text-tertiary hover:bg-background-surface">✕</button>
          </div>
        </div>

        {/* 内容 */}
        <div className="flex-1 overflow-y-auto p-3">
          {error && (
            <div className="rounded-lg border border-danger/30 bg-danger/8 p-3 text-xs text-danger">{error}</div>
          )}
          {decodeError && (
            <div className="rounded-lg border border-warning/30 bg-warning/8 p-3 text-xs text-warning">{decodeError}</div>
          )}

          {isImage && (
            <div className="flex flex-col items-center">
              <img src={`data:${content.mime};base64,${content.content}`} alt={name}
                className="max-w-full rounded-lg" />
              <p className="mt-2 text-xs text-text-tertiary">点击查看完整图片</p>
            </div>
          )}

          {isText && decodedText && (
            <pre className="overflow-x-auto rounded-lg bg-background-surface p-3 text-[12px] leading-relaxed text-text-primary whitespace-pre-wrap break-words">
              {decodedText}
            </pre>
          )}

          {!isImage && !isText && !decodeError && (
            <div className="py-8 text-center text-xs text-text-tertiary">
              此文件类型暂不支持预览。<br />
              可以使用「发送到 AI」让 AI 帮你分析。
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// 确认抽屉
// ============================================================================

function ConfirmDrawer({ title, message, onConfirm, onCancel }: {
  title: string; message: string; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50" onClick={onCancel}>
      <div className="w-full max-w-[430px] rounded-t-2xl border border-border bg-background-elevated p-4" onClick={e => e.stopPropagation()}>
        <h3 className="mb-2 text-[15px] font-semibold">{title}</h3>
        <p className="mb-3 text-xs leading-relaxed text-text-secondary">{message}</p>
        <div className="flex gap-2">
          <button onClick={onCancel} className="flex-1 rounded-[10px] border border-border py-2.5 text-sm text-text-secondary">取消</button>
          <button onClick={onConfirm} className="flex-1 rounded-[10px] bg-danger py-2.5 text-sm font-medium text-background-base">确认删除</button>
        </div>
      </div>
    </div>
  );
}

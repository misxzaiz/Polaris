/**
 * Markdown — AI 回复富文本渲染
 *
 * 基于 react-markdown + remark-gfm（表格/任务列表/删除线）+ rehype-highlight（代码高亮）。
 * 代码块：深色容器 + 语言标签 + 一键复制 + 横向滚动；行内代码：胶囊。
 * 支持流式增量输入（react-markdown 内部重渲染，无需特殊处理）。
 */
import { memo, useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Components } from "react-markdown";

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* 剪贴板不可用时静默 */ }
  }, [code]);
  return (
    <button
      onClick={onCopy}
      className="flex h-6 items-center gap-1 rounded px-1.5 text-[10px] text-text-tertiary transition-colors hover:bg-background-base hover:text-text-secondary"
      title="复制代码"
    >
      {copied ? (
        <svg viewBox="0 0 24 24" className="h-3 w-3 fill-none stroke-success stroke-[2.4px]" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
      ) : (
        <svg viewBox="0 0 24 24" className="h-3 w-3 fill-none stroke-current stroke-[1.8px]" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
      )}
      {copied ? "已复制" : "复制"}
    </button>
  );
}

const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children, ...props }) => {
    // 行内代码（无 language- className 且内容无换行）
    const isInline = !className && !String(children).includes("\n");
    if (isInline) {
      return (
        <code className="rounded bg-background-base px-1.5 py-0.5 font-mono text-[0.86em] text-primary" {...props}>
          {children}
        </code>
      );
    }
    const match = /language-(\w+)/.exec(className || "");
    const lang = match?.[1] || "text";
    const text = String(children).replace(/\n$/, "");
    return (
      <div className="group relative my-2.5 overflow-hidden rounded-xl border border-border bg-background-base">
        <div className="flex items-center justify-between border-b border-border/60 bg-background-surface/50 px-3 py-1">
          <span className="font-mono text-[10px] uppercase tracking-wide text-text-tertiary">{lang}</span>
          <CopyButton code={text} />
        </div>
        <pre className="overflow-x-auto p-3 text-[12px] leading-relaxed">
          <code className={`language-${lang} font-mono`} {...props}>{children}</code>
        </pre>
      </div>
    );
  },
  a: ({ children, ...props }) => (
    <a {...props} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2 break-all">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="my-2.5 overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-[12px]">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-border bg-background-surface px-2.5 py-1.5 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border-b border-border/50 px-2.5 py-1.5 align-top">{children}</td>,
  ul: ({ children }) => <ul className="my-1.5 ml-5 list-disc space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 ml-5 list-decimal space-y-1">{children}</ol>,
  blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-primary/50 bg-background-surface/40 py-1 pl-3 text-text-secondary">{children}</blockquote>,
  h1: ({ children }) => <h1 className="mb-1.5 mt-3 text-[15px] font-bold">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-1.5 mt-3 text-[14px] font-bold">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1.5 mt-2.5 text-[13px] font-semibold">{children}</h3>,
  p: ({ children }) => <p className="my-1.5 leading-relaxed">{children}</p>,
};

interface MarkdownProps {
  content: string;
}

function MarkdownBase({ content }: MarkdownProps) {
  return (
    <div className="markdown-body text-[13px] text-text-primary">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownBase);

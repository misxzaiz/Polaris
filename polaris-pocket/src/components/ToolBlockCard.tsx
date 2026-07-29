/**
 * ToolBlockCard — 工具执行卡片
 *
 * 在 AI 回复消息气泡内行内渲染，显示模型调用工具的意图、参数、执行状态和结果。
 * 状态机：idle → running → success | error
 *
 * 交叉对抗性审查：
 * - 参数折叠避免撑爆屏幕
 * - 错误状态用 danger 色
 * - 进行中状态有 spinner + 不可点击
 */
import { useState } from "react";

export interface ToolCardData {
  id: string;
  name: string;
  icon: string;
  input: Record<string, unknown>;
  status: "running" | "success" | "error";
  result?: string;
  resultIsError?: boolean;
}

export function ToolBlockCard({ data }: { data: ToolCardData }) {
  const [showInput, setShowInput] = useState(false);

  const isError = data.status === "error" || (data.resultIsError && data.status === "success");

  return (
    <div
      className={`mt-2 rounded-[10px] border ${
        isError
          ? "border-danger/40 bg-danger/6"
          : data.status === "success"
            ? "border-success/30 bg-success/6"
            : "border-border bg-background-surface"
      } px-3 py-2`}
    >
      {/* 头部：工具名 + 状态 */}
      <div className="flex items-center gap-2">
        <span className="text-[13px]">{data.icon}</span>
        <span className="font-mono text-[11px] font-semibold text-text-primary">
          {data.name}
        </span>
        {data.status === "running" && (
          <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
            <svg
              className="h-3 w-3 animate-spin"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8" />
            </svg>
            执行中
          </span>
        )}
        {data.status === "success" && !data.resultIsError && (
          <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[10px] text-success">
            ✓ 完成
          </span>
        )}
        {isError && (
          <span className="inline-flex items-center gap-1 rounded-full bg-danger/15 px-2 py-0.5 text-[10px] text-danger">
            ✕ 失败
          </span>
        )}
      </div>

      {/* 参数（可折叠） */}
      {Object.keys(data.input).length > 0 && (
        <button
          onClick={() => setShowInput(!showInput)}
          className="mt-1.5 w-full text-left text-[10px] text-text-tertiary transition-colors hover:text-text-secondary"
        >
          <span className="mr-1">{showInput ? "▾" : "▸"}</span>
          参数：{JSON.stringify(data.input)}
        </button>
      )}
      {showInput && (
        <pre className="mt-1 rounded-lg bg-background-base/50 p-2 text-[10px] leading-relaxed text-text-secondary">
          {JSON.stringify(data.input, null, 2)}
        </pre>
      )}

      {/* 结果 */}
      {(data.status === "success" || data.status === "error") && data.result !== undefined && (
        <div
          className={`mt-1.5 rounded-lg border ${
            isError ? "border-danger/30 bg-danger/4" : "border-success/20 bg-success/4"
          } p-2 text-[12px] leading-relaxed ${isError ? "text-danger" : "text-text-primary"}`}
        >
          <span className="text-[10px] text-text-tertiary">{isError ? "❌ " : "✅ "}</span>
          <span className="whitespace-pre-wrap break-words">{data.result}</span>
        </div>
      )}
    </div>
  );
}

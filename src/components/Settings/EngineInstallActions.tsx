/**
 * 引擎安装 / 卸载 / 更新操作区
 *
 * 面向 npm/npx 分发的引擎（Claude Code / Codex / Mimo）。
 * 通过后端 `engine_install` / `engine_uninstall` 命令执行，
 * 并订阅 `engine-install:event` 事件流实时展示安装日志。
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke, listen } from '@/services/transport';
import { Download, Trash2, Loader2 } from 'lucide-react';
import { createLogger } from '@/utils/logger';
import type { EngineId } from '@/types';

const log = createLogger('EngineInstallActions');

interface InstallEvent {
  taskId: string;
  kind: 'started' | 'log' | 'done' | 'error';
  line: string;
}

interface EngineInstallActionsProps {
  engineId: EngineId;
  /** npm 全局包名 */
  npmPackage: string;
  /** 当前是否已安装 */
  installed: boolean;
  /** 当前版本（已安装时） */
  version?: string;
  /** 安装/卸载完成后回调（用于刷新健康状态） */
  onChanged: () => void | Promise<void>;
}

// 自增序列，保证并发安装的 taskId 唯一
let taskSeq = 0;

export function EngineInstallActions({
  engineId,
  npmPackage,
  installed,
  onChanged,
}: EngineInstallActionsProps) {
  const { t } = useTranslation(['settings', 'common']);
  const [running, setRunning] = useState<null | 'install' | 'uninstall'>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const logBoxRef = useRef<HTMLDivElement>(null);

  // 日志自动滚动到底部
  useEffect(() => {
    const box = logBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [logs]);

  const run = useCallback(
    async (op: 'install' | 'uninstall') => {
      if (running) return;
      const taskId = `${engineId}-${op}-${Date.now()}-${taskSeq++}`;
      setRunning(op);
      setLogs([]);
      setError(null);

      let unlisten: (() => void) | null = null;
      try {
        // 先挂监听再触发命令，避免错过早期日志
        unlisten = await listen<InstallEvent>('engine-install:event', (ev) => {
          if (ev.taskId !== taskId) return;
          if ((ev.kind === 'log' || ev.kind === 'started') && ev.line) {
            // 仅保留最近 200 行，避免长安装日志撑爆内存
            setLogs((prev) => [...prev.slice(-199), ev.line]);
          } else if (ev.kind === 'error' && ev.line) {
            setError(ev.line);
          }
        });

        if (op === 'install') {
          await invoke<string>('engine_install', { npmPackage, version: null, taskId });
        } else {
          await invoke<string>('engine_uninstall', { npmPackage, taskId });
        }
        await onChanged();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error(`engine ${op} failed: ${msg}`);
        setError((prev) => prev ?? msg);
      } finally {
        unlisten?.();
        setRunning(null);
      }
    },
    [engineId, npmPackage, onChanged, running],
  );

  return (
    <div className="mt-4 pt-4 border-t border-border">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => run('install')}
          disabled={running !== null}
          className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-md bg-primary text-white hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {running === 'install' ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Download size={13} />
          )}
          {running === 'install'
            ? t('aiEngine.installing', { defaultValue: '安装中…' })
            : installed
              ? t('aiEngine.updateAction', { defaultValue: '更新到最新' })
              : t('aiEngine.installAction', { defaultValue: '一键安装' })}
        </button>

        {installed && (
          <button
            type="button"
            onClick={() => run('uninstall')}
            disabled={running !== null}
            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-md border border-red-500/40 bg-red-500/5 text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {running === 'uninstall' ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Trash2 size={13} />
            )}
            {running === 'uninstall'
              ? t('aiEngine.uninstalling', { defaultValue: '卸载中…' })
              : t('aiEngine.uninstallAction', { defaultValue: '卸载' })}
          </button>
        )}

        <span className="text-[11px] text-text-tertiary font-mono ml-auto truncate">
          npm i -g {npmPackage}
        </span>
      </div>

      {/* 安装日志 */}
      {(logs.length > 0 || running) && (
        <div
          ref={logBoxRef}
          className="mt-3 max-h-40 overflow-auto rounded-md bg-background border border-border p-2 font-mono text-[11px] leading-relaxed text-text-secondary whitespace-pre-wrap"
        >
          {logs.length === 0 ? (
            <span className="text-text-tertiary">
              {t('aiEngine.installPreparing', { defaultValue: '准备中…' })}
            </span>
          ) : (
            logs.map((line, i) => <div key={i}>{line}</div>)
          )}
        </div>
      )}

      {/* 错误提示 */}
      {error && (
        <div className="mt-2 px-3 py-2 rounded-md text-xs bg-red-500/10 text-red-400 border border-red-500/20">
          {error}
        </div>
      )}

      <p className="mt-2 text-[11px] text-text-tertiary">
        {t('aiEngine.installHint', {
          defaultValue: '通过 npm 全局安装，需本机已安装 Node.js / npm 并在 PATH 中。',
        })}
      </p>
    </div>
  );
}

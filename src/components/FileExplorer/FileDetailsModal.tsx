/**
 * 文件/文件夹属性弹窗（只读信息展示）
 *
 * 数据来源：cap.fs getFileInfo（router_dispatch 统一总线转发）。
 * 文件：类型 / 大小 / 修改时间 / 创建时间 / 完整路径；
 * 文件夹：类型 / 子项数 / 修改时间 / 创建时间 / 完整路径。
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { OverlayGuard } from '@/components/Browser/OverlayGuard';
import { useTransitionState } from '@/hooks/useTransitionState';
import { fsGetFileInfo } from '@/services/tauri/fileService';
import { formatFileSize } from '@/types/attachment';
import type { FileInfo } from '@/types';

interface FileDetailsModalProps {
  file: FileInfo;
  onClose: () => void;
}

/** 秒级时间戳字符串 → 本地化日期时间字符串 */
function formatTimestamp(seconds: string | undefined): string {
  if (seconds == null || seconds === '') return '—';
  const ms = Number(seconds) * 1000;
  if (Number.isNaN(ms)) return seconds;
  return new Date(ms).toLocaleString();
}

/** 子项数（undefined/0 区分展示） */
function formatItemCount(count: number | undefined): string {
  if (count == null) return '—';
  return String(count);
}

export function FileDetailsModal({ file, onClose }: FileDetailsModalProps) {
  const { t } = useTranslation('fileExplorer');
  const { mounted, phase, exit } = useTransitionState({
    duration: 180,
    onExited: () => onClose(),
  });

  const [details, setDetails] = useState<FileInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fsGetFileInfo(file.path)
      .then((info) => {
        if (cancelled) return;
        setDetails(info);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [file.path]);

  // Escape 关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        exit();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [exit]);

  if (!mounted) return null;

  const info = details ?? file; // 加载完成前回退到传入的 file 基本信息
  const typeLabel = info.is_dir
    ? t('details.typeFolder')
    : info.extension
      ? `${t('details.typeFile')} (.${info.extension})`
      : t('details.typeFile');

  const rows: { label: string; value: string }[] = [
    { label: t('details.type'), value: typeLabel },
    ...(info.is_dir
      ? [
          {
            label: t('details.itemCount'),
            value: formatItemCount(info.child_count),
          },
        ]
      : [{ label: t('details.size'), value: formatFileSize(info.size ?? 0) }]),
    { label: t('details.modified'), value: formatTimestamp(info.modified) },
    { label: t('details.created'), value: formatTimestamp(info.created) },
    { label: t('details.path'), value: info.path },
  ];

  const exiting = phase === 'exiting';

  return (
    <OverlayGuard label="FileDetailsModal">
      <div
        className={`fixed inset-0 flex items-center justify-center z-50 ${exiting ? 'animate-mask-out' : 'animate-mask-in'}`}
        style={{ background: 'rgba(0,0,0,0.5)' }}
        onClick={() => exit()}
      >
        <div
          className={`bg-background-elevated rounded-xl p-4 sm:p-6 w-full max-w-md border border-border shadow-glow ${exiting ? 'animate-dialog-out' : 'animate-dialog-in'}`}
          onClick={(e) => e.stopPropagation()}
        >
          <h2 className="text-lg font-semibold text-text-primary mb-4">
            {t('details.title')}
          </h2>

          <div className="text-sm text-text-secondary space-y-3">
            {/* 名称（主标识，加粗） */}
            <div className="flex items-start justify-between gap-3">
              <span className="text-text-muted flex-shrink-0">{t('details.name')}</span>
              <span className="text-text-primary font-medium text-right break-all min-w-0">
                {info.name}
              </span>
            </div>

            {rows.map((row) => (
              <div key={row.label} className="flex items-start justify-between gap-3">
                <span className="text-text-muted flex-shrink-0">{row.label}</span>
                <span className="text-text-primary text-right break-all min-w-0">{row.value}</span>
              </div>
            ))}
          </div>

          {error && (
            <p className="text-xs text-danger mt-3">{t('details.loadError', { error })}</p>
          )}

          <div className="flex justify-end gap-2 mt-6">
            <button
              type="button"
              onClick={() => exit()}
              className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-background-hover rounded-lg transition-colors"
            >
              {t('details.close')}
            </button>
          </div>
        </div>
      </div>
    </OverlayGuard>
  );
}

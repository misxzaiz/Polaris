import { type MouseEvent, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { Download, Loader2, X } from 'lucide-react';
import { saveMarkdownImage } from '@/services/imageSaveService';
import { useToastStore } from '@/stores';

export interface MarkdownImageViewState {
  src: string;
  alt: string;
  title: string;
}

interface MarkdownImageViewerProps {
  image: MarkdownImageViewState;
  onClose: () => void;
}

export function MarkdownImageViewer({ image, onClose }: MarkdownImageViewerProps) {
  const { t } = useTranslation('chat');
  const [saving, setSaving] = useState(false);
  const { success, error: toastError } = useToastStore();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleBackdropMouseDown = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  }, [onClose]);

  const handleSave = useCallback(async () => {
    if (saving) return;

    setSaving(true);
    try {
      const savedPath = await saveMarkdownImage(image.src, image.title || image.alt);
      if (savedPath) {
        success(t('imageViewer.imageSaved'), savedPath);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toastError(t('imageViewer.saveFailed'), message);
    } finally {
      setSaving(false);
    }
  }, [image.alt, image.src, image.title, saving, success, toastError]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] bg-black/85 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={handleBackdropMouseDown}
    >
      <div className="absolute right-3 top-3 z-10 flex items-center gap-2">
        <button
          type="button"
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/15 bg-black/45 text-white shadow-soft transition-colors hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-60"
          title={t('imageViewer.saveImage')}
          aria-label={t('imageViewer.saveImage')}
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
        </button>
        <button
          type="button"
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/15 bg-black/45 text-white shadow-soft transition-colors hover:bg-white/15"
          title={t('imageViewer.close')}
          aria-label={t('imageViewer.close')}
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex h-full w-full items-center justify-center p-4 sm:p-8">
        <img
          src={image.src}
          alt={image.alt || image.title || 'image'}
          className="max-h-[88vh] max-w-[96vw] select-none rounded-lg object-contain shadow-2xl"
          draggable={false}
        />
      </div>
    </div>,
    document.body,
  );
}

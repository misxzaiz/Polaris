import { type MouseEvent, type PropsWithChildren, useCallback, useState } from 'react';
import { MarkdownImageViewer, type MarkdownImageViewState } from './MarkdownImageViewer';

export function MarkdownImageSurface({ children }: PropsWithChildren) {
  const [viewerImage, setViewerImage] = useState<MarkdownImageViewState | null>(null);

  const handleClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const image = target.closest('img.markdown-chat-image');
    if (!(image instanceof HTMLImageElement)) return;
    if (!event.currentTarget.contains(image)) return;

    event.preventDefault();
    setViewerImage({
      src: image.currentSrc || image.src,
      alt: image.alt,
      title: image.title,
    });
  }, []);

  return (
    <div onClick={handleClick}>
      {children}
      {viewerImage && (
        <MarkdownImageViewer
          image={viewerImage}
          onClose={() => setViewerImage(null)}
        />
      )}
    </div>
  );
}

import { invoke } from '@/services/transport';

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];

interface CodexImageArtifactRef {
  threadId: string;
  fileName: string;
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function sanitizeFileName(value: string): string {
  const safe = value
    .split('')
    .map((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || '<>:"/\\|?*'.includes(char) ? '_' : char;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

  return safe || 'image.png';
}

function extensionFromContentType(contentType: string): string | null {
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'jpg';
  if (contentType.includes('webp')) return 'webp';
  if (contentType.includes('gif')) return 'gif';
  return null;
}

function extensionFromFileName(fileName: string): string | null {
  const ext = fileName.split('.').pop()?.toLowerCase();
  return ext && IMAGE_EXTENSIONS.includes(ext) ? ext : null;
}

function ensureImageExtension(fileName: string, fallbackExtension = 'png'): string {
  if (extensionFromFileName(fileName)) return fileName;
  return `${fileName.replace(/\.+$/, '')}.${fallbackExtension}`;
}

function fileNameFromImageSrc(src: string, suggestedName?: string): string {
  const suggested = suggestedName ? sanitizeFileName(suggestedName) : '';
  if (extensionFromFileName(suggested)) return suggested;

  try {
    const url = new URL(src, window.location.origin);
    const lastSegment = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
    const fileName = sanitizeFileName(lastSegment || suggested || 'image.png');
    return ensureImageExtension(fileName);
  } catch {
    return ensureImageExtension(suggested || 'image.png');
  }
}

function parseCodexImageArtifact(src: string): CodexImageArtifactRef | null {
  try {
    const url = new URL(src, window.location.origin);
    const match = url.pathname.match(/^\/api\/artifacts\/codex-images\/([^/]+)\/([^/]+)$/);
    if (!match) return null;

    return {
      threadId: decodeURIComponent(match[1]),
      fileName: decodeURIComponent(match[2]),
    };
  } catch {
    return null;
  }
}

function downloadBlob(blob: Blob, fileName: string): string {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
  return fileName;
}

async function fetchImageBlob(src: string): Promise<Blob> {
  const response = await fetch(src);
  if (!response.ok) {
    throw new Error(`Image request failed: ${response.status}`);
  }
  return response.blob();
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image data'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Unexpected image data format'));
        return;
      }

      const base64 = result.includes(',') ? result.split(',')[1] : result;
      resolve(base64);
    };
    reader.readAsDataURL(blob);
  });
}

async function pickImageSavePath(defaultPath: string): Promise<string | null> {
  const { save } = await import('@tauri-apps/plugin-dialog');
  return save({
    defaultPath,
    filters: [
      {
        name: 'Images',
        extensions: IMAGE_EXTENSIONS,
      },
    ],
  });
}

async function saveCodexArtifactImage(
  artifact: CodexImageArtifactRef,
  defaultFileName: string,
): Promise<string | null> {
  const destination = await pickImageSavePath(defaultFileName);
  if (!destination) return null;

  return invoke<string>('save_codex_image_artifact', {
    threadId: artifact.threadId,
    fileName: artifact.fileName,
    destination,
  });
}

async function saveGenericImageWithTauri(src: string, defaultFileName: string): Promise<string | null> {
  const blob = await fetchImageBlob(src);
  const extension = extensionFromContentType(blob.type) ?? extensionFromFileName(defaultFileName) ?? 'png';
  const destination = await pickImageSavePath(ensureImageExtension(defaultFileName, extension));
  if (!destination) return null;

  const dataBase64 = await blobToBase64(blob);
  return invoke<string>('save_image_bytes', {
    path: destination,
    dataBase64,
  });
}

async function saveImageWithBrowserDownload(src: string, defaultFileName: string): Promise<string> {
  const blob = await fetchImageBlob(src);
  const extension = extensionFromContentType(blob.type) ?? extensionFromFileName(defaultFileName) ?? 'png';
  return downloadBlob(blob, ensureImageExtension(defaultFileName, extension));
}

export async function saveMarkdownImage(src: string, suggestedName?: string): Promise<string | null> {
  const artifact = parseCodexImageArtifact(src);
  const defaultFileName = artifact?.fileName
    ? sanitizeFileName(artifact.fileName)
    : fileNameFromImageSrc(src, suggestedName);

  if (isTauriRuntime()) {
    if (artifact) {
      return saveCodexArtifactImage(artifact, defaultFileName);
    }

    return saveGenericImageWithTauri(src, defaultFileName);
  }

  return saveImageWithBrowserDownload(src, defaultFileName);
}

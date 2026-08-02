import { File, FileCode, FileJson, Image, FileText, Lock, FileWarning, FileArchive } from 'lucide-react';
import type { FileInfo } from '@/types';

interface FileIconProps {
  file: FileInfo;
  className?: string;
}

/**
 * 语言对应的颜色
 */
const LANGUAGE_COLORS: Record<string, string> = {
  typescript: 'text-blue-400',
  javascript: 'text-yellow-400',
  python: 'text-green-400',
  rust: 'text-orange-400',
  go: 'text-cyan-400',
  java: 'text-red-400',
  cpp: 'text-blue-300',
  c: 'text-blue-300',
  ruby: 'text-red-400',
  php: 'text-purple-400',
  shell: 'text-green-300',
  json: 'text-yellow-300',
  markdown: 'text-blue-300',
  text: 'text-text-muted',
  html: 'text-orange-500',
  css: 'text-blue-500',
  scss: 'text-pink-500',
  yaml: 'text-red-400',
  xml: 'text-orange-400',
};

/**
 * 获取文件语言
 */
function getLanguageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript',
    py: 'python', rs: 'rust',
    go: 'go', java: 'java',
    kt: 'kotlin', cs: 'csharp',
    cpp: 'cpp', c: 'c', h: 'c',
    hpp: 'cpp', cc: 'cpp',
    rb: 'ruby', php: 'php',
    sh: 'shell', bash: 'shell',
    zsh: 'shell', fish: 'shell',
    ps1: 'powershell',
    json: 'json', xml: 'xml',
    yaml: 'yaml', yml: 'yaml',
    toml: 'toml',
    md: 'markdown', txt: 'text',
    html: 'html', htm: 'html',
    css: 'css', scss: 'scss',
    sass: 'scss', less: 'less',
  };
  return ext ? map[ext] || 'text' : 'text';
}

/**
 * 获取文件图标组件
 */
function getFileIcon(extension: string | undefined, fileName: string) {
  const ext = extension?.toLowerCase();
  const name = fileName.toLowerCase();

  // 特殊文件名
  if (name === 'dockerfile' || name.endsWith('.dockerfile')) return <FileWarning className="w-4 h-4" />;
  if (name === 'docker-compose.yml' || name === 'docker-compose.yaml') return <FileWarning className="w-4 h-4" />;
  if (name === '.gitignore') return <Lock className="w-4 h-4" />;
  if (name.endsWith('.lock') || name === 'package-lock.json' || name === 'yarn.lock' || name === 'pnpm-lock.yaml') {
    return <Lock className="w-4 h-4" />;
  }

  // 根据扩展名返回图标
  if (!ext) return <File className="w-4 h-4" />;

  // 代码文件
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'kt', 'cs', 'cpp', 'c', 'h', 'hpp', 'cc', 'rb', 'php', 'swift', 'scala', 'sh', 'bash', 'zsh', 'fish', 'ps1'].includes(ext)) {
    return <FileCode className="w-4 h-4" />;
  }

  // 配置文件
  if (['json', 'yaml', 'yml', 'toml', 'xml', 'ini', 'conf', 'env'].includes(ext)) {
    return <FileJson className="w-4 h-4" />;
  }

  // 文档文件
  if (['md', 'txt', 'doc', 'docx', 'pdf', 'rtf'].includes(ext)) {
    return <FileText className="w-4 h-4" />;
  }

  // 样式文件
  if (['css', 'scss', 'sass', 'less', 'styl'].includes(ext)) {
    return <FileCode className="w-4 h-4" />;
  }

  // 图片文件
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'bmp', 'ico', 'webp'].includes(ext)) {
    return <Image className="w-4 h-4" />;
  }

  // 压缩文件
  if (['zip', 'tar', 'gz', 'rar', '7z', 'bz2'].includes(ext)) {
    return <FileArchive className="w-4 h-4" />;
  }

  // 安装包 / 二进制文件
  if (['msi', 'exe', 'dmg', 'deb', 'rpm', 'pkg', 'appimage', 'app'].includes(ext)) {
    return <FileArchive className="w-4 h-4" />;
  }

  // 默认图标
  return <File className="w-4 h-4" />;
}

export function FileIcon({ file, className = '' }: FileIconProps) {
  if (file.is_dir) {
    // 文件夹图标由调用方处理（使用 Folder 组件）
    return null;
  }

  const language = getLanguageFromPath(file.path);
  const colorClass = LANGUAGE_COLORS[language] || 'text-text-muted';
  const icon = getFileIcon(file.extension, file.name);

  return (
    <span className={`inline-flex items-center justify-center ${colorClass} ${className}`}>
      {icon}
    </span>
  );
}
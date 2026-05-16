export function getPathBasename(pathStr: string): string {
  const normalized = pathStr.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  return parts[parts.length - 1] || pathStr
}

export function normalizeWorkspacePath(pathStr: string): string {
  const normalized = pathStr.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  const isWindowsPath = pathStr.includes('\\') || /^[a-zA-Z]:\//.test(normalized)
  return isWindowsPath ? normalized.toLowerCase() : normalized
}

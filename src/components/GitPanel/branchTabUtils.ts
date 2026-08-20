const INVALID_BRANCH_CHARS = /[\s~:?*[\\]/
const INVALID_BRANCH_CHARS_RENAME = /[\s~^:?*[\\]/

export function validateBranchName(name: string, isRename = false): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'empty'
  const pattern = isRename ? INVALID_BRANCH_CHARS_RENAME : INVALID_BRANCH_CHARS
  if (pattern.test(trimmed)) return 'invalid'
  return null
}

export function getChangesCount(staged: unknown[], unstaged: unknown[], untracked: unknown[]): number {
  return staged.length + unstaged.length + untracked.length
}

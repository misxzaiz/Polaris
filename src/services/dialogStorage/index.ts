/**
 * AI 对话存储模块（JSONL 文件存储）
 */

export { dialogStorageService } from './service'
export {
  getDialogBackend,
  __setDialogBackendForTest,
  dialogFileName,
  type DialogBackend,
} from './dialogBackend'
export {
  serializeDialog,
  parseDialog,
  parseMeta,
  buildMeta,
  extractFirstUserText,
  extractTags,
} from './jsonlCodec'
export {
  DIALOG_FORMAT_VERSION,
  type DialogMeta,
  type DialogMessageLine,
  type DialogLine,
  type DialogRecord,
  type DialogSummary,
  type SaveDialogInput,
  type ListOptions,
  type PaginatedResult,
} from './types'

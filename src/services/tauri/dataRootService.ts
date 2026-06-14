/**
 * 数据根目录相关 Tauri 命令
 */

import { invoke } from '@/services/transport';
import type {
  DataRootInfo,
  LegacyDataInfo,
  MigrateRequest,
  MigrateReport,
} from '@/types';

/** 获取当前数据根目录信息 */
export async function getDataRootInfo(): Promise<DataRootInfo> {
  return invoke<DataRootInfo>('get_data_root_info');
}

/** 执行数据根目录迁移 */
export async function migrateDataRoot(req: MigrateRequest): Promise<MigrateReport> {
  return invoke<MigrateReport>('migrate_data_root', { request: req });
}

/** 检测旧版残留数据 */
export async function detectLegacyData(): Promise<LegacyDataInfo | null> {
  return invoke<LegacyDataInfo | null>('detect_legacy_data');
}

/** 格式化字节为人类可读大小 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

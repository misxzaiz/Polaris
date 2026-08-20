/**
 * 平台检测工具 — 统一判断当前运行环境
 *
 * 唯一真实来源：transport 层的 detectTransport()。
 * 所有模块应使用本文件导出的 isTauri() / isWeb()，避免各自重复检测。
 */

import { currentMode } from '@/services/transport';

/** 当前是否运行在 Tauri 桌面端 */
export const isTauri = (): boolean => currentMode === 'tauri';

/** 当前是否运行在 Web 浏览器端 */
export const isWeb = (): boolean => currentMode === 'http';

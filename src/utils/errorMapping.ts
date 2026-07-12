/**
 * 错误消息映射工具
 * 将后端返回的错误消息转换为国际化消息
 */

import i18n from '@/i18n';

/**
 * 后端错误消息关键词到 i18n key 的映射
 */
const ERROR_KEYWORD_MAP: Record<string, string> = {
  // 中文关键词
  '文件不存在': 'validation.fileNotFound',
  '执行失败': 'validation.executionFailed',
  '验证过程中发生错误': 'validation.validationError',
  '路径无效': 'validation.invalidPath',
  // 英文关键词（如果后端返回英文）
  'File not found': 'validation.fileNotFound',
  'Execution failed': 'validation.executionFailed',
  'Error during validation': 'validation.validationError',
  'Invalid path': 'validation.invalidPath',
};

/**
 * 调度器错误消息关键词到 i18n key 的映射
 */
const SCHEDULER_ERROR_MAP: Record<string, string> = {
  // 任务错误
  '任务不存在': 'scheduler.errors.taskNotFound',
  '任务名称不能为空': 'scheduler.errors.taskNameEmpty',
  '触发表达式不能为空': 'scheduler.errors.triggerValueEmpty',
  '间隔时间不能为空': 'scheduler.errors.intervalEmpty',
  '间隔时间格式无效': 'scheduler.errors.intervalFormatInvalid',
  '间隔时间数字部分无效': 'scheduler.errors.intervalNumberInvalid',
  '间隔时间不能为零': 'scheduler.errors.intervalZero',
  '间隔时间单位无效': 'scheduler.errors.intervalUnitInvalid',
  'Cron 表达式不能为空': 'scheduler.errors.cronEmpty',
  'Cron 表达式格式无效': 'scheduler.errors.cronFormatInvalid',
  '触发时间不能为空': 'scheduler.errors.triggerTimeEmpty',
  // 模板错误
  '模板不存在': 'scheduler.errors.templateNotFound',
  '模板名称不能为空': 'scheduler.errors.templateNameEmpty',
  '模板内容不能为空': 'scheduler.errors.templateContentEmpty',
  '模板已禁用': 'scheduler.errors.templateDisabled',
  '内置模板不能修改': 'scheduler.errors.builtinTemplateCannotModify',
  '内置模板不能删除': 'scheduler.errors.builtinTemplateCannotDelete',
  '内置模板不能禁用': 'scheduler.errors.builtinTemplateCannotDisable',
  '任务目标模板不能为空': 'scheduler.errors.missionTemplateEmpty',
  // 协议错误
  '协议错误': 'scheduler.errors.protocolError',
};

/**
 * 将后端错误消息转换为国际化消息
 * @param error 后端返回的错误消息
 * @returns 国际化后的错误消息
 */
export function mapErrorMessage(error: string | undefined | null): string {
  if (!error) {
    return '';
  }

  // 先尝试匹配调度器错误
  for (const [keyword, i18nKey] of Object.entries(SCHEDULER_ERROR_MAP)) {
    if (error.includes(keyword)) {
      return i18n.t(`errors:${i18nKey}`, error);
    }
  }

  // 尝试匹配通用关键词
  for (const [keyword, i18nKey] of Object.entries(ERROR_KEYWORD_MAP)) {
    if (error.includes(keyword)) {
      return i18n.t(`errors:${i18nKey}`, error);
    }
  }

  // 如果没有匹配到，直接返回原始错误
  return error;
}

/**
 * 验证结果错误处理
 * @param result 验证结果
 * @returns 处理后的错误消息（null 表示无错误）
 */
export function handleValidationError(result: { valid: boolean; error?: string }): string | null {
  if (result.valid) {
    return null;
  }
  return mapErrorMessage(result.error);
}

/**
 * 从 Tauri 错误中提取错误消息
 * @param error 原始错误对象
 * @returns 格式化后的错误消息
 */
export function extractErrorMessage(error: unknown): string {
  if (!error) {
    return '';
  }

  if (typeof error === 'string') {
    return mapErrorMessage(error);
  }

  if (error instanceof Error) {
    return mapErrorMessage(error.message);
  }

  // Tauri invoke 错误格式
  if (typeof error === 'object' && error !== null) {
    const err = error as Record<string, unknown>;
    if (typeof err.message === 'string') {
      return mapErrorMessage(err.message);
    }
    if (typeof err.error === 'string') {
      return mapErrorMessage(err.error);
    }
  }

  return String(error);
}

/**
 * 创建调度器错误处理函数
 * @param setError 错误状态设置函数
 * @returns 错误处理函数
 */
export function createSchedulerErrorHandler(setError: (error: string | null) => void) {
  return (error: unknown, fallbackMessage: string) => {
    const message = extractErrorMessage(error);
    setError(message || fallbackMessage);
    return message;
  };
}


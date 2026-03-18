/**
 * CLI 路径选择器组件
 * 支持自动检测和手动输入两种模式
 * 支持 Claude Code 和 IFlow 两种引擎
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import * as tauri from '../../services/tauri';
import { mapErrorMessage } from '../../utils/errorMapping';
import { createLogger } from '../../utils/logger';

const log = createLogger('ClaudePathSelector');

type EngineType = 'claude-code' | 'iflow' | 'codex';

interface ClaudePathSelectorProps {
  /** 当前路径值 */
  value: string;
  /** 路径变更回调 */
  onChange: (path: string) => void;
  /** 引擎类型 */
  engineType?: EngineType;
  /** 是否禁用 */
  disabled?: boolean;
  /** 是否显示紧凑模式（用于连接蒙版） */
  compact?: boolean;
  /** 错误提示 */
  error?: string;
  /** 占位符文本 */
  placeholder?: string;
}

type InputMode = 'auto' | 'manual';

export function ClaudePathSelector({
  value,
  onChange,
  engineType = 'claude-code',
  disabled = false,
  compact = false,
  error,
  placeholder,
}: ClaudePathSelectorProps) {
  const { t } = useTranslation('settings');
  
  const getConfig = (type: EngineType) => ({
    name: t(`pathSelector.${type}.name`),
    placeholder: t(`pathSelector.${type}.placeholder`),
    example: t(`pathSelector.${type}.example`),
  });
  
  const config = getConfig(engineType);
  
  const [mode, setMode] = useState<InputMode>('manual');
  const [detectedPaths, setDetectedPaths] = useState<string[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [validating, setValidating] = useState(false);
  const [isValid, setIsValid] = useState<boolean | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  const detectPaths = async () => {
    setDetecting(true);
    try {
      let paths: string[] = [];
      if (engineType === 'claude-code') {
        paths = await tauri.findClaudePaths();
      } else if (engineType === 'iflow') {
        paths = await tauri.findIFlowPaths();
      } else if (engineType === 'codex') {
        paths = await tauri.findCodexPaths();
      }
      setDetectedPaths(paths);

      if (paths.length > 0 && !value) {
        onChange(paths[0]);
      }
    } catch (e) {
      log.error(`检测 ${config.name} 路径失败`, e instanceof Error ? e : new Error(String(e)));
      setDetectedPaths([]);
    } finally {
      setDetecting(false);
    }
  };

  const validatePath = async (path: string) => {
    if (!path.trim()) {
      setIsValid(null);
      setValidationError(null);
      return;
    }

    setValidating(true);
    try {
      let result: { valid: boolean; error?: string };
      if (engineType === 'claude-code') {
        result = await tauri.validateClaudePath(path);
      } else if (engineType === 'iflow') {
        result = await tauri.validateIFlowPath(path);
      } else if (engineType === 'codex') {
        result = await tauri.validateCodexPath(path);
      } else {
        result = { valid: true };
      }
      setIsValid(result.valid);
      setValidationError(mapErrorMessage(result.error));
    } catch (e) {
      setIsValid(false);
      setValidationError(e instanceof Error ? mapErrorMessage(e.message) : t('validation.validationError'));
    } finally {
      setValidating(false);
    }
  };

  useEffect(() => {
    if (mode === 'auto') {
      detectPaths();
    }
  }, [mode, engineType]);

  // claude-code, iflow, codex 使用 CLI 路径选择

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setMode('manual')}
          disabled={disabled}
          className={`flex-1 px-3 py-2 text-sm rounded-lg border transition-colors ${
            mode === 'manual'
              ? 'bg-primary/10 border-primary text-primary'
              : 'bg-background-surface border-border text-text-secondary hover:border-border-hover'
          } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          {t('pathSelector.manualInput')}
        </button>
        <button
          type="button"
          onClick={() => setMode('auto')}
          disabled={disabled}
          className={`flex-1 px-3 py-2 text-sm rounded-lg border transition-colors ${
            mode === 'auto'
              ? 'bg-primary/10 border-primary text-primary'
              : 'bg-background-surface border-border text-text-secondary hover:border-border-hover'
          } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          {t('pathSelector.autoDetect')}
        </button>
      </div>

      {mode === 'auto' && (
        <div className="space-y-2">
          <div className="flex items-stretch gap-2">
            <div className="flex-1 min-w-0 relative">
              <select
                value={value}
                onChange={(e) => onChange(e.target.value)}
                disabled={disabled || detecting || detectedPaths.length === 0}
                className={`w-full px-3 py-2 pr-8 bg-background-surface border rounded-l-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:z-10 ${
                  error ? 'border-danger' : 'border-border'
                } ${disabled || detecting ? 'opacity-50' : ''}`}
              >
                <option value="">{t('pathSelector.selectPath', { name: config.name })}</option>
                {detectedPaths.map((path) => (
                  <option key={path} value={path}>
                    {path}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              onClick={detectPaths}
              disabled={disabled || detecting}
              className="px-3 bg-background-surface border border-l-0 border-border rounded-r-lg hover:border-border-hover transition-colors disabled:opacity-50 flex items-center justify-center"
              title={t('pathSelector.redetect')}
            >
              <svg
                className={`w-4 h-4 ${detecting ? 'animate-spin' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
            </button>
          </div>

          {detectedPaths.length === 0 && !detecting && (
            <p className="text-xs text-text-tertiary">
              {t('pathSelector.notDetected', { name: config.name })}
            </p>
          )}
          {detectedPaths.length > 0 && (
            <p className="text-xs text-text-tertiary">
              {t('pathSelector.detectedCount', { count: detectedPaths.length })}
            </p>
          )}
        </div>
      )}

      {mode === 'manual' && (
        <div className="space-y-2">
          <div className="relative">
            <input
              type="text"
              value={value}
              onChange={(e) => {
                onChange(e.target.value);
                validatePath(e.target.value);
              }}
              disabled={disabled || validating}
              className={`w-full px-3 py-2 pr-10 bg-background-surface border rounded-lg text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-primary ${
                error ? 'border-danger' : 'border-border'
              } ${disabled || validating ? 'opacity-50' : ''}`}
              placeholder={placeholder || config.placeholder}
            />
            {value && (
              <div className="absolute right-3 top-1/2 -translate-y-1/2">
                {validating ? (
                  <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                ) : isValid === true ? (
                  <svg className="w-5 h-5 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                ) : isValid === false ? (
                  <svg className="w-5 h-5 text-danger" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                ) : null}
              </div>
            )}
          </div>

          {validationError && (
            <p className="text-xs text-danger">{validationError}</p>
          )}
          {isValid === true && !compact && (
            <p className="text-xs text-success">{t('pathSelector.pathValid')}</p>
          )}
          <p className="text-xs text-text-tertiary">
            {config.example}
          </p>
        </div>
      )}

      {error && (
        <p className="text-xs text-danger">{error}</p>
      )}
    </div>
  );
}

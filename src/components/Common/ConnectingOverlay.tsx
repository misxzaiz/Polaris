/**
 * 连接中蒙板组件
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfigStore } from '../../stores';
import { Button, ClaudePathSelector } from './index';
import { isWindows } from '../../utils/path';
import { currentMode, manualReconnect } from '../../services/transport';

export function ConnectingOverlay() {
  const { t } = useTranslation('common');
  const { config, healthStatus, connectionState, error, retryConnection } = useConfigStore();
  const [showPathInput, setShowPathInput] = useState(false);
  const [tempPath, setTempPath] = useState(config?.claudeCode?.cliPath || '');

  const handleRetry = async () => {
    try {
      if (currentMode === 'http') {
        // Web端: use httpTransport manual reconnect
        await manualReconnect();
      } else {
        // Tauri: use existing configStore logic
        await retryConnection();
      }
    } catch (error) {
      // Display user-friendly error message
      console.error('Manual reconnect failed:', error);
    }
  };

  const handlePathSubmit = async () => {
    if (!tempPath.trim()) return;
    await retryConnection(tempPath.trim());
    setShowPathInput(false);
  };

  const isConnecting = connectionState === 'connecting';
  const isFailed = connectionState === 'failed';

  return (
    <div className="fixed inset-0 bg-background-base flex items-center justify-center z-50">
      <div className="text-center space-y-6">
        {/* 加载动画或错误图标 */}
        <div className="flex items-center justify-center">
          {isConnecting ? (
            <div className="relative">
              {/* 外圈 */}
              <div className="w-16 h-16 border-4 border-border-subtle rounded-full" />
              {/* 内圈 - 旋转动画 */}
              <div className="absolute inset-0 w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          ) : isFailed ? (
            <div className="w-16 h-16 rounded-full bg-danger-faint flex items-center justify-center">
              <svg className="w-8 h-8 text-danger" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
          ) : null}
        </div>

        {/* 文字提示 */}
        <div className="space-y-2">
          <h2 className="text-xl font-semibold text-text-primary">
            {isConnecting ? t('connection.connecting') : isFailed ? t('connection.connectFailed') : ''}
          </h2>
          <p className="text-sm text-text-secondary">
            {isConnecting ? t('connection.connectingHint') : isFailed ? t('connection.connectFailedHint') : ''}
          </p>
        </div>

        {/* 连接状态详情 */}
        {healthStatus?.claudeVersion ? (
          <p className="text-xs text-text-tertiary">
            {t('connection.detectedVersion', { version: healthStatus.claudeVersion })}
          </p>
        ) : isFailed ? (
          <div className="text-xs text-text-tertiary space-y-3 max-w-md px-4">
            <p className="text-danger font-medium">{error || t('connection.cliNotFound')}</p>
            {config?.claudeCode?.cliPath && (
              <p>{t('connection.currentPath')} <code className="bg-background-surface px-1 py-0.5 rounded break-all">{config.claudeCode.cliPath}</code></p>
            )}

            {/* 详细诊断信息 */}
            <div className="bg-background-surface p-3 rounded-lg space-y-2 overflow-x-auto">
              <p className="font-medium text-text-secondary">{t('connection.diagnosis')}</p>
              <ul className="space-y-1 list-disc list-inside">
                <li>{t('connection.diagnosis1')}</li>
                <li>{t('connection.diagnosis2')}</li>
                <li>{t('connection.diagnosis3')}</li>
                <li>{t('connection.diagnosis4')}</li>
              </ul>
            </div>

            {/* 引导式帮助 */}
            <div className="bg-background-surface p-3 rounded-lg space-y-2 overflow-x-auto">
              <p className="font-medium text-text-secondary">{t('connection.solutions')}</p>
              <ol className="space-y-1 list-decimal list-inside">
                <li>{t('connection.solution1')} <code className="px-1 py-0.5 rounded">claude --version</code></li>
                <li>{t('connection.solution2')} <code className="px-1 py-0.5 rounded">{isWindows ? 'where claude' : 'which claude'}</code></li>
                <li>{t('connection.solution4')} <code className="px-1 py-0.5 rounded break-all">npm install -g @anthropic-ai/claude-3-dev</code></li>
              </ol>
            </div>
          </div>
        ) : (
          <p className="text-xs text-text-tertiary">
            {t('connection.detecting')}
          </p>
        )}

        {/* 连接失败时的操作按钮 */}
        {isFailed && (
          <div className="space-y-3">
            {!showPathInput ? (
              <div className="space-y-2">
                <Button
                  onClick={handleRetry}
                  variant="primary"
                  className="w-full"
                >
                  {t('connection.retryDetection')}
                </Button>
                <Button
                  onClick={() => setShowPathInput(true)}
                  variant="ghost"
                  className="w-full"
                >
                  {t('connection.setClaudePath')}
                </Button>
              </div>
            ) : (
              <div className="space-y-4 w-full max-w-md">
                <div className="bg-background-surface p-4 rounded-lg">
                  <p className="text-sm text-text-secondary mb-3">
                    {t('connection.pathSelectorHint')}
                  </p>
                  <ClaudePathSelector
                    value={tempPath}
                    onChange={setTempPath}
                    compact
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    onClick={handlePathSubmit}
                    variant="primary"
                    className="flex-1"
                    disabled={!tempPath.trim()}
                  >
                    {t('connection.saveAndRetry')}
                  </Button>
                  <Button
                    onClick={() => {
                      setShowPathInput(false);
                      setTempPath(config?.claudeCode?.cliPath || '');
                    }}
                    variant="ghost"
                    className="flex-1"
                  >
                    {t('buttons.cancel')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 连接中蒙板组件
 *
 * 连接中时显示增强动画（双圈 spinner + 动态文字轮播 + 消息条 + 进度条），
 * 鉴权时显示 Token 输入界面。
 * 引擎不可用不再阻塞界面，用户可进入 App 后在设置中配置。
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfigStore } from '@/stores';
import { Button } from './index';
import { currentMode } from '@/services/transport';
import { createLogger } from '@/utils/logger';

const log = createLogger('ConnectingOverlay');

/** 连接中轮播的状态消息 */
const STATUS_MESSAGES = [
  { title: '正在连接 AI 引擎', detail: '正在检测引擎路径' },
  { title: '正在连接 AI 引擎', detail: '验证 CLI 版本' },
  { title: '正在连接 AI 引擎', detail: '加载配置文件' },
  { title: '正在连接 AI 引擎', detail: '引擎就绪' },
];

/** 连接中轮播的详情消息（纯文本，无 emoji） */
const CAROUSEL_MESSAGES = [
  '检测引擎 CLI 路径',
  '验证 CLI 版本兼容性',
  '加载应用配置文件',
  '扫描已安装插件',
  '同步工作区数据',
  '准备就绪',
];

export function ConnectingOverlay() {
  const { t } = useTranslation('common');
  const { connectionState, submitToken } = useConfigStore();
  const [tokenInput, setTokenInput] = useState('');

  // 动态文字轮播状态
  const [statusIndex, setStatusIndex] = useState(0);
  const [carouselIndex, setCarouselIndex] = useState(0);

  // 前向进度条（只增不减）
  const [progress, setProgress] = useState(8);

  // 连接中时启动文字轮播
  const isConnecting = connectionState === 'connecting';
  const needsToken = connectionState === 'needsToken';

  useEffect(() => {
    if (!isConnecting) {
      setStatusIndex(0);
      setCarouselIndex(0);
      return;
    }

    const statusTimer = setInterval(() => {
      setStatusIndex((i) => (i + 1) % STATUS_MESSAGES.length);
    }, 2000);

    const carouselTimer = setInterval(() => {
      setCarouselIndex((i) => (i + 1) % CAROUSEL_MESSAGES.length);
    }, 2200);

    // 前向进度条：每 800ms 推进，增量递减
    const progressTimer = setInterval(() => {
      setProgress((prev) => {
        const maxProgress = 95;
        const remaining = maxProgress - prev;
        if (remaining < 0.5) return prev;
        const step = Math.max(0.5, remaining * 0.12);
        return Math.min(maxProgress, prev + step);
      });
    }, 800);

    return () => {
      clearInterval(statusTimer);
      clearInterval(carouselTimer);
      clearInterval(progressTimer);
    };
  }, [isConnecting]);

  log.info('Overlay state', {
    currentMode,
    connectionState,
    isConnecting,
    needsToken,
  });

  const handleTokenSubmit = async () => {
    if (!tokenInput.trim()) return;
    await submitToken(tokenInput.trim());
  };

  // ========== 连接中：增强动画 ==========
  if (isConnecting) {
    const currentStatus = STATUS_MESSAGES[statusIndex];

    return (
      <div className="fixed inset-0 bg-background-base flex items-center justify-center z-50">
        <div className="w-[360px] flex flex-col items-center gap-7">

          {/* 增强 spinner：双圈反向旋转 + 中心光晕 */}
          <div className="relative w-[72px] h-[72px]">
            {/* 背景圈 */}
            <div className="absolute inset-0 border-[3px] border-border-subtle rounded-full" />
            {/* 主旋转弧（蓝紫渐变） */}
            <div className="absolute inset-0 border-[3px] border-transparent border-t-primary border-r-accent-ai rounded-full"
              style={{ animation: 'polaris-spin 1.2s cubic-bezier(0.4, 0, 0.2, 1) infinite' }} />
            {/* 内圈反向旋转 */}
            <div className="absolute inset-[4px] border-[2px] border-transparent border-b-primary/30 border-l-accent-ai/30 rounded-full"
              style={{ animation: 'polaris-spin-rev 2s linear infinite' }} />
            {/* 中心光晕 */}
            <div className="absolute top-1/2 left-1/2 w-2 h-2 -mt-1 -ml-1 rounded-full bg-primary"
              style={{ animation: 'polaris-glow 1.5s ease-in-out infinite' }} />
          </div>

          {/* 动态标题 */}
          <div className="text-center">
            <h2 className="text-lg font-semibold text-text-primary min-h-[28px] transition-opacity duration-300">
              {currentStatus.title}
            </h2>
            <div className="flex items-center justify-center gap-1 mt-2 text-sm text-text-secondary min-h-[20px]">
              <span key={statusIndex} className="transition-opacity duration-300">{currentStatus.detail}</span>
              <span className="inline-flex gap-0.5">
                <span className="w-1 h-1 rounded-full bg-primary/60" style={{ animation: 'polaris-blink 1.2s infinite' }} />
                <span className="w-1 h-1 rounded-full bg-primary/60" style={{ animation: 'polaris-blink 1.2s infinite 0.2s' }} />
                <span className="w-1 h-1 rounded-full bg-primary/60" style={{ animation: 'polaris-blink 1.2s infinite 0.4s' }} />
              </span>
            </div>
          </div>

          {/* 消息条：淡入淡出切换，无滚动 */}
          <div className="w-full h-9 bg-background-surface/50 border border-border-subtle rounded-lg flex items-center justify-center">
            <span
              key={carouselIndex}
              className="text-xs text-text-muted transition-opacity duration-300"
            >
              · {CAROUSEL_MESSAGES[carouselIndex]}
            </span>
          </div>

          {/* 前向进度条：只增不减 */}
          <div className="w-full flex items-center gap-2">
            <div className="flex-1 h-[2px] bg-border-subtle rounded-full overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-primary to-accent-ai"
                style={{ width: `${progress}%`, transition: 'width 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94)' }}
              />
            </div>
            <span className="text-[11px] text-text-muted flex-shrink-0">{t('connection.connectingHint')}</span>
          </div>
        </div>
      </div>
    );
  }

  // ========== Token 鉴权（Web 模式） ==========

  return (
    <div className="fixed inset-0 bg-background-base flex items-center justify-center z-50">
      <div className="text-center space-y-6">
        {/* 文字提示 */}
        <div className="space-y-2">
          <h2 className="text-xl font-semibold text-text-primary">
            {t('connection.tokenRequired')}
          </h2>
          <p className="text-sm text-text-secondary">
            {t('connection.tokenRequiredHint')}
          </p>
        </div>

        {/* Token 输入界面 */}
        <div className="space-y-3 w-full max-w-sm px-4">
          <div className="bg-background-surface p-4 rounded-lg space-y-3">
            <p className="text-sm text-text-secondary">{t('connection.tokenPrompt')}</p>
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleTokenSubmit(); }}
              placeholder={t('connection.tokenPlaceholder')}
              className="w-full px-3 py-2 bg-background-base border border-border-subtle rounded-lg text-sm text-text-primary focus:outline-none focus:border-primary"
              autoFocus
            />
          </div>
          <Button
            onClick={handleTokenSubmit}
            variant="primary"
            className="w-full"
            disabled={!tokenInput.trim()}
          >
            {t('connection.tokenSubmit')}
          </Button>
        </div>
      </div>
    </div>
  );
}
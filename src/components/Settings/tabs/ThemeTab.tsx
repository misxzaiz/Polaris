/**
 * 主题设置 Tab
 * 包含外观主题、Spider-Man 沉浸主题、对话显示、窗口透明度
 */

import * as React from 'react';
import { useTranslation } from 'react-i18next';
import type { Config, WindowSettings, ChatDisplayDensity, ChatDisplayFontFamily, SpiderManThemeConfig } from '@/types';
import { DEFAULT_CHAT_DISPLAY_SETTINGS, DEFAULT_SPIDERMAN_THEME, getChatDisplayStyleVars, normalizeChatDisplaySettings } from '@/types';
import { useThemeStore } from '@/stores/themeStore';
import { syncSpiderManCssVarsToDom, saveSpiderManConfig, detectAndCacheBrightness, computeAdaptiveOverlay } from '@/utils/spiderman-theme';

interface ThemeTabProps {
  config: Config;
  onConfigChange: (config: Config) => void;
  loading: boolean;
}

export function ThemeTab({ config, onConfigChange, loading }: ThemeTabProps) {
  const { t } = useTranslation('settings');

  const currentTheme = config.theme ?? 'dark';
  const chatDisplay = normalizeChatDisplaySettings(config.chatDisplay);

  const updateChatDisplay = (patch: Partial<typeof chatDisplay>) => {
    onConfigChange({
      ...config,
      chatDisplay: normalizeChatDisplaySettings({ ...chatDisplay, ...patch }),
    });
  };

  const applyChatDensityPreset = (density: ChatDisplayDensity) => {
    const preset = {
      compact: { fontSize: 13, lineHeight: 1.45, paragraphSpacing: 2, messageSpacing: 'compact' as const, codeFontSize: 12 },
      comfortable: DEFAULT_CHAT_DISPLAY_SETTINGS,
      spacious: { fontSize: 16, lineHeight: 1.7, paragraphSpacing: 8, messageSpacing: 'spacious' as const, codeFontSize: 14 },
    }[density];
    onConfigChange({
      ...config,
      chatDisplay: normalizeChatDisplaySettings({ ...chatDisplay, ...preset }),
    });
  };

  const resetChatDisplay = () => {
    onConfigChange({ ...config, chatDisplay: DEFAULT_CHAT_DISPLAY_SETTINGS });
  };

  const formatLineHeight = (value: number) => value.toFixed(2);

  const ChatSlider = ({
    label,
    hint,
    value,
    min,
    max,
    step,
    suffix,
    format = String,
    onChange,
  }: {
    label: string;
    hint: string;
    value: number;
    min: number;
    max: number;
    step: number;
    suffix?: string;
    format?: (value: number) => string;
    onChange: (value: number) => void;
  }) => (
    <div className="flex items-center justify-between gap-4">
      <div className="flex-1 min-w-0">
        <div className="text-sm text-text-primary">{label}</div>
        <div className="text-xs text-text-secondary">{hint}</div>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          disabled={loading}
          className="w-28 h-1.5 bg-border rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
        />
        <span className="text-xs text-text-secondary w-12 text-right tabular-nums">
          {format(value)}{suffix}
        </span>
      </div>
    </div>
  );

  const SegmentedButton = <T extends string>({
    value,
    options,
    onChange,
  }: {
    value: T;
    options: Array<{ value: T; label: string }>;
    onChange: (value: T) => void;
  }) => (
    <div className="flex items-center gap-2 flex-wrap justify-end">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          disabled={loading}
          className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
            value === option.value
              ? 'bg-primary text-on-primary'
              : 'bg-background-surface border border-border text-text-secondary hover:text-text-primary'
          } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );

  // 获取窗口设置，默认值
  const windowSettings: WindowSettings = config.window || {
    normalOpacity: 100,
    compactOpacity: 100,
  };

  // 处理大窗透明度变化
  const handleNormalOpacityChange = (value: number) => {
    onConfigChange({
      ...config,
      window: { ...windowSettings, normalOpacity: value },
    });
  };

  // 处理小窗透明度变化
  const handleCompactOpacityChange = (value: number) => {
    onConfigChange({
      ...config,
      window: { ...windowSettings, compactOpacity: value },
    });
  };

  // 透明度滑块组件
  const OpacitySlider = ({
    label,
    hint,
    value,
    onChange,
  }: {
    label: string;
    hint: string;
    value: number;
    onChange: (value: number) => void;
  }) => (
    <div className="flex items-center justify-between">
      <div className="flex-1 mr-4">
        <div className="text-sm text-text-primary">{label}</div>
        <div className="text-xs text-text-secondary">{hint}</div>
      </div>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min="0"
          max="100"
          step="5"
          value={value}
          onChange={(e) => onChange(parseInt(e.target.value, 10))}
          disabled={loading}
          className="w-24 h-1.5 bg-border rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
        />
        <span className="text-xs text-text-secondary w-10 text-right">
          {value}%
        </span>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      {/* 外观主题 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-sm font-medium text-text-primary mb-3">{t('appearance.title')}</h3>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-text-primary">{t('appearance.current')}</div>
            <div className="text-xs text-text-secondary">{t('appearance.hint')}</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                onConfigChange({ ...config, theme: 'dark' });
                useThemeStore.getState().applyTheme('dark');
              }}
              disabled={loading}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                currentTheme === 'dark'
                  ? 'bg-primary text-on-primary'
                  : 'bg-background-surface border border-border text-text-secondary hover:text-text-primary'
              } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {t('appearance.dark')}
            </button>
            <button
              type="button"
              onClick={() => {
                onConfigChange({ ...config, theme: 'light' });
                useThemeStore.getState().applyTheme('light');
              }}
              disabled={loading}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors inline-flex items-center gap-1.5 ${
                currentTheme === 'light'
                  ? 'bg-primary text-on-primary'
                  : 'bg-background-surface border border-border text-text-secondary hover:text-text-primary'
              } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
              title={t('appearance.experimental')}
            >
              {t('appearance.light')}
              <span className="text-[10px] px-1 py-0.5 rounded bg-accent-workspace/15 text-accent-workspace leading-none">
                β
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                onConfigChange({ ...config, theme: 'spiderman' });
                useThemeStore.getState().applyTheme('spiderman');
              }}
              disabled={loading}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${currentTheme === 'spiderman'
                  ? 'bg-primary text-on-primary'
                  : 'bg-background-surface border border-border text-text-secondary hover:text-text-primary'
              } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {t('appearance.spiderman')}
            </button>
          </div>
        </div>
      </div>

      {/* Spider-Man 主题设置 */}
      {currentTheme === 'spiderman' && (
        <SpiderManSection config={config} onConfigChange={onConfigChange} loading={loading} />
      )}

      {/* 对话显示 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <div className="flex items-center justify-between mb-4 gap-3">
          <div>
            <h3 className="text-sm font-medium text-text-primary">{t('chatDisplay.title')}</h3>
            <div className="text-xs text-text-secondary mt-1">{t('chatDisplay.hint')}</div>
          </div>
          <button
            type="button"
            onClick={resetChatDisplay}
            disabled={loading}
            className={`px-3 py-1.5 text-xs rounded-lg border border-border text-text-secondary hover:text-text-primary hover:bg-background-hover transition-colors ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            {t('chatDisplay.reset')}
          </button>
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="text-sm text-text-primary">{t('chatDisplay.preset')}</div>
              <div className="text-xs text-text-secondary">{t('chatDisplay.presetHint')}</div>
            </div>
            <SegmentedButton<ChatDisplayDensity>
              value={chatDisplay.messageSpacing}
              onChange={applyChatDensityPreset}
              options={[
                { value: 'compact', label: t('chatDisplay.compact') },
                { value: 'comfortable', label: t('chatDisplay.comfortable') },
                { value: 'spacious', label: t('chatDisplay.spacious') },
              ]}
            />
          </div>

          <ChatSlider
            label={t('chatDisplay.fontSize')}
            hint={t('chatDisplay.fontSizeHint')}
            value={chatDisplay.fontSize}
            min={12}
            max={20}
            step={1}
            suffix="px"
            onChange={(fontSize) => updateChatDisplay({ fontSize })}
          />
          <ChatSlider
            label={t('chatDisplay.lineHeight')}
            hint={t('chatDisplay.lineHeightHint')}
            value={chatDisplay.lineHeight}
            min={1.35}
            max={1.8}
            step={0.05}
            format={formatLineHeight}
            onChange={(lineHeight) => updateChatDisplay({ lineHeight })}
          />
          <ChatSlider
            label={t('chatDisplay.paragraphSpacing')}
            hint={t('chatDisplay.paragraphSpacingHint')}
            value={chatDisplay.paragraphSpacing}
            min={0}
            max={12}
            step={1}
            suffix="px"
            onChange={(paragraphSpacing) => updateChatDisplay({ paragraphSpacing })}
          />
          <ChatSlider
            label={t('chatDisplay.codeFontSize')}
            hint={t('chatDisplay.codeFontSizeHint')}
            value={chatDisplay.codeFontSize}
            min={11}
            max={18}
            step={1}
            suffix="px"
            onChange={(codeFontSize) => updateChatDisplay({ codeFontSize })}
          />

          <div className="flex items-center justify-between gap-4 pt-1">
            <div className="flex-1 min-w-0">
              <div className="text-sm text-text-primary">{t('chatDisplay.fontFamily')}</div>
              <div className="text-xs text-text-secondary">{t('chatDisplay.fontFamilyHint')}</div>
            </div>
            <SegmentedButton<ChatDisplayFontFamily>
              value={chatDisplay.fontFamily}
              onChange={(fontFamily) => updateChatDisplay({ fontFamily })}
              options={[
                { value: 'system', label: t('chatDisplay.systemFont') },
                { value: 'serif', label: t('chatDisplay.serifFont') },
                { value: 'mono', label: t('chatDisplay.monoFont') },
              ]}
            />
          </div>

          <div className="p-3 rounded-lg bg-background-base border border-border-subtle chat-display-root" style={getChatDisplayStyleVars(chatDisplay)}>
            <div className="text-xs font-medium text-text-secondary mb-2">{t('chatDisplay.preview')}</div>
            <div className="chat-user-message flex justify-end">
              <div className="chat-user-bubble bg-gradient-to-br from-primary to-primary-600 text-white shadow-glow max-w-[85%]">
                <div className="chat-user-text whitespace-pre-wrap break-words">{t('chatDisplay.previewUser')}</div>
              </div>
            </div>
            <div className="chat-assistant-message flex gap-2">
              <div className="shrink-0 mt-0.5">
                <div className="w-5 h-5 rounded-full bg-primary-faint flex items-center justify-center text-[11px] text-primary font-semibold">AI</div>
              </div>
              <div className="chat-assistant-content flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium text-text-primary">Polaris</span>
                  <span className="text-xs text-text-tertiary">09:41</span>
                </div>
                <div className="chat-prose prose prose-invert max-w-none">
                  <p>{t('chatDisplay.previewAssistant')}</p>
                  <ul>
                    <li>{t('chatDisplay.previewListOne')}</li>
                    <li>{t('chatDisplay.previewListTwo')}</li>
                  </ul>
                  <pre className="chat-code-pre !bg-background-base !m-0 !rounded-lg border border-border-subtle overflow-x-auto"><code className="chat-code-text text-text-secondary">const readable = true;</code></pre>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 窗口透明度设置 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-sm font-medium text-text-primary mb-3">
          {t('window.opacityTitle')}
        </h3>

        {/* 大窗模式透明度 */}
        <div className="mb-4">
          <OpacitySlider
            label={t('window.normalOpacity')}
            hint={t('window.normalOpacityHint')}
            value={windowSettings.normalOpacity}
            onChange={handleNormalOpacityChange}
          />
        </div>

        {/* 小屏模式透明度 */}
        <OpacitySlider
          label={t('window.compactOpacity')}
          hint={t('window.compactOpacityHint')}
          value={windowSettings.compactOpacity}
          onChange={handleCompactOpacityChange}
        />
      </div>
    </div>
  );
}

/* ============================================
   Spider-Man 沉浸主题设置区块
   ============================================ */

const SPIDERMAN_BACKGROUNDS = [
  { src: 'https://images.unsplash.com/photo-1534809027769-b00d750a6bac?q=80&w=1920', label: '纽约天际线' },
  { src: 'https://images.unsplash.com/photo-1635805737707-575885ab0820?q=80&w=1920', label: '面具发光眼' },
  { src: 'https://images.unsplash.com/photo-1715783735932-2aaa7bcfab34?q=80&w=1920', label: '金色蜘蛛 Logo' },
  { src: 'https://images.unsplash.com/photo-1642456074142-92f75cb84533?q=80&w=1920', label: '战衣发光眼' },
  { src: 'https://images.unsplash.com/photo-1505925456693-124134d66749?q=80&w=1920', label: '城市之巅' },
  // Spider-Man: Brand New Day 壁纸
  { src: 'https://images.hdqwalls.com/download/spider-man-brand-new-day-movie-8l-3840x2400.jpg', label: '崭新之日·电影' },
  { src: 'https://images.hdqwalls.com/download/spider-man-brand-new-day-begins-zg-3840x2160.jpg', label: '崭新之日·开始' },
  { src: 'https://images.hdqwalls.com/download/spider-man-brand-new-day-zk-3840x2160.jpg', label: '崭新之日·经典' },
  { src: 'https://images.hdqwalls.com/wallpapers/spider-man-brand-new-day-the-amazing-hero-2e.jpg', label: '超凡英雄' },
  { src: 'https://images.hdqwalls.com/download/spider-man-brand-new-day-5k-qg-3840x2400.jpg', label: '崭新之日·5K' },
  { src: '', label: '关闭背景' },
];

const SPIDERMAN_MASKS = [
  { src: 'https://www.pngmart.com/files/10/Spider-Man-Mask-Logo-PNG-Transparent-Image.png', label: '经典 #1' },
  { src: 'https://www.pngarts.com/files/3/Spider-Man-Mask-Transparent-Background-PNG.png', label: '经典 #4' },
  { src: 'https://purepng.com/public/uploads/large/purepng.com-spider-man-maskspider-manspidermansuperherocomic-bookmarvel-comicscharacterstan-lee-1701528655211dzh6y.png', label: '经典 #5' },
  { src: 'https://www.pngmart.com/files/10/Spider-Man-Mask-Logo-PNG-Photos.png', label: '经典 #6' },
  // 更多透明面具头像
  { src: 'https://www.citypng.com/public/uploads/preview/hd-mask-spiderman-realistic-png-735811696952449ro3pyf5lqp.png', label: '写实面具' },
  { src: 'https://www.pngplay.com/wp-content/uploads/15/Spiderman-Mask-Transparent-PNG.png', label: '透明面具' },
  { src: 'https://www.citypng.com/public/uploads/preview/hd-mask-spiderman-3d-png-11695958056q2ii6wyjfz.png', label: '3D 面具' },
  // 动态 GIF 头像 (img 标签支持 GIF 动画)
  { src: 'https://media3.giphy.com/media/gjJHFL9KPkbLErYPrr/giphy.gif', label: '动态·蜘蛛感应' },
];

const SCALE_OPTIONS = [
  { value: 'cover', label: '铺满' },
  { value: 'contain', label: '适应' },
  { value: 'auto 100%', label: '自适应高' },
  { value: '100% auto', label: '自适应宽' },
];

interface SpiderManSectionProps {
  config: Config;
  onConfigChange: (config: Config) => void;
  loading: boolean;
}

function SpiderManSection({ config, onConfigChange, loading }: SpiderManSectionProps) {
  const { t } = useTranslation('settings');

  const spidermanTheme: SpiderManThemeConfig = {
    ...DEFAULT_SPIDERMAN_THEME,
    ...config.spidermanTheme,
  };

  // ===== 自适应亮度检测 =====
  // 缓存图片亮度值，用于 UI 展示和传给 syncSpiderManCssVarsToDom
  const [imageBrightness, setImageBrightness] = React.useState<number | null>(null);

  /** 保存到配置 + 检测亮度 + 同步 CSS 变量 */
  const updateSpiderManConfig = (patch: Partial<SpiderManThemeConfig>) => {
    const merged = { ...spidermanTheme, ...patch };
    // 更新 React 配置
    onConfigChange({
      ...config,
      spidermanTheme: merged,
    });
    // 同步到 localStorage 供 themeStore 读取
    saveSpiderManConfig(merged);

    // 如果背景图片变了，异步检测亮度并传入 sync
    const bgChanged = 'backgroundImage' in patch;
    if (bgChanged && merged.backgroundImage) {
      detectAndCacheBrightness(merged.backgroundImage).then((brightness) => {
        setImageBrightness(brightness);
        // 带亮度信息重新同步 CSS 变量
        syncSpiderManCssVarsToDom(merged, brightness);
      });
    } else {
      // 其他参数变化（透明度等），直接同步
      syncSpiderManCssVarsToDom(merged, imageBrightness);
    }
  };

  // 计算自适应遮罩值（用于 UI 展示）
  const bgOpacity = spidermanTheme.backgroundOpacity ?? 0.2;
  const userOverlay = 1 - bgOpacity;
  const effectiveOverlay = computeAdaptiveOverlay(bgOpacity, imageBrightness);
  const isBoosted = effectiveOverlay > userOverlay + 0.02;

  /** 最大上传文件大小 */
  const MAX_AVATAR_SIZE = 500 * 1024; // 500KB — 面具头像
  const MAX_BG_SIZE = 2 * 1024 * 1024; // 2MB — 背景图片（localStorage 约 5MB 限额）

  const handleAvatarUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_AVATAR_SIZE) {
      alert(t('spiderman.errors.fileTooLarge', '图片超过 500KB 限制，请选择更小的图片'));
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string;
      updateSpiderManConfig({ avatarUrl: dataUrl });
    };
    reader.readAsDataURL(file);
  };

  const handleBgUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_BG_SIZE) {
      alert(t('spiderman.errors.fileTooLarge', '图片超过 2MB 限制，请选择更小的图片'));
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string;
      updateSpiderManConfig({ backgroundImage: dataUrl });
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="space-y-4">
      {/* 视觉效果 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-sm font-medium text-text-primary mb-3">{t('spiderman.effects.title')}</h3>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-text-secondary">{t('spiderman.effects.bgOpacity')}</span>
          <div className="flex items-center gap-2">
            {imageBrightness !== null && (
              <span className="text-[10px] text-text-muted">
                {Math.round(imageBrightness)}
              </span>
            )}
            <span className="text-xs text-text-secondary tabular-nums">
              {Math.round((spidermanTheme.backgroundOpacity ?? 0.2) * 100)}%
            </span>
          </div>
        </div>
        {isBoosted && (
          <div className="flex items-center gap-1.5 mb-2 px-2 py-1 rounded bg-accent-workspace/10 border border-accent-workspace/20">
            <svg className="w-3 h-3 text-accent-workspace flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
            </svg>
            <span className="text-[10px] text-accent-workspace">
              {t('spiderman.effects.adaptiveHint', '图片偏亮，遮罩自动增强至 {{value}}%', { value: Math.round(effectiveOverlay * 100) })}
            </span>
          </div>
        )}
        <input
          type="range"
          min="0"
          max="100"
          value={Math.round((spidermanTheme.backgroundOpacity ?? 0.2) * 100)}
          onChange={(e) => {
            const v = Number(e.target.value) / 100;
            updateSpiderManConfig({ backgroundOpacity: v });
          }}
          disabled={loading}
          className="w-full h-1.5 bg-border rounded-full appearance-none cursor-pointer mb-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
        />
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-text-secondary">{t('spiderman.effects.panelOpacity')}</span>
          <span className="text-xs text-text-secondary tabular-nums">
            {Math.round((spidermanTheme.panelOpacity ?? 0.55) * 100)}%
          </span>
        </div>
        <input
          type="range"
          min="0"
          max="100"
          value={Math.round((spidermanTheme.panelOpacity ?? 0.55) * 100)}
          onChange={(e) => {
            const v = Number(e.target.value) / 100;
            updateSpiderManConfig({ panelOpacity: v });
          }}
          disabled={loading}
          className="w-full h-1.5 bg-border rounded-full appearance-none cursor-pointer mb-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
        />
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-text-secondary">{t('spiderman.effects.panelBlur')}</span>
          <span className="text-xs text-text-secondary tabular-nums">
            {spidermanTheme.panelBlur ?? 8}px
          </span>
        </div>
        <input
          type="range"
          min="0"
          max="32"
          step="1"
          value={spidermanTheme.panelBlur ?? 8}
          onChange={(e) => {
            const v = Number(e.target.value);
            updateSpiderManConfig({ panelBlur: v });
          }}
          disabled={loading}
          className="w-full h-1.5 bg-border rounded-full appearance-none cursor-pointer mb-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
        />
        {/* 蓝色强调强度 */}
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-text-secondary">{t('spiderman.effects.blueAccent')}</span>
          <span className="text-xs text-text-secondary tabular-nums">
            {Math.round((spidermanTheme.blueAccent ?? 0.5) * 100)}%
          </span>
        </div>
        <input
          type="range"
          min="0"
          max="100"
          value={Math.round((spidermanTheme.blueAccent ?? 0.5) * 100)}
          onChange={(e) => {
            const v = Number(e.target.value) / 100;
            updateSpiderManConfig({ blueAccent: v });
          }}
          disabled={loading}
          className="w-full h-1.5 bg-border rounded-full appearance-none cursor-pointer mb-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
        />
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-text-secondary">{t('spiderman.effects.webOpacity')}</span>
          <span className="text-xs text-text-secondary tabular-nums">
            {Math.round((spidermanTheme.webTextureOpacity ?? 0.15) * 100)}%
          </span>
        </div>
        <input
          type="range"
          min="0"
          max="35"
          value={Math.round((spidermanTheme.webTextureOpacity ?? 0.15) * 100)}
          onChange={(e) => {
            const v = Number(e.target.value) / 100;
            updateSpiderManConfig({ webTextureOpacity: v });
          }}
          disabled={loading}
          className="w-full h-1.5 bg-border rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
        />
        {/* 内容卡片透明度 */}
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-text-secondary">{t('spiderman.effects.surfaceOpacity')}</span>
          <span className="text-xs text-text-secondary tabular-nums">
            {Math.round((spidermanTheme.surfaceOpacity ?? 0.5) * 100)}%
          </span>
        </div>
        <input
          type="range"
          min="0"
          max="100"
          value={Math.round((spidermanTheme.surfaceOpacity ?? 0.5) * 100)}
          onChange={(e) => {
            const v = Number(e.target.value) / 100;
            updateSpiderManConfig({ surfaceOpacity: v });
          }}
          disabled={loading}
          className="w-full h-1.5 bg-border rounded-full appearance-none cursor-pointer mb-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
        />
        {/* 聊天工具面板透明度 */}
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-text-secondary">{t('spiderman.effects.chatToolOpacity')}</span>
          <span className="text-xs text-text-secondary tabular-nums">
            {Math.round((spidermanTheme.chatToolOpacity ?? 0.55) * 100)}%
          </span>
        </div>
        <input
          type="range"
          min="0"
          max="100"
          value={Math.round((spidermanTheme.chatToolOpacity ?? 0.55) * 100)}
          onChange={(e) => {
            const v = Number(e.target.value) / 100;
            updateSpiderManConfig({ chatToolOpacity: v });
          }}
          disabled={loading}
          className="w-full h-1.5 bg-border rounded-full appearance-none cursor-pointer mb-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
        />
        {/* 悬停态背景透明度 */}
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-text-secondary">{t('spiderman.effects.hoverOpacity')}</span>
          <span className="text-xs text-text-secondary tabular-nums">
            {Math.round((spidermanTheme.hoverOpacity ?? 0.5) * 100)}%
          </span>
        </div>
        <input
          type="range"
          min="0"
          max="100"
          value={Math.round((spidermanTheme.hoverOpacity ?? 0.5) * 100)}
          onChange={(e) => {
            const v = Number(e.target.value) / 100;
            updateSpiderManConfig({ hoverOpacity: v });
          }}
          disabled={loading}
          className="w-full h-1.5 bg-border rounded-full appearance-none cursor-pointer mb-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
        />
      </div>

      {/* 位置与大小 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-sm font-medium text-text-primary mb-3">{t('spiderman.position.title')}</h3>
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-text-secondary">{t('spiderman.position.scaleMode')}</span>
          <div className="flex gap-1">
            {SCALE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => updateSpiderManConfig({ backgroundSize: opt.value })}
                disabled={loading}
                className={`px-2 py-1 text-xs rounded ${
                  (spidermanTheme.backgroundSize || 'cover') === opt.value
                    ? 'bg-primary text-on-primary'
                    : 'bg-background-surface border border-border text-text-secondary'
                } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-text-secondary">{t('spiderman.position.horizontal')}</span>
          <span className="text-xs text-text-secondary tabular-nums">
            {spidermanTheme.backgroundPositionX ?? 50}%
          </span>
        </div>
        <input
          type="range"
          min="0"
          max="100"
          value={spidermanTheme.backgroundPositionX ?? 50}
          onChange={(e) => {
            const v = Number(e.target.value);
            updateSpiderManConfig({ backgroundPositionX: v });
          }}
          disabled={loading}
          className="w-full h-1.5 bg-border rounded-full appearance-none cursor-pointer mb-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
        />
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-text-secondary">{t('spiderman.position.vertical')}</span>
          <span className="text-xs text-text-secondary tabular-nums">
            {spidermanTheme.backgroundPositionY ?? 50}%
          </span>
        </div>
        <input
          type="range"
          min="0"
          max="100"
          value={spidermanTheme.backgroundPositionY ?? 50}
          onChange={(e) => {
            const v = Number(e.target.value);
            updateSpiderManConfig({ backgroundPositionY: v });
          }}
          disabled={loading}
          className="w-full h-1.5 bg-border rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
        />
      </div>

      {/* 面具头像 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-sm font-medium text-text-primary mb-3">{t('spiderman.avatar.title')}</h3>
        <div className="text-xs text-text-secondary mb-3">{t('spiderman.avatar.hint')}</div>
        <div className="grid grid-cols-4 gap-2">
          {SPIDERMAN_MASKS.map((mask) => (
            <button
              key={mask.src}
              type="button"
              onClick={() => updateSpiderManConfig({ avatarUrl: mask.src })}
              disabled={loading}
              className={`aspect-square rounded-lg overflow-hidden border-2 transition-all ${
                spidermanTheme.avatarUrl && spidermanTheme.avatarUrl === mask.src
                  ? 'border-primary'
                  : 'border-transparent hover:border-border'
              } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              <img
                src={mask.src}
                alt={mask.label}
                className="w-full h-full object-contain p-1"
                onError={(e) => { (e.target as HTMLElement).style.display = 'none'; }}
              />
            </button>
          ))}
        </div>
        <label className="flex items-center justify-center gap-2 mt-3 p-2 rounded-lg border border-dashed border-primary/50 text-primary text-xs cursor-pointer hover:bg-primary/5">
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
            <path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z"/>
          </svg>
          {t('spiderman.background.upload')}
          <input type="file" accept="image/*" className="hidden" onChange={handleAvatarUpload} />
        </label>
      </div>

      {/* 背景图片 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-text-primary">{t('spiderman.background.title')}</h3>
          {/* 显示/关闭背景开关 */}
          <button
            type="button"
            onClick={() => {
              if (spidermanTheme.backgroundImage) {
                // 关闭：记住当前 URL 但设为空字符串
                updateSpiderManConfig({ backgroundImage: '' });
              } else {
                // 开启：恢复默认
                updateSpiderManConfig({ backgroundImage: DEFAULT_SPIDERMAN_THEME.backgroundImage });
              }
            }}
            disabled={loading}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 ${
              spidermanTheme.backgroundImage
                ? 'bg-primary'
                : 'bg-border'
            } ${loading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
            aria-label={t('spiderman.background.toggle', '切换背景图片')}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                spidermanTheme.backgroundImage
                  ? 'translate-x-[18px]'
                  : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
        <div className="text-xs text-text-secondary mb-3">{t('spiderman.background.hint')}</div>
        <div className="grid grid-cols-2 gap-2">
          {SPIDERMAN_BACKGROUNDS.map((bg) => (
            <button
              key={bg.src}
              type="button"
              onClick={() => updateSpiderManConfig({ backgroundImage: bg.src })}
              disabled={loading}
              className={`aspect-video rounded-lg overflow-hidden border-2 transition-all relative ${
                (spidermanTheme.backgroundImage === undefined
                  ? SPIDERMAN_BACKGROUNDS[0].src
                  : spidermanTheme.backgroundImage) === bg.src
                  ? 'border-primary'
                  : 'border-transparent hover:border-border'
              } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {bg.src ? (
                <img
                  src={bg.src}
                  alt={bg.label}
                  className="w-full h-full object-cover"
                  loading="lazy"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-background-base text-text-muted text-xs">
                  {bg.label}
                </div>
              )}
              <span className="absolute bottom-0 left-0 right-0 p-1 bg-gradient-to-t from-black/60 to-transparent text-[10px] text-white/80 text-center">
                {bg.label}
              </span>
            </button>
          ))}
        </div>
        <label className="flex items-center justify-center gap-2 mt-3 p-2 rounded-lg border border-dashed border-primary/50 text-primary text-xs cursor-pointer hover:bg-primary/5">
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
            <path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z"/>
          </svg>
          {t('spiderman.background.upload')}
          <input type="file" accept="image/*" className="hidden" onChange={handleBgUpload} />
        </label>
      </div>
    </div>

      
  );
}
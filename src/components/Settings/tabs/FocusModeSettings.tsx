/**
 * FocusModeSettings - 聚焦模式设置卡片
 *
 * 嵌入 GeneralTab 的独立小节。
 * 状态来自 useFocusModeStore（localStorage 持久化），不走 config 保存流程，
 * 因此即时生效、无需点保存按钮。
 */

import { useTranslation } from 'react-i18next';
import { useFocusModeStore, type FocusLevel } from '@/stores/focusModeStore';
import { isTauri } from '@/utils/platform';

export function FocusModeSettings() {
  const { t } = useTranslation('settings');
  const { level, setLevel, spotClearRadius, setSpotClearRadius, spotBlur, setSpotBlur,
    dimOpacity, setDimOpacity } = useFocusModeStore();

  // 移动端不可用
  if (!isTauri()) {
    return (
      <div className="p-4 bg-surface rounded-lg border border-border opacity-60">
        <h3 className="text-sm font-medium text-text-primary mb-1">
          {t('focus.title', '阅读聚焦模式')}
        </h3>
        <p className="text-xs text-text-secondary">
          {t('focus.desktopOnly', '仅桌面端可用：触屏设备无鼠标悬停语义。')}
        </p>
      </div>
    );
  }

  const levels: { v: FocusLevel; label: string; desc: string }[] = [
    { v: 0, label: t('focus.off', '关闭'), desc: t('focus.offDesc', '不启用聚焦') },
    { v: 1, label: t('focus.l1', '语义聚焦'), desc: t('focus.l1Desc', '悬停消息块高亮，其余降亮度') },
    { v: 2, label: t('focus.l2', '聚光灯'), desc: t('focus.l2Desc', '叠加全屏遮罩，鼠标处清晰') },
  ];

  return (
    <div className="p-4 bg-surface rounded-lg border border-border">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-medium text-text-primary">
            {t('focus.title', '阅读聚焦模式')}
          </h3>
          <p className="text-xs text-text-secondary mt-0.5">
            {t('focus.hint', '减少视觉干扰，专注当前内容。快捷键 Alt+F / Alt+Shift+F')}
          </p>
        </div>
      </div>

      {/* 模式三选 */}
      <div className="grid grid-cols-3 gap-2 mb-4">
        {levels.map(o => (
          <button
            key={o.v}
            type="button"
            onClick={() => setLevel(o.v)}
            className={`px-3 py-2 text-xs rounded-lg transition-colors text-center ${
              level === o.v
                ? 'bg-primary text-on-primary'
                : 'bg-background-surface border border-border text-text-secondary hover:text-text-primary'
            }`}
          >
            <div className="font-medium">{o.label}</div>
            <div className="text-[10px] opacity-70 mt-0.5">{o.desc}</div>
          </button>
        ))}
      </div>

      {/* 强度参数（L1/L2 各显示相关项） */}
      {level >= 1 && (
        <div className="space-y-3 pt-3 border-t border-border">
          <div>
            <div className="flex justify-between text-xs text-text-secondary mb-1">
              <span>{t('focus.dimOpacity', '兄弟降亮度')}</span>
              <span>{Math.round((1 - dimOpacity) * 100)}%</span>
            </div>
            <input
              type="range" min={0} max={0.8} step={0.04} value={1 - dimOpacity}
              onChange={e => setDimOpacity(1 - Number(e.target.value))}
              className="w-full accent-primary"
            />
          </div>
        </div>
      )}

      {level === 2 && (
        <div className="space-y-3 pt-3 border-t border-border">
          <div>
            <div className="flex justify-between text-xs text-text-secondary mb-1">
              <span>{t('focus.spotRadius', '聚光灯半径')}</span>
              <span>{spotClearRadius}px</span>
            </div>
            <input
              type="range" min={120} max={400} step={10} value={spotClearRadius}
              onChange={e => setSpotClearRadius(Number(e.target.value))}
              className="w-full accent-primary"
            />
          </div>
          <div>
            <div className="flex justify-between text-xs text-text-secondary mb-1">
              <span>{t('focus.spotBlur', '圆外模糊强度')}</span>
              <span>{spotBlur === 0 ? t('focus.noBlur', '不模糊') : `${spotBlur}px`}</span>
            </div>
            <input
              type="range" min={0} max={12} step={1} value={spotBlur}
              onChange={e => setSpotBlur(Number(e.target.value))}
              className="w-full accent-primary"
            />
            <p className="text-[10px] text-text-tertiary mt-1">
              {t('focus.spotBlurHint', '低端机掉帧时设为 0（仅降亮度不模糊）')}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

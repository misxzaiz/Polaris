/**
 * LayoutTab - 布局设置面板
 *
 * 功能:
 * - 切换 5 套内置布局预设
 * - 自定义布局 CRUD (保存当前为 / 应用 / 重命名 / 删除)
 * - 调整 ActivityBar 位置 (左/右/隐藏)
 * - 重置为默认布局
 * - 通过 JSON 文件导入/导出布局
 *
 * 布局更改通过 layoutStore 即时持久化,不走 SettingsModal 保存按钮.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  RotateCcw,
  PanelLeft,
  PanelRight,
  EyeOff,
  Save,
  Download,
  Upload,
  Edit2,
  Trash2,
  Bookmark,
} from 'lucide-react';
import { useLayoutStore, CUSTOM_PRESET_ID } from '@/stores/layoutStore';
import { BUILTIN_PRESETS } from '@/config/layoutPresets';
import type { ActivityBarPosition, CustomLayout, LayoutPreset } from '@/types/layout';
import { ConfirmDialog, InputDialog } from '@/components/Common';
import { useToastStore } from '@/stores/toastStore';
import { exportLayoutToFile, importLayoutFromFile } from '@/services/layoutTransferService';

type ExportMode = 'snapshot' | 'all';

interface ActivityBarOption {
  value: ActivityBarPosition;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  labelKey: string;
}

const ACTIVITY_BAR_OPTIONS: ActivityBarOption[] = [
  { value: 'left', icon: PanelLeft, labelKey: 'activityBar.left' },
  { value: 'right', icon: PanelRight, labelKey: 'activityBar.right' },
  { value: 'hidden', icon: EyeOff, labelKey: 'activityBar.hidden' },
];

function PresetCard({
  preset,
  active,
  onApply,
}: {
  preset: LayoutPreset;
  active: boolean;
  onApply: () => void;
}) {
  const { t } = useTranslation('layout');
  const name = preset.nameKey
    ? t(preset.nameKey.replace(/^layout:/, ''))
    : preset.name ?? preset.id;
  const description = preset.descriptionKey
    ? t(preset.descriptionKey.replace(/^layout:/, ''))
    : '';

  return (
    <button
      type="button"
      onClick={onApply}
      className={`relative flex flex-col gap-2 p-4 rounded-lg border text-left transition-all w-full ${
        active
          ? 'bg-primary/10 border-primary/40 ring-1 ring-primary/30'
          : 'bg-background-surface border-border-subtle hover:border-border hover:bg-background-hover'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={`text-sm font-medium ${active ? 'text-primary' : 'text-text-primary'}`}>
          {name}
        </span>
        {active && (
          <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-primary/20 text-primary font-medium">
            <Check size={10} />
            {t('preset.currentLabel')}
          </span>
        )}
      </div>
      {description && (
        <p className="text-xs text-text-tertiary leading-relaxed line-clamp-2">{description}</p>
      )}
      <PresetPreview preset={preset} />
    </button>
  );
}

/** 自定义布局卡片: 名字 + 预览图 + 应用/重命名/删除 操作 */
function CustomLayoutCard({
  layout,
  active,
  onApply,
  onRename,
  onDelete,
}: {
  layout: CustomLayout;
  active: boolean;
  onApply: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation('layout');
  // 转 CustomLayout → LayoutPreset 形式给 PresetPreview 用
  const fakePreset: LayoutPreset = {
    id: layout.id,
    name: layout.name,
    slots: layout.slots,
    activityBarPosition: layout.activityBarPosition,
    builtin: false,
  };

  return (
    <div
      className={`relative flex flex-col gap-2 p-4 rounded-lg border transition-all ${
        active
          ? 'bg-primary/10 border-primary/40 ring-1 ring-primary/30'
          : 'bg-background-surface border-border-subtle hover:border-border'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <Bookmark size={14} className={active ? 'text-primary' : 'text-text-tertiary'} />
          <span
            className={`text-sm font-medium truncate ${active ? 'text-primary' : 'text-text-primary'}`}
          >
            {layout.name}
          </span>
        </div>
        {active && (
          <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-primary/20 text-primary font-medium shrink-0">
            <Check size={10} />
            {t('preset.currentLabel')}
          </span>
        )}
      </div>

      <PresetPreview preset={fakePreset} />

      <div className="flex items-center gap-1 mt-1">
        <button
          type="button"
          onClick={onApply}
          disabled={active}
          className="flex-1 px-2 py-1 text-xs rounded border border-border-subtle bg-background-base text-text-secondary hover:text-text-primary hover:bg-background-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {t('custom.apply')}
        </button>
        <button
          type="button"
          onClick={onRename}
          title={t('custom.rename')}
          className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-background-hover transition-colors"
        >
          <Edit2 size={14} />
        </button>
        <button
          type="button"
          onClick={onDelete}
          title={t('custom.delete')}
          className="p-1 rounded text-text-tertiary hover:text-danger hover:bg-danger/10 transition-colors"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

/** Mini 布局示意图: 按真实 size 比例绘制各槽位,center 区按 activeModule 类型绘制内容 */
function PresetPreview({ preset }: { preset: LayoutPreset }) {
  const hasLeft = preset.slots.left.activeModule !== null;
  const hasRight = preset.slots.right.activeModule !== null;
  const hasBottom = preset.slots.bottom.activeModule !== null;
  const centerActive = preset.slots.center.activeModule;
  const showActivityBar = preset.activityBarPosition !== 'hidden';
  const activityOnLeft = preset.activityBarPosition === 'left';
  const activityOnRight = preset.activityBarPosition === 'right';

  // 按真实 size 比例计算可视像素 (横向钳制 12~36, 纵向钳制 6~22)
  const scaleH = (size: number) => Math.max(12, Math.min(36, Math.round(size / 10)));
  const scaleV = (size: number) => Math.max(6, Math.min(22, Math.round(size / 14)));
  const leftWidth = scaleH(preset.slots.left.size);
  const rightWidth = scaleH(preset.slots.right.size);
  const bottomHeight = scaleV(preset.slots.bottom.size);

  return (
    <div className="flex h-14 gap-0.5 rounded border border-border-subtle bg-background-base p-0.5 overflow-hidden">
      {showActivityBar && activityOnLeft && (
        <div className="w-1 rounded-sm bg-text-secondary/40" />
      )}
      {hasLeft && (
        <div
          className="rounded-sm bg-text-secondary/25 flex flex-col gap-0.5 p-0.5"
          style={{ width: `${leftWidth}px` }}
        >
          <div className="h-0.5 bg-text-secondary/40 rounded-sm" />
          <div className="h-0.5 bg-text-secondary/40 rounded-sm w-3/4" />
          <div className="h-0.5 bg-text-secondary/40 rounded-sm w-5/6" />
        </div>
      )}
      <div className="flex flex-col flex-1 gap-0.5 min-w-0">
        <CenterPreview activeModule={centerActive} />
        {hasBottom && (
          <div
            className="rounded-sm bg-text-secondary/25 flex items-center gap-0.5 px-1"
            style={{ height: `${bottomHeight}px` }}
          >
            <div className="h-1 w-2 bg-text-secondary/50 rounded-sm" />
            <div className="h-1 w-3 bg-text-secondary/35 rounded-sm" />
          </div>
        )}
      </div>
      {hasRight && (
        <div
          className="rounded-sm bg-primary/30 flex flex-col gap-0.5 p-0.5"
          style={{ width: `${rightWidth}px` }}
        >
          <div className="h-0.5 bg-primary/60 rounded-sm w-2/3" />
          <div className="h-0.5 bg-primary/50 rounded-sm w-3/4" />
          <div className="h-0.5 bg-primary/40 rounded-sm w-1/2" />
        </div>
      )}
      {showActivityBar && activityOnRight && (
        <div className="w-1 rounded-sm bg-text-secondary/40" />
      )}
    </div>
  );
}

/** Center 区域的语义化预览: chat 画对话气泡, 其他模块画列表行, 空时画编辑器代码线 */
function CenterPreview({ activeModule }: { activeModule: string | null }) {
  if (activeModule === 'chat') {
    return (
      <div className="flex-1 rounded-sm bg-primary/15 flex flex-col justify-center gap-0.5 px-1">
        <div className="h-1 w-2/3 bg-primary/50 rounded-full self-start" />
        <div className="h-1 w-1/2 bg-primary/40 rounded-full self-end" />
        <div className="h-1 w-3/5 bg-primary/45 rounded-full self-start" />
      </div>
    );
  }
  if (activeModule) {
    return (
      <div className="flex-1 rounded-sm bg-text-secondary/15 flex flex-col gap-0.5 px-1 py-0.5">
        <div className="h-1 w-full bg-text-secondary/40 rounded-sm" />
        <div className="h-1 w-3/4 bg-text-secondary/35 rounded-sm" />
        <div className="h-1 w-5/6 bg-text-secondary/30 rounded-sm" />
      </div>
    );
  }
  return (
    <div className="flex-1 rounded-sm bg-background-elevated flex flex-col gap-0.5 px-1 py-1 border border-border-subtle/40">
      <div className="h-0.5 w-1/3 bg-text-secondary/50 rounded-sm" />
      <div className="h-0.5 w-2/3 bg-text-secondary/40 rounded-sm" />
      <div className="h-0.5 w-1/2 bg-text-secondary/35 rounded-sm" />
      <div className="h-0.5 w-3/5 bg-text-secondary/30 rounded-sm" />
    </div>
  );
}

// ============================================================
// 主组件
// ============================================================
export function LayoutTab() {
  const { t } = useTranslation('layout');
  const activePresetId = useLayoutStore((s) => s.activePresetId);
  const activityBarPosition = useLayoutStore((s) => s.activityBarPosition);
  const customLayouts = useLayoutStore((s) => s.customLayouts);
  const applyPreset = useLayoutStore((s) => s.applyPreset);
  const setActivityBarPosition = useLayoutStore((s) => s.setActivityBarPosition);
  const resetToDefault = useLayoutStore((s) => s.resetToDefault);
  const saveAsCustomLayout = useLayoutStore((s) => s.saveAsCustomLayout);
  const deleteCustomLayout = useLayoutStore((s) => s.deleteCustomLayout);
  const renameCustomLayout = useLayoutStore((s) => s.renameCustomLayout);
  const exportLayout = useLayoutStore((s) => s.exportLayout);
  const importLayout = useLayoutStore((s) => s.importLayout);
  const toast = useToastStore();

  // === Dialog 状态 ===
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [renamingLayout, setRenamingLayout] = useState<CustomLayout | null>(null);
  const [deletingLayout, setDeletingLayout] = useState<CustomLayout | null>(null);
  // 导出范围: 'all' 默认 (适合备份/迁移); 'snapshot' 适合纯分享当前一份配置
  const [exportMode, setExportMode] = useState<ExportMode>('all');

  // === 校验器 ===
  const validateNewName = (value: string, excludeId?: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) return t('saveDialog.errorEmpty');
    if (customLayouts.some((l) => l.id !== excludeId && l.name === trimmed)) {
      return t('saveDialog.errorDuplicate');
    }
    return null;
  };

  // === 动作 ===
  const handleApplyPreset = (id: string, displayName: string) => {
    applyPreset(id);
    toast.success(t('toast.applied', { name: displayName }));
  };

  const handleSaveAs = (name: string) => {
    try {
      saveAsCustomLayout(name);
      toast.success(t('toast.saved'), t('toast.savedDesc', { name }));
      setShowSaveDialog(false);
    } catch (e) {
      toast.error(t('toast.saveFailed'), e instanceof Error ? e.message : String(e));
    }
  };

  const handleRename = (newName: string) => {
    if (!renamingLayout) return;
    renameCustomLayout(renamingLayout.id, newName);
    toast.success(t('toast.renamed', { name: newName }));
    setRenamingLayout(null);
  };

  const handleConfirmDelete = () => {
    if (!deletingLayout) return;
    const { id, name } = deletingLayout;
    deleteCustomLayout(id);
    toast.success(t('toast.deleted', { name }));
    setDeletingLayout(null);
  };

  const handleExport = async () => {
    try {
      const json = exportLayout(exportMode);
      const saved = await exportLayoutToFile(json);
      if (!saved) {
        // 用户取消
        toast.info(t('toast.exportCancelled'));
        return;
      }
      toast.success(t('toast.exported'), t('toast.exportedDesc', { path: saved }));
    } catch (e) {
      toast.error(t('toast.exportFailed'), e instanceof Error ? e.message : String(e));
    }
  };

  const handleImport = async () => {
    try {
      const content = await importLayoutFromFile();
      if (!content) return; // 用户取消
      importLayout(content);
      toast.success(t('toast.imported'));
    } catch (e) {
      toast.error(t('toast.importFailed'), e instanceof Error ? e.message : String(e));
    }
  };

  // ============================================================
  // 渲染
  // ============================================================
  return (
    <div className="space-y-6">
      {/* 顶部说明 */}
      <p className="text-sm text-text-secondary leading-relaxed">{t('tab.description')}</p>

      {/* 预设区 */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-text-primary">
            {t('preset.sectionTitle')}
          </h3>
          {activePresetId === CUSTOM_PRESET_ID && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-warning/20 text-warning">
              {t('preset.customLabel')}
            </span>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {BUILTIN_PRESETS.map((preset) => {
            const name = preset.nameKey
              ? t(preset.nameKey.replace(/^layout:/, ''))
              : preset.name ?? preset.id;
            return (
              <PresetCard
                key={preset.id}
                preset={preset}
                active={activePresetId === preset.id}
                onApply={() => handleApplyPreset(preset.id, name)}
              />
            );
          })}
        </div>
      </section>

      {/* 我的布局区 */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-text-primary">
            {t('custom.sectionTitle')}
          </h3>
          <button
            type="button"
            onClick={() => setShowSaveDialog(true)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs border border-border-subtle bg-background-surface text-text-secondary hover:text-text-primary hover:bg-background-hover transition-colors"
          >
            <Save size={12} />
            {t('actions.saveAs')}
          </button>
        </div>
        {customLayouts.length === 0 ? (
          <p className="text-xs text-text-tertiary leading-relaxed bg-background-surface border border-border-subtle border-dashed rounded-lg p-4">
            {t('custom.empty')}
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {customLayouts.map((layout) => (
              <CustomLayoutCard
                key={layout.id}
                layout={layout}
                active={activePresetId === layout.id}
                onApply={() => handleApplyPreset(layout.id, layout.name)}
                onRename={() => setRenamingLayout(layout)}
                onDelete={() => setDeletingLayout(layout)}
              />
            ))}
          </div>
        )}
      </section>

      {/* ActivityBar 位置 */}
      <section>
        <h3 className="text-sm font-semibold text-text-primary mb-1">
          {t('activityBar.sectionTitle')}
        </h3>
        <p className="text-xs text-text-tertiary mb-3 leading-relaxed">
          {t('activityBar.description')}
        </p>
        <div className="inline-flex rounded-lg border border-border-subtle bg-background-surface p-1">
          {ACTIVITY_BAR_OPTIONS.map(({ value, icon: Icon, labelKey }) => {
            const active = activityBarPosition === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => setActivityBarPosition(value)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm transition-colors ${
                  active
                    ? 'bg-primary/15 text-primary'
                    : 'text-text-secondary hover:text-text-primary hover:bg-background-hover'
                }`}
              >
                <Icon size={14} />
                <span>{t(labelKey)}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* 操作: 重置 + 导入导出 */}
      <section>
        <h3 className="text-sm font-semibold text-text-primary mb-1">
          {t('actions.sectionTitle')}
        </h3>
        <p className="text-xs text-text-tertiary mb-3 leading-relaxed">
          {t('actions.transferDescription')}
        </p>

        {/* 导出范围选择 (snapshot / all) */}
        <div className="mb-3 flex flex-col gap-1.5">
          <span className="text-xs text-text-secondary">{t('actions.exportMode.label')}</span>
          <div className="inline-flex rounded-lg border border-border-subtle bg-background-surface p-1 self-start">
            {(['all', 'snapshot'] as const).map((mode) => {
              const active = exportMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setExportMode(mode)}
                  title={t(`actions.exportMode.${mode}Hint`)}
                  className={`px-3 py-1 rounded-md text-xs transition-colors ${
                    active
                      ? 'bg-primary/15 text-primary'
                      : 'text-text-secondary hover:text-text-primary hover:bg-background-hover'
                  }`}
                >
                  {t(`actions.exportMode.${mode}`)}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={resetToDefault}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm border border-border-subtle bg-background-surface text-text-secondary hover:text-text-primary hover:bg-background-hover transition-colors"
          >
            <RotateCcw size={14} />
            {t('actions.reset')}
          </button>
          <button
            type="button"
            onClick={handleExport}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm border border-border-subtle bg-background-surface text-text-secondary hover:text-text-primary hover:bg-background-hover transition-colors"
          >
            <Download size={14} />
            {t('actions.export')}
          </button>
          <button
            type="button"
            onClick={handleImport}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm border border-border-subtle bg-background-surface text-text-secondary hover:text-text-primary hover:bg-background-hover transition-colors"
          >
            <Upload size={14} />
            {t('actions.import')}
          </button>
        </div>
      </section>

      {/* === Dialogs === */}
      {showSaveDialog && (
        <InputDialog
          title={t('saveDialog.title')}
          message={t('saveDialog.message')}
          placeholder={t('saveDialog.placeholder')}
          validate={(v) => validateNewName(v)}
          onConfirm={handleSaveAs}
          onCancel={() => setShowSaveDialog(false)}
        />
      )}
      {renamingLayout && (
        <InputDialog
          title={t('renameDialog.title')}
          message={t('renameDialog.message')}
          placeholder={t('renameDialog.placeholder')}
          defaultValue={renamingLayout.name}
          validate={(v) => validateNewName(v, renamingLayout.id)}
          onConfirm={handleRename}
          onCancel={() => setRenamingLayout(null)}
        />
      )}
      {deletingLayout && (
        <ConfirmDialog
          title={t('deleteDialog.title')}
          message={t('deleteDialog.message', { name: deletingLayout.name })}
          type="danger"
          onConfirm={handleConfirmDelete}
          onCancel={() => setDeletingLayout(null)}
        />
      )}
    </div>
  );
}

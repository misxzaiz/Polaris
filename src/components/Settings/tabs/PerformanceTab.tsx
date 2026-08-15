/**
 * 性能与资源设置面板
 *
 * 提供 8 个资源密集型功能的开关，默认全部关闭。
 * 用户按需开启，配置变更通过 config-changed 事件热切换。
 */

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { Config, PerformanceFeatures } from '@/types';

interface PerformanceTabProps {
  config: Config;
  onConfigChange: (config: Config) => void;
  loading: boolean;
}

interface FeatureToggle {
  key: keyof PerformanceFeatures;
  title: string;
  description: string;
  resource: string;
  fallback: string;
}

const FEATURES: FeatureToggle[] = [
  {
    key: 'fileWatcher',
    title: '文件自动监听',
    description: '监听工作区文件变化，自动刷新文件树和编辑器',
    resource: 'CPU',
    fallback: '关闭后需手动刷新文件树（点击刷新按钮或重新打开目录）',
  },
  {
    key: 'lspIndex',
    title: 'LSP 智能索引',
    description: '使用 tree-sitter 构建 AST 索引，提供精准的 Java 代码跳转和引用查找',
    resource: 'CPU + Memory',
    fallback: '关闭后代码跳转降级为正则匹配，精度降低但零持续开销',
  },
  {
    key: 'schedulerDaemon',
    title: '调度器守护进程',
    description: '后台轮询定时任务，到期自动触发执行',
    resource: 'CPU（低）',
    fallback: '关闭后定时任务不会自动执行，需手动触发',
  },
  {
    key: 'syntaxHighlighting',
    title: '语法高亮',
    description: '代码块使用 highlight.js 着色，支持 12+ 种编程语言',
    resource: 'Memory',
    fallback: '关闭后代码块以等宽字体原样展示，无颜色着色',
  },
  {
    key: 'mermaidDiagrams',
    title: 'Mermaid 图表渲染',
    description: '自动将 mermaid 代码块渲染为流程图、序列图等图表',
    resource: 'Memory',
    fallback: '关闭后 mermaid 代码块以普通代码样式展示，可在代码块上手动点击渲染',
  },
  {
    key: 'katexMath',
    title: 'KaTeX 数学公式',
    description: '自动渲染 LaTeX 数学公式（行内 $...$ 和块级 $$...$$）',
    resource: 'Memory',
    fallback: '关闭后 LaTeX 语法以原始文本展示',
  },
  {
    key: 'codeEditorLanguages',
    title: '编辑器语言包预加载',
    description: '启动时预加载全部编程语言的高亮和自动补全支持',
    resource: 'Memory',
    fallback: '关闭后按需加载（打开文件时按扩展名动态加载对应语言包）',
  },
  {
    key: 'pluginAutoStart',
    title: '插件服务自动启动',
    description: '应用启动时自动拉起所有已启用插件的后台服务进程',
    resource: 'Process',
    fallback: '关闭后首次使用插件功能时才按需启动服务',
  },
];

export function PerformanceTab({ config, onConfigChange, loading }: PerformanceTabProps) {
  const { t } = useTranslation('settings');
  // 受控组件：直接从 config 派生，不缓存本地状态。
  // 父组件 SettingsPage 保存后会刷新 config 传入，开关视觉状态即时跟随。
  const localPerf: PerformanceFeatures = config.performance ?? {};

  const toggleFeature = useCallback((key: keyof PerformanceFeatures) => {
    const newVal = !localPerf[key];
    onConfigChange({
      ...config,
      performance: {
        ...(config.performance ?? {}),
        [key]: newVal,
      },
    });
  }, [config, localPerf, onConfigChange]);

  const activeCount = Object.values(localPerf).filter(Boolean).length;
  const totalCount = FEATURES.length;

  return (
    <div className="space-y-4">
      {/* 概览 */}
      <div className="p-4 rounded-lg bg-surface border border-border-subtle">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-text-primary">
            {t('performance.overview', '当前已开启 {{active}}/{{total}} 个功能', {
              active: activeCount,
              total: totalCount,
            })}
          </span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
            {activeCount === 0 ? t('performance.allOff', '全部关闭 · 最轻量') : `${activeCount} 个运行中`}
          </span>
        </div>
        <p className="text-xs text-text-muted">
          {t('performance.tips', '默认全部关闭以节省资源，按需开启。配置变更即时生效，无需重启应用。')}
        </p>
      </div>

      {/* 功能列表 */}
      <div className="space-y-2">
        {FEATURES.map((feature) => {
          const enabled = localPerf[feature.key] ?? false;
          return (
            <div
              key={feature.key}
              className={`p-3 rounded-lg border transition-colors ${
                enabled
                  ? 'bg-primary/5 border-primary/30'
                  : 'bg-background-base border-border-subtle'
              } ${loading ? 'opacity-50 pointer-events-none' : ''}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text-primary">
                      {feature.title}
                    </span>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-text-tertiary/10 text-text-tertiary font-mono">
                      {feature.resource}
                    </span>
                  </div>
                  <p className="text-xs text-text-muted mt-1">{feature.description}</p>
                  <p className="text-xs text-text-tertiary mt-0.5 opacity-70">
                    {feature.fallback}
                  </p>
                </div>
                <button
                  className={`flex-shrink-0 w-10 h-5 rounded-full relative transition-colors ${
                    enabled ? 'bg-primary' : 'bg-text-tertiary/30'
                  } ${loading ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                  onClick={() => toggleFeature(feature.key)}
                  disabled={loading}
                  title={enabled ? '关闭' : '开启'}
                >
                  <span
                    className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${
                      enabled ? 'translate-x-5' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* 说明 */}
      <div className="mt-4 p-3 rounded-lg bg-warning-faint/50 border border-warning/20 text-xs text-text-muted">
        <p className="font-medium text-warning mb-1">{t('performance.notes', '注意事项')}</p>
        <ul className="space-y-1 list-disc list-inside text-xs">
          <li>{t('performance.note1', '部分功能之间有关联：如关闭 LSP 索引后，代码跳转仍可用但精度降低')}</li>
          <li>{t('performance.note2', '插件服务自动启动关闭后，首次使用插件功能时会有短暂等待（2-3 秒）')}</li>
          <li>{t('performance.note3', '如果不确定，保持默认关闭即可获得最佳性能')}</li>
        </ul>
      </div>
    </div>
  );
}
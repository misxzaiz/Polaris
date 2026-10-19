/**
 * 冲突预测卡片（FR-P2-AI4：fetch 后确定性风险清单，0 token）
 *
 * 对齐原型 `#conflict-predict` 卡片：
 * - 标题「AI-4 · 冲突预测」，标注「清单=确定计算 · 解释=⚡⚡」（解释层已砍，仅规则建议）
 * - 内容：「↓N commits 涉及文件 ∩ 本地 modified」+ 风险文件清单（标危险色）
 * - advice=commitOrStash → 琥珀色建议条「风险高 · 建议先 commit 本地 WIP 再 pull」
 *
 * 数据来自 gitStore.conflictPredictionsByWs[workspacePath]（fetch 后由 RemoteTab 触发填充）。
 * 无预测 / 无上游 → 渲染空态；父组件控制不展示（null 时不渲染）。
 */

import { useTranslation } from 'react-i18next'
import { useGitStore } from '@/stores/gitStore'

interface ConflictPredictionCardProps {
  /** 多仓库模式下生效的仓库路径（子仓库） */
  workspacePath: string
}

export function ConflictPredictionCard({ workspacePath }: ConflictPredictionCardProps) {
  const { t } = useTranslation('git')
  const prediction = useGitStore((s) =>
    workspacePath ? (s.conflictPredictionsByWs?.[workspacePath] ?? null) : null
  )

  // 无预测结果：不渲染（fetch 尚未执行 / 计算失败）
  if (!prediction) return null

  const riskCount = prediction.riskFiles.length
  const hasUpstream = prediction.upstream != null

  return (
    <div className="px-4 py-3 border-b border-border-subtle bg-background-surface">
      <div className="flex items-center gap-1 mb-1">
        <span className="text-xs font-semibold text-text-primary">✦ {t('conflictPredict.title')}</span>
        <span className="text-[10px] text-text-tertiary ml-auto">
          {t('conflictPredict.badge')}
        </span>
      </div>

      {/* 无上游：无比较对象 */}
      {!hasUpstream && (
        <div className="text-xs text-text-tertiary">{t('conflictPredict.noUpstream')}</div>
      )}

      {hasUpstream && (
        <div className="text-xs text-text-tertiary leading-relaxed">
          {/* 头部：↓behind commits 涉及文件 ∩ 本地 modified */}
          <span>
            {t('conflictPredict.behind', { count: prediction.behind })}
            {' '}
            {t('conflictPredict.riskCount', { count: riskCount })}
          </span>

          {/* 风险文件清单（危险色） */}
          {riskCount > 0 && (
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
              {prediction.riskFiles.map((file) => (
                <span key={file} className="text-xs text-danger font-mono">
                  ▸ {file}
                </span>
              ))}
            </div>
          )}

          {/* 规则建议条（master-plan §1.2：AI 解释层已砍，仅一条规则建议） */}
          {prediction.advice === 'commitOrStash' ? (
            <div className="mt-1.5 text-xs text-amber-600 dark:text-amber-400">
              {t('conflictPredict.advice.commitOrStash')}
            </div>
          ) : (
            <div className="mt-1.5 text-xs text-success">
              {t('conflictPredict.advice.none')}
            </div>
          )}

          {/* incoming commits 预览（短 sha + summary，供用户核对拉取内容） */}
          {prediction.incoming.length > 0 && (
            <div className="mt-1.5 space-y-0.5">
              {prediction.incoming.map((c) => (
                <div key={c.sha} className="flex items-center gap-1.5 font-mono text-xs text-text-tertiary">
                  <span className="text-[10px] text-primary">{c.shortSha}</span>
                  <span className="truncate">{c.summary || '—'}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * 数据存储卡片
 *
 * 设置 → 通用 内的"数据存储"区块。
 *
 * P1 阶段：只读展示
 *   - 当前数据根路径、状态徽章（默认/自定义）
 *   - 总占用、子目录详情
 *   - 旧版数据扫描结果（按钮 P2 阶段才生效）
 *   - 打开目录、复制路径
 *
 * P2/P3/P4 阶段会扩展：迁移按钮、改路径向导、对话存储迁移。
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  formatBytes,
  getDataRootInfo,
  migrateLegacyData,
  openPathInExplorer,
  scanLegacyData,
  type DataRootInfo,
  type LegacySource,
  type MigrateReport,
} from '@/services/dataRootService'
import {
  clearOpfsDialogs,
  isOpfsMigrated,
  migrateOpfsToTauri,
  probeOpfsDialogCount,
  type OpfsMigrationReport,
} from '@/services/dialogStorage'
import { isTauri } from '@/utils/platform'
import { createLogger } from '@/utils/logger'
import { ChangeDataRootWizard } from './ChangeDataRootWizard'

const log = createLogger('DataStorageCard')

export function DataStorageCard() {
  const { t } = useTranslation('settings')
  const [info, setInfo] = useState<DataRootInfo | null>(null)
  const [legacy, setLegacy] = useState<LegacySource[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showSubdirs, setShowSubdirs] = useState(false)
  const [copyHint, setCopyHint] = useState<string | null>(null)

  // 旧数据迁移相关
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [migrating, setMigrating] = useState(false)
  const [report, setReport] = useState<MigrateReport | null>(null)
  const [reportExpanded, setReportExpanded] = useState(false)
  /** 迁移冲突策略：merge=合并保留新版（默认安全） / overwrite=旧版覆盖新版 */
  const [migrateMode, setMigrateMode] = useState<'merge' | 'overwrite'>('merge')

  // 改路径向导
  const [wizardOpen, setWizardOpen] = useState(false)
  /** 迁移后是否处于"等重启"状态 */
  const [restarting, setRestarting] = useState(false)

  // OPFS 历史对话迁移
  const [opfsCount, setOpfsCount] = useState<number>(0)
  const [opfsMigrated, setOpfsMigrated] = useState<boolean>(isOpfsMigrated())
  const [opfsMigrating, setOpfsMigrating] = useState(false)
  const [opfsReport, setOpfsReport] = useState<OpfsMigrationReport | null>(null)
  const [opfsClearing, setOpfsClearing] = useState(false)

  async function refresh() {
    setLoading(true)
    setError(null)
    try {
      const [i, l] = await Promise.all([getDataRootInfo(), scanLegacyData()])
      setInfo(i)
      setLegacy(l)
      // 默认全选可迁移项
      setSelected(new Set(l.map((s) => s.path)))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      log.error('加载数据根信息失败', e instanceof Error ? e : new Error(msg))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    void probeOpfsDialogCount().then(setOpfsCount).catch(() => setOpfsCount(0))
  }, [])

  async function handleCopy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopyHint(t('dataStorage.copied', '已复制'))
      window.setTimeout(() => setCopyHint(null), 1500)
    } catch (e) {
      log.warn('复制失败', { error: String(e) })
    }
  }

  async function handleOpen(path: string) {
    try {
      await openPathInExplorer(path)
    } catch (e) {
      log.error('打开目录失败', e instanceof Error ? e : new Error(String(e)))
    }
  }

  function toggleSelect(path: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  async function handleMigrate() {
    if (selected.size === 0) return
    const overwrite = migrateMode === 'overwrite'
    const confirmMsg = overwrite
      ? t(
          'dataStorage.confirmMigrateOverwrite',
          '⚠ 覆盖模式将用旧版数据替换新版同名文件。此操作不可撤销，确认继续？',
        )
      : t(
          'dataStorage.confirmMigrate',
          '将合并所选旧数据到当前数据根。原数据保留以便回滚，重复内容不会覆盖。是否继续？',
        )
    if (!window.confirm(confirmMsg)) return
    setMigrating(true)
    setReport(null)
    try {
      const r = await migrateLegacyData(Array.from(selected), overwrite)
      setReport(r)
      // 迁移完成后刷新数据根（占用变化）
      void refresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      log.error('迁移失败', e instanceof Error ? e : new Error(msg))
    } finally {
      setMigrating(false)
    }
  }

  async function handleOpfsMigrate() {
    setOpfsMigrating(true)
    setOpfsReport(null)
    try {
      const r = await migrateOpfsToTauri(false)
      setOpfsReport(r)
      setOpfsMigrated(isOpfsMigrated())
      // 刷新计数（迁移完成后 OPFS 数量不变，但展示状态需要刷新）
      void probeOpfsDialogCount().then(setOpfsCount)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setOpfsReport({
        total: 0,
        success: 0,
        skipped: 0,
        failed: 1,
        errors: [{ name: '', error: msg }],
        flagged: false,
      })
      log.error('OPFS 迁移失败', e instanceof Error ? e : new Error(msg))
    } finally {
      setOpfsMigrating(false)
    }
  }

  async function handleOpfsClear() {
    if (
      !window.confirm(
        t(
          'dataStorage.confirmClearOpfs',
          '将清空浏览器 OPFS 中的所有对话记录。此操作不可撤销，请确认已成功迁移到磁盘。是否继续？',
        ),
      )
    ) {
      return
    }
    setOpfsClearing(true)
    try {
      const r = await clearOpfsDialogs()
      log.info('OPFS 清理完成', r)
      void probeOpfsDialogCount().then(setOpfsCount)
    } catch (e) {
      log.error('OPFS 清理失败', e instanceof Error ? e : new Error(String(e)))
    } finally {
      setOpfsClearing(false)
    }
  }

  /** 重启应用让迁移后的数据真正生效 */
  async function handleRestartApp() {
    setRestarting(true)
    try {
      if (isTauri()) {
        const { relaunch } = await import('@tauri-apps/plugin-process')
        await relaunch()
      } else {
        window.location.reload()
      }
    } catch (e) {
      log.error('重启失败', e instanceof Error ? e : new Error(String(e)))
      setRestarting(false)
    }
  }

  const totalLegacyBytes = useMemo(
    () => legacy.reduce((sum, s) => sum + s.sizeBytes, 0),
    [legacy],
  )
  const totalLegacyFiles = useMemo(
    () => legacy.reduce((sum, s) => sum + s.fileCount, 0),
    [legacy],
  )

  return (
    <div className="p-4 bg-surface rounded-lg border border-border space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-text-primary">
          {t('dataStorage.title', '数据存储')}
        </h3>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="text-xs px-2 py-1 rounded text-text-secondary hover:text-text-primary disabled:opacity-50"
        >
          {loading ? t('dataStorage.loading', '加载中…') : t('dataStorage.refresh', '刷新')}
        </button>
      </div>

      {error && (
        <div className="p-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-500">
          {t('dataStorage.loadFailed', '加载失败')}: {error}
        </div>
      )}

      {/* 当前数据根 */}
      {info && (
        <div className="space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-xs text-text-secondary mb-1">
                {t('dataStorage.currentLocation', '当前位置')}
                <span
                  className={`ml-2 inline-block px-1.5 py-0.5 rounded text-[10px] ${
                    info.isCustom
                      ? 'bg-amber-500/15 text-amber-500'
                      : 'bg-emerald-500/15 text-emerald-500'
                  }`}
                >
                  {info.isCustom
                    ? t('dataStorage.custom', '自定义路径')
                    : t('dataStorage.default', '默认路径')}
                </span>
              </div>
              <div
                className="text-sm text-text-primary font-mono break-all select-all"
                title={info.root}
              >
                {info.root}
              </div>
            </div>
            <div className="flex flex-col items-end gap-1 flex-shrink-0">
              <button
                type="button"
                onClick={() => handleOpen(info.root)}
                className="text-xs px-2 py-1 bg-background-surface border border-border rounded hover:text-text-primary text-text-secondary"
              >
                {t('dataStorage.open', '打开')}
              </button>
              <button
                type="button"
                onClick={() => handleCopy(info.root)}
                className="text-xs px-2 py-1 bg-background-surface border border-border rounded hover:text-text-primary text-text-secondary"
              >
                {copyHint ?? t('dataStorage.copy', '复制')}
              </button>
            </div>
          </div>

          <div className="flex items-center gap-3 text-xs text-text-secondary">
            <span>
              {t('dataStorage.totalSize', '占用')}: {formatBytes(info.totalSizeBytes)}
            </span>
            <span>·</span>
            <span>
              {t('dataStorage.totalFiles', '文件')}: {info.totalFileCount}
            </span>
            <button
              type="button"
              onClick={() => setShowSubdirs((v) => !v)}
              className="ml-auto text-text-tertiary hover:text-text-primary"
            >
              {showSubdirs
                ? t('dataStorage.collapse', '折叠子目录')
                : t('dataStorage.expand', '展开子目录')}
            </button>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => setWizardOpen(true)}
              className="text-xs px-3 py-1.5 bg-background-surface border border-border rounded hover:text-text-primary text-text-secondary"
            >
              {t('dataStorage.changeLocation', '更改位置…')}
            </button>
          </div>

          {showSubdirs && (
            <div className="border border-border rounded divide-y divide-border">
              {info.subdirs.map((sd) => (
                <div
                  key={sd.name}
                  className="flex items-center justify-between px-3 py-2 text-xs"
                >
                  <div className="font-mono text-text-primary">{sd.name}/</div>
                  <div className="flex items-center gap-3 text-text-secondary">
                    <span>{formatBytes(sd.sizeBytes)}</span>
                    <span>{sd.fileCount} {t('dataStorage.items', '项')}</span>
                    <button
                      type="button"
                      onClick={() => handleOpen(sd.path)}
                      className="text-text-tertiary hover:text-text-primary"
                    >
                      {t('dataStorage.open', '打开')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="text-[11px] text-text-tertiary">
            {t('dataStorage.anchorHint', '锚点文件')}: {info.anchorFile}
          </div>
        </div>
      )}

      {/* 旧版数据扫描结果 */}
      {legacy.length > 0 && (
        <div className="border-t border-border pt-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-xs text-text-secondary">
              {t('dataStorage.legacyTitle', '检测到旧版数据')}
              <span className="ml-2 text-text-tertiary">
                ({legacy.length} {t('dataStorage.sources', '处')} · {formatBytes(totalLegacyBytes)} · {totalLegacyFiles} {t('dataStorage.items', '项')})
              </span>
            </div>
          </div>
          <div className="border border-border rounded divide-y divide-border">
            {legacy.map((s) => {
              const checked = selected.has(s.path)
              return (
                <label
                  key={s.path}
                  className="flex items-center gap-3 px-3 py-2 text-xs cursor-pointer hover:bg-background-surface"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleSelect(s.path)}
                    disabled={migrating}
                    className="w-3.5 h-3.5"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-text-primary truncate">{s.label}</div>
                    <div className="text-text-tertiary font-mono truncate" title={s.path}>
                      {s.path}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-text-secondary flex-shrink-0">
                    <span>{formatBytes(s.sizeBytes)}</span>
                    <span>{s.fileCount} {t('dataStorage.items', '项')}</span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        void handleOpen(s.path)
                      }}
                      className="text-text-tertiary hover:text-text-primary"
                    >
                      {t('dataStorage.open', '打开')}
                    </button>
                  </div>
                </label>
              )
            })}
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="text-[11px] text-text-tertiary flex-1">
              {migrateMode === 'merge'
                ? t(
                    'dataStorage.legacyMigrateHint',
                    '合并模式：复制到数据根，重复内容跳过；冲突文件写入 *.legacy-* 副本，新版数据保持不变。',
                  )
                : t(
                    'dataStorage.legacyMigrateHintOverwrite',
                    '⚠ 覆盖模式：旧版数据直接替换新版同名文件，操作不可撤销。',
                  )}
            </div>
          </div>

          {/* 迁移策略选择 */}
          <div className="flex items-center gap-3 text-xs">
            <span className="text-text-secondary">
              {t('dataStorage.migrateMode', '冲突策略')}:
            </span>
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="migrateMode"
                checked={migrateMode === 'merge'}
                onChange={() => setMigrateMode('merge')}
                disabled={migrating}
                className="w-3.5 h-3.5"
              />
              <span className={migrateMode === 'merge' ? 'text-text-primary' : 'text-text-tertiary'}>
                {t('dataStorage.modeMerge', '合并（推荐）')}
              </span>
            </label>
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="migrateMode"
                checked={migrateMode === 'overwrite'}
                onChange={() => setMigrateMode('overwrite')}
                disabled={migrating}
                className="w-3.5 h-3.5"
              />
              <span className={migrateMode === 'overwrite' ? 'text-amber-500' : 'text-text-tertiary'}>
                {t('dataStorage.modeOverwrite', '旧版覆盖新版')}
              </span>
            </label>
            <button
              type="button"
              onClick={handleMigrate}
              disabled={migrating || selected.size === 0}
              className={`ml-auto text-xs px-3 py-1.5 rounded disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap ${
                migrateMode === 'overwrite'
                  ? 'bg-amber-500 text-white'
                  : 'bg-primary text-on-primary'
              }`}
            >
              {migrating
                ? t('dataStorage.migrating', '迁移中…')
                : migrateMode === 'overwrite'
                  ? t('dataStorage.migrateOverwrite', '覆盖迁移所选 ({{count}})', { count: selected.size })
                  : t('dataStorage.migrate', '迁移所选 ({{count}})', { count: selected.size })}
            </button>
          </div>

          {/* 迁移报告 */}
          {report && (
            <div className="mt-2 p-3 bg-background-surface border border-border rounded text-xs space-y-2">
              {/* 需要重启提示 — 仅当确实写入新文件或写入冲突副本时显示 */}
              {(report.successCount > 0 || report.conflictCount > 0) && (
                <div className="flex items-start gap-2 p-2 bg-amber-500/10 border border-amber-500/30 rounded">
                  <span className="text-amber-500 text-base leading-none">⟳</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-amber-500 font-medium">
                      {t('dataStorage.restartRequired', '迁移完成，请重启应用')}
                    </div>
                    <div className="text-text-secondary mt-0.5">
                      {t(
                        'dataStorage.restartRequiredHint',
                        '配置、调度任务、日志等数据已经写入磁盘，但运行中的内存副本还是迁移前的版本。重启后才会真正加载迁移后的数据。',
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleRestartApp}
                    disabled={restarting}
                    className="flex-shrink-0 text-xs px-3 py-1.5 bg-amber-500 text-white rounded disabled:opacity-50 whitespace-nowrap"
                  >
                    {restarting
                      ? t('dataStorage.restarting', '重启中…')
                      : t('dataStorage.restartNow', '立即重启')}
                  </button>
                </div>
              )}

              <div className="flex items-center gap-3">
                <span className="text-emerald-500">
                  ✓ {report.successCount} {t('dataStorage.report.copied', '已复制')}
                </span>
                {report.skippedCount > 0 && (
                  <span className="text-text-secondary">
                    ↷ {report.skippedCount} {t('dataStorage.report.skipped', '跳过')}
                  </span>
                )}
                {report.conflictCount > 0 && (
                  <span className="text-amber-500">
                    ⚠ {report.conflictCount} {t('dataStorage.report.conflict', '冲突')}
                  </span>
                )}
                {report.errorCount > 0 && (
                  <span className="text-red-500">
                    ✗ {report.errorCount} {t('dataStorage.report.failed', '失败')}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setReportExpanded((v) => !v)}
                  className="ml-auto text-text-tertiary hover:text-text-primary"
                >
                  {reportExpanded
                    ? t('dataStorage.report.collapse', '收起详情')
                    : t('dataStorage.report.expand', '查看详情')}
                </button>
              </div>
              <div className="text-[11px] text-text-tertiary font-mono">
                {t('dataStorage.report.logFile', '日志')}: {report.logFile}{' '}
                <button
                  type="button"
                  onClick={() => handleOpen(report.logFile)}
                  className="ml-2 text-text-secondary hover:text-text-primary underline"
                >
                  {t('dataStorage.open', '打开')}
                </button>
              </div>
              {reportExpanded && (
                <div className="max-h-48 overflow-auto border border-border rounded">
                  {report.items.map((it, idx) => (
                    <div
                      key={idx}
                      className="flex items-start gap-2 px-2 py-1 text-[11px] border-b border-border last:border-b-0"
                    >
                      <span
                        className={`flex-shrink-0 w-14 ${
                          it.status === 'copied'
                            ? 'text-emerald-500'
                            : it.status === 'conflicted'
                              ? 'text-amber-500'
                              : it.status === 'failed'
                                ? 'text-red-500'
                                : 'text-text-tertiary'
                        }`}
                      >
                        {it.status}
                      </span>
                      <div className="flex-1 min-w-0 font-mono">
                        <div className="text-text-secondary truncate" title={it.source}>
                          {it.source}
                        </div>
                        {it.target && (
                          <div className="text-text-tertiary truncate" title={it.target}>
                            → {it.target}
                          </div>
                        )}
                        {it.message && (
                          <div className="text-text-tertiary">{it.message}</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 历史对话迁移（OPFS → 磁盘） */}
      {isTauri() && opfsCount > 0 && (
        <div className="border-t border-border pt-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-xs text-text-secondary">
              {t('dataStorage.dialogMigrateTitle', '历史对话迁移')}
            </div>
            {opfsMigrated && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-500">
                {t('dataStorage.dialogMigrated', '已迁移')}
              </span>
            )}
          </div>
          <div className="text-[11px] text-text-tertiary">
            {t(
              'dataStorage.dialogMigrateHint',
              '检测到浏览器 OPFS 中存有 {{count}} 条历史对话；建议迁移到磁盘以便备份和跟随数据根。',
              { count: opfsCount },
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleOpfsMigrate}
              disabled={opfsMigrating}
              className="text-xs px-3 py-1.5 bg-primary text-on-primary rounded disabled:opacity-50"
            >
              {opfsMigrating
                ? t('dataStorage.migrating', '迁移中…')
                : t('dataStorage.dialogMigrateBtn', '迁移到磁盘')}
            </button>
            {opfsMigrated && (
              <button
                type="button"
                onClick={handleOpfsClear}
                disabled={opfsClearing}
                className="text-xs px-3 py-1.5 bg-background-surface border border-border rounded text-text-secondary hover:text-text-primary disabled:opacity-50"
              >
                {opfsClearing
                  ? t('dataStorage.clearing', '清理中…')
                  : t('dataStorage.dialogClearOpfs', '清理 OPFS（可选）')}
              </button>
            )}
          </div>

          {opfsReport && (
            <div className="p-2 bg-background-surface border border-border rounded text-[11px] space-y-1">
              <div className="flex items-center gap-3">
                <span className="text-emerald-500">
                  ✓ {opfsReport.success}
                </span>
                {opfsReport.skipped > 0 && (
                  <span className="text-text-secondary">
                    ↷ {opfsReport.skipped}
                  </span>
                )}
                {opfsReport.failed > 0 && (
                  <span className="text-red-500">
                    ✗ {opfsReport.failed}
                  </span>
                )}
                <span className="text-text-tertiary">
                  / {opfsReport.total} {t('dataStorage.dialogTotal', '条')}
                </span>
              </div>
              {opfsReport.errors.length > 0 && (
                <div className="max-h-24 overflow-auto text-text-tertiary font-mono">
                  {opfsReport.errors.slice(0, 10).map((e, i) => (
                    <div key={i}>
                      {e.name || '(unnamed)'}: {e.error}
                    </div>
                  ))}
                  {opfsReport.errors.length > 10 && (
                    <div>... +{opfsReport.errors.length - 10}</div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {wizardOpen && info && (
        <ChangeDataRootWizard
          current={info}
          onClose={() => setWizardOpen(false)}
          onChanged={refresh}
        />
      )}
    </div>
  )
}

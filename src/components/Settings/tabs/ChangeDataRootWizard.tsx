/**
 * 切换数据根向导（Modal）
 *
 * 三步流：
 *   1. 选择目标路径（浏览或恢复默认）
 *   2. 选择处理方式（仅切换 / 同时移动数据）
 *   3. 校验 → 切换 → 重启提示
 *
 * 切换成功后必须重启应用。
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  formatBytes,
  setDataRoot,
  validateDataRootTarget,
  type DataRootInfo,
  type SetDataRootMode,
  type SetDataRootReport,
  type TargetValidation,
} from '@/services/dataRootService'
import { isTauri } from '@/utils/platform'
import { createLogger } from '@/utils/logger'

const log = createLogger('ChangeDataRootWizard')

interface Props {
  current: DataRootInfo
  onClose: () => void
  /** 切换成功后的回调（可用于刷新外层数据） */
  onChanged: () => void
}

type WizardStep = 'select' | 'confirm' | 'progress' | 'done' | 'error'

export function ChangeDataRootWizard({ current, onClose, onChanged }: Props) {
  const { t } = useTranslation('settings')
  const [step, setStep] = useState<WizardStep>('select')

  // Step 1
  const [targetPath, setTargetPath] = useState<string>('')
  const [resetToDefault, setResetToDefault] = useState(false)
  const [mode, setMode] = useState<SetDataRootMode>('move_data')

  // Validation
  const [validating, setValidating] = useState(false)
  const [validation, setValidation] = useState<TargetValidation | null>(null)

  // Apply
  const [applyError, setApplyError] = useState<string | null>(null)
  const [report, setReport] = useState<SetDataRootReport | null>(null)
  const [restarting, setRestarting] = useState(false)

  async function handleBrowse() {
    if (!isTauri()) {
      window.alert(t('dataStorage.wizard.tauriOnly', '改路径仅在桌面端可用'))
      return
    }
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const picked = await open({
        directory: true,
        multiple: false,
        title: t('dataStorage.wizard.pickTitle', '选择新的数据存储位置'),
      })
      if (typeof picked === 'string' && picked.length > 0) {
        setTargetPath(picked)
        setResetToDefault(false)
      }
    } catch (e) {
      log.warn('选择目录失败', { error: String(e) })
    }
  }

  async function handleNext() {
    setValidating(true)
    setValidation(null)
    try {
      const v = await validateDataRootTarget({
        newPath: resetToDefault ? null : targetPath,
        mode,
      })
      setValidation(v)
      if (v.ok) {
        setStep('confirm')
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setValidation({
        ok: false,
        errors: [msg],
        warnings: [],
        resolvedPath: targetPath,
        currentSizeBytes: 0,
      })
    } finally {
      setValidating(false)
    }
  }

  async function handleConfirm() {
    setStep('progress')
    setApplyError(null)
    try {
      const r = await setDataRoot({
        newPath: resetToDefault ? null : targetPath,
        mode,
      })
      setReport(r)
      setStep('done')
      onChanged()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setApplyError(msg)
      setStep('error')
    }
  }

  async function handleRestart() {
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

  // ESC 关闭（仅在非进行中状态）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && step !== 'progress') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, onClose])

  const canProceed = (resetToDefault || targetPath.trim().length > 0) && !validating

  return (
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-[1000]"
      onClick={(e) => {
        if (e.target === e.currentTarget && step !== 'progress') onClose()
      }}
    >
      <div className="w-[560px] max-w-[92vw] bg-surface border border-border rounded-lg shadow-2xl">
        {/* Header */}
        <div className="px-5 py-3 border-b border-border flex items-center justify-between">
          <h3 className="text-sm font-medium text-text-primary">
            {t('dataStorage.wizard.title', '更改数据存储位置')}
          </h3>
          {step !== 'progress' && (
            <button
              type="button"
              onClick={onClose}
              className="text-text-tertiary hover:text-text-primary text-xs"
            >
              ✕
            </button>
          )}
        </div>

        {/* Content */}
        <div className="px-5 py-4 space-y-4">
          {step === 'select' && (
            <>
              <div className="text-xs text-text-secondary">
                {t('dataStorage.wizard.currentLabel', '当前位置')}
              </div>
              <div className="text-xs text-text-primary font-mono break-all">
                {current.root}
              </div>

              <div className="border-t border-border pt-3 space-y-3">
                <div className="text-xs text-text-secondary">
                  {t('dataStorage.wizard.targetLabel', '新位置')}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={resetToDefault ? '' : targetPath}
                    onChange={(e) => {
                      setTargetPath(e.target.value)
                      setResetToDefault(false)
                    }}
                    placeholder={t(
                      'dataStorage.wizard.targetPlaceholder',
                      '点击右侧浏览选择目录',
                    )}
                    disabled={resetToDefault}
                    className="flex-1 px-3 py-1.5 bg-background border border-border rounded text-sm text-text-primary font-mono disabled:opacity-50"
                  />
                  <button
                    type="button"
                    onClick={handleBrowse}
                    disabled={resetToDefault}
                    className="text-xs px-3 py-1.5 bg-background-surface border border-border rounded hover:text-text-primary text-text-secondary disabled:opacity-50"
                  >
                    {t('dataStorage.wizard.browse', '浏览…')}
                  </button>
                </div>

                <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
                  <input
                    type="checkbox"
                    checked={resetToDefault}
                    onChange={(e) => {
                      setResetToDefault(e.target.checked)
                      if (e.target.checked) setTargetPath('')
                    }}
                    className="w-3.5 h-3.5"
                  />
                  {t('dataStorage.wizard.resetDefault', '恢复默认位置')}
                </label>
              </div>

              <div className="border-t border-border pt-3 space-y-2">
                <div className="text-xs text-text-secondary">
                  {t('dataStorage.wizard.modeLabel', '处理方式')}
                </div>
                <label className="flex items-start gap-2 text-xs cursor-pointer p-2 rounded hover:bg-background-surface">
                  <input
                    type="radio"
                    name="mode"
                    checked={mode === 'move_data'}
                    onChange={() => setMode('move_data')}
                    className="mt-0.5"
                  />
                  <div>
                    <div className="text-text-primary">
                      {t('dataStorage.wizard.modeMove', '同时移动数据（推荐）')}
                    </div>
                    <div className="text-text-tertiary mt-0.5">
                      {t(
                        'dataStorage.wizard.modeMoveHint',
                        '将现有数据复制到新位置，旧位置数据保留以便回滚。',
                      )}
                    </div>
                  </div>
                </label>
                <label className="flex items-start gap-2 text-xs cursor-pointer p-2 rounded hover:bg-background-surface">
                  <input
                    type="radio"
                    name="mode"
                    checked={mode === 'switch_only'}
                    onChange={() => setMode('switch_only')}
                    className="mt-0.5"
                  />
                  <div>
                    <div className="text-text-primary">
                      {t('dataStorage.wizard.modeSwitch', '仅切换位置')}
                    </div>
                    <div className="text-text-tertiary mt-0.5">
                      {t(
                        'dataStorage.wizard.modeSwitchHint',
                        '只更改设置，旧位置数据原地保留，新位置从零开始。',
                      )}
                    </div>
                  </div>
                </label>
              </div>

              {validation && !validation.ok && (
                <div className="p-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-500 space-y-1">
                  {validation.errors.map((e, i) => (
                    <div key={i}>{e}</div>
                  ))}
                </div>
              )}
            </>
          )}

          {step === 'confirm' && validation && (
            <>
              <div className="text-xs text-text-secondary">
                {t('dataStorage.wizard.confirmTitle', '确认切换')}
              </div>
              <div className="space-y-2 text-xs">
                <div>
                  <span className="text-text-tertiary">{t('dataStorage.wizard.from', '从')}: </span>
                  <span className="font-mono">{current.root}</span>
                </div>
                <div>
                  <span className="text-text-tertiary">{t('dataStorage.wizard.to', '到')}: </span>
                  <span className="font-mono">{validation.resolvedPath}</span>
                </div>
                <div>
                  <span className="text-text-tertiary">{t('dataStorage.wizard.mode', '方式')}: </span>
                  <span className="text-text-primary">
                    {mode === 'move_data'
                      ? t('dataStorage.wizard.modeMove', '同时移动数据（推荐）')
                      : t('dataStorage.wizard.modeSwitch', '仅切换位置')}
                  </span>
                </div>
                {mode === 'move_data' && (
                  <div>
                    <span className="text-text-tertiary">{t('dataStorage.wizard.dataSize', '数据量')}: </span>
                    <span>{formatBytes(validation.currentSizeBytes)}</span>
                  </div>
                )}
              </div>

              {validation.warnings.length > 0 && (
                <div className="p-2 bg-amber-500/10 border border-amber-500/30 rounded text-xs text-amber-500 space-y-1">
                  {validation.warnings.map((w, i) => (
                    <div key={i}>⚠ {w}</div>
                  ))}
                </div>
              )}

              <div className="text-[11px] text-text-tertiary">
                {t(
                  'dataStorage.wizard.restartHint',
                  '切换成功后需要重启应用。锚点在所有先决条件成功后才更新；中途失败可放心重试。',
                )}
              </div>
            </>
          )}

          {step === 'progress' && (
            <div className="text-center py-8">
              <div className="inline-block w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin mb-3" />
              <div className="text-sm text-text-primary">
                {t('dataStorage.wizard.processing', '正在切换数据根，请稍候…')}
              </div>
              <div className="text-xs text-text-tertiary mt-1">
                {t('dataStorage.wizard.dontClose', '请勿关闭应用')}
              </div>
            </div>
          )}

          {step === 'done' && report && (
            <>
              <div className="text-sm text-emerald-500">
                ✓ {t('dataStorage.wizard.success', '切换成功')}
              </div>
              <div className="text-xs space-y-1 font-mono">
                <div>{t('dataStorage.wizard.from', '从')}: {report.oldRoot}</div>
                <div>{t('dataStorage.wizard.to', '到')}: {report.newRoot}</div>
              </div>
              {report.moveReport && (
                <div className="text-xs text-text-secondary">
                  {t('dataStorage.report.copied', '已复制')}: {report.moveReport.successCount}
                  {report.moveReport.skippedCount > 0 && (
                    <> · {t('dataStorage.report.skipped', '跳过')}: {report.moveReport.skippedCount}</>
                  )}
                  {report.moveReport.conflictCount > 0 && (
                    <> · {t('dataStorage.report.conflict', '冲突')}: {report.moveReport.conflictCount}</>
                  )}
                </div>
              )}
              <div className="text-xs text-text-tertiary">
                {t(
                  'dataStorage.wizard.restartNow',
                  '需要重启应用让新位置生效。点击下方按钮立即重启。',
                )}
              </div>
            </>
          )}

          {step === 'error' && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-500">
              <div className="font-medium mb-1">
                {t('dataStorage.wizard.errorTitle', '切换失败')}
              </div>
              <div>{applyError}</div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
          {step === 'select' && (
            <>
              <button
                type="button"
                onClick={onClose}
                className="text-xs px-3 py-1.5 text-text-secondary hover:text-text-primary"
              >
                {t('common.cancel', '取消')}
              </button>
              <button
                type="button"
                onClick={handleNext}
                disabled={!canProceed}
                className="text-xs px-3 py-1.5 bg-primary text-on-primary rounded disabled:opacity-50"
              >
                {validating ? t('dataStorage.wizard.validating', '校验中…') : t('common.next', '下一步')}
              </button>
            </>
          )}
          {step === 'confirm' && (
            <>
              <button
                type="button"
                onClick={() => setStep('select')}
                className="text-xs px-3 py-1.5 text-text-secondary hover:text-text-primary"
              >
                {t('common.back', '上一步')}
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                className="text-xs px-3 py-1.5 bg-primary text-on-primary rounded"
              >
                {t('dataStorage.wizard.confirm', '开始切换')}
              </button>
            </>
          )}
          {step === 'done' && (
            <>
              <button
                type="button"
                onClick={onClose}
                className="text-xs px-3 py-1.5 text-text-secondary hover:text-text-primary"
              >
                {t('dataStorage.wizard.restartLater', '稍后重启')}
              </button>
              <button
                type="button"
                onClick={handleRestart}
                disabled={restarting}
                className="text-xs px-3 py-1.5 bg-primary text-on-primary rounded disabled:opacity-50"
              >
                {restarting ? t('dataStorage.wizard.restarting', '重启中…') : t('dataStorage.wizard.restartNowBtn', '立即重启')}
              </button>
            </>
          )}
          {step === 'error' && (
            <>
              <button
                type="button"
                onClick={onClose}
                className="text-xs px-3 py-1.5 text-text-secondary hover:text-text-primary"
              >
                {t('common.close', '关闭')}
              </button>
              <button
                type="button"
                onClick={() => setStep('select')}
                className="text-xs px-3 py-1.5 bg-primary text-on-primary rounded"
              >
                {t('common.retry', '重试')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

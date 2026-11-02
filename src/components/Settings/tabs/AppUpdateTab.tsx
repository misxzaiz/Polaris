import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, Download, Loader2, RefreshCw } from 'lucide-react'

import { currentMode } from '@/services/transport'
import {
  getUpdateStatus,
  listenUpdateCompleted,
  listenUpdateProgress,
  runAutoUpdate,
  type UpdateProgressEvent,
} from '@/services/appUpdateService'
import { listAppReleases, type AppRelease } from '@/services/updateService'
import { useConfigStore } from '@/stores/configStore'
import { useToastStore } from '@/stores/toastStore'
import { ExternalLink as ExternalLinkBtn } from '@/components/Common';

function normalizeVersion(version: string): string {
  return version.replace(/^v/i, '')
}

function formatBytes(value: number): string {
  if (!value) return ''
  const mb = value / 1024 / 1024
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`
}

function formatDate(value: string): string {
  if (!value) return ''
  return new Date(value).toLocaleDateString()
}

/** Config.update 段形状（Rust UpdateSourceConfig camelCase 对齐） */
interface UpdateSourcePatch {
  sourceType: 'github' | 'local' | 'custom'
  repo: string
  localManifestPath?: string | null
  manifestUrl?: string | null
  checkOnStartup?: boolean
}

/** 更新阶段文案（i18n 键缺省回退内置文案） */
const STAGE_LABEL: Record<UpdateProgressEvent['stage'], string> = {
  checking: '检查更新中',
  downloading: '下载中',
  installing: '安装中',
  completed: '完成',
}

export function AppUpdateTab() {
  const { t } = useTranslation('settings')
  const toast = useToastStore()
  const config = useConfigStore((s) => s.config)
  const updateConfigPatch = useConfigStore((s) => s.updateConfigPatch)
  const updateSource = (config as { update?: UpdateSourcePatch } | null)?.update
  const [currentVersion, setCurrentVersion] = useState('unknown')
  const [supported, setSupported] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [progress, setProgress] = useState<UpdateProgressEvent | null>(null)
  const [releases, setReleases] = useState<AppRelease[]>([])
  const [isLoadingReleases, setIsLoadingReleases] = useState(false)
  const [releaseError, setReleaseError] = useState<string | null>(null)

  const canUseUpdater = currentMode === 'tauri' && supported

  const progressPercent = useMemo(() => {
    if (!progress) return null
    // installing/completed 阶段无明确总量，以阶段名展示
    return progress.percent
  }, [progress])

  const loadReleases = useCallback(async () => {
    setIsLoadingReleases(true)
    setReleaseError(null)

    try {
      const result = await listAppReleases()
      setReleases(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setReleaseError(message)
    } finally {
      setIsLoadingReleases(false)
    }
  }, [])

  useEffect(() => {
    getUpdateStatus().then((status) => {
      setSupported(status.supported)
      if (status.supported) {
        setCurrentVersion(status.currentVersion)
      }
    })

    // 订阅更新事件（进度 + 完成）；退订在卸载时
    const unlisteners: Array<() => void> = []
    listenUpdateProgress((p) => setProgress(p)).then((un) => unlisteners.push(un))
    listenUpdateCompleted((p) => {
      setIsRunning(false)
      setProgress(null)
      if (p.updated) {
        toast.success(t('appUpdate.updateDone'), t('appUpdate.updateDoneDesc'))
      } else if (p.reason === 'error') {
        toast.error(t('appUpdate.installFailed'), p.error || '')
      } else {
        toast.info(t('appUpdate.upToDate'), t('appUpdate.upToDateDesc'))
      }
    }).then((un) => unlisteners.push(un))

    loadReleases()
    return () => {
      unlisteners.forEach((un) => un())
    }
  }, [loadReleases, t, toast])

  const handleSaveSource = async (patch: Partial<UpdateSourcePatch>) => {
    const merged: UpdateSourcePatch = {
      sourceType: updateSource?.sourceType ?? 'github',
      repo: updateSource?.repo ?? 'misxzaiz/Polaris',
      localManifestPath: updateSource?.localManifestPath ?? null,
      manifestUrl: updateSource?.manifestUrl ?? null,
      checkOnStartup: updateSource?.checkOnStartup ?? false,
      ...patch,
    }
    try {
      await updateConfigPatch({ update: merged } as never)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(t('appUpdate.checkFailed'), message)
    }
  }

  const handleRunUpdate = async () => {
    setIsRunning(true)
    setProgress({ stage: 'checking', percent: 0 })
    try {
      await runAutoUpdate()
      // 触发即跑到底：后续进度/结果经 update.progress / update.completed 事件回传
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(t('appUpdate.checkFailed'), message)
      setIsRunning(false)
      setProgress(null)
    }
  }

  return (
    <div className="space-y-6">
      <div className="p-4 bg-surface rounded-lg border border-border">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium text-text-primary">{t('appUpdate.title')}</h3>
            <p className="text-xs text-text-secondary mt-1">{t('appUpdate.description')}</p>
          </div>
          <span className={`text-xs px-2 py-1 rounded ${canUseUpdater ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'}`}>
            {canUseUpdater ? t('appUpdate.desktopAvailable') : t('appUpdate.desktopOnly')}
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4">
          <div className="p-3 rounded border border-border-subtle bg-background-surface">
            <div className="text-xs text-text-tertiary">{t('appUpdate.currentVersion')}</div>
            <div className="text-base font-semibold text-text-primary mt-1">{currentVersion}</div>
          </div>
          <div className="p-3 rounded border border-border-subtle bg-background-surface">
            <div className="text-xs text-text-tertiary">{t('appUpdate.source')}</div>
            <select
              value={updateSource?.sourceType ?? 'github'}
              onChange={(e) => handleSaveSource({ sourceType: e.target.value as UpdateSourcePatch['sourceType'] })}
              disabled={!canUseUpdater}
              className="mt-1 w-full text-sm bg-transparent text-text-primary border border-border-subtle rounded px-1.5 py-0.5 focus:outline-none focus:border-primary"
            >
              <option value="github">GitHub Releases</option>
              <option value="local">Local（本地包）</option>
              <option value="custom">Custom（自建源）</option>
            </select>
          </div>
          <div className="p-3 rounded border border-border-subtle bg-background-surface">
            <div className="text-xs text-text-tertiary">
              {updateSource?.sourceType === 'local'
                ? t('appUpdate.localManifestPath')
                : updateSource?.sourceType === 'custom'
                  ? t('appUpdate.customManifestUrl')
                  : t('appUpdate.githubRepo')}
            </div>
            {updateSource?.sourceType === 'local' ? (
              <input
                type="text"
                value={updateSource?.localManifestPath ?? ''}
                onChange={(e) => handleSaveSource({ localManifestPath: e.target.value })}
                placeholder="D:\\dist\\latest.json"
                className="mt-1 w-full text-sm bg-transparent text-text-primary border border-border-subtle rounded px-1.5 py-0.5 focus:outline-none focus:border-primary"
              />
            ) : updateSource?.sourceType === 'custom' ? (
              <input
                type="text"
                value={updateSource?.manifestUrl ?? ''}
                onChange={(e) => handleSaveSource({ manifestUrl: e.target.value })}
                placeholder="https://host/latest.json"
                className="mt-1 w-full text-sm bg-transparent text-text-primary border border-border-subtle rounded px-1.5 py-0.5 focus:outline-none focus:border-primary"
              />
            ) : (
              <div className="text-base font-semibold text-text-primary mt-1">
                {updateSource?.repo ?? 'misxzaiz/Polaris'}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 mt-4">
          <button
            type="button"
            onClick={handleRunUpdate}
            disabled={!canUseUpdater || isRunning}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded bg-primary text-white hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isRunning ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            {t('appUpdate.checkAndInstall')}
          </button>
        </div>

        {progressPercent !== null && (
          <div className="mt-4">
            <div className="flex items-center justify-between text-xs text-text-tertiary mb-1">
              <span>
                {STAGE_LABEL[progress?.stage ?? 'checking']}
                {progress?.version ? ` · v${progress.version}` : ''}
              </span>
              <span>{progress?.stage === 'installing' ? '' : `${progressPercent}%`}</span>
            </div>
            <div className="h-2 rounded-full bg-background-hover overflow-hidden">
              <div className="h-full bg-primary transition-all" style={{ width: `${progressPercent}%` }} />
            </div>
          </div>
        )}

        <div className="mt-4 p-3 rounded bg-warning/10 text-warning text-xs flex gap-2">
          <AlertTriangle size={15} className="shrink-0 mt-0.5" />
          <span>{t('appUpdate.autoUpdateNote')}</span>
        </div>
      </div>

      <div className="p-4 bg-surface rounded-lg border border-border">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div>
            <h3 className="text-sm font-medium text-text-primary">{t('appUpdate.historyTitle')}</h3>
            <p className="text-xs text-text-secondary mt-1">{t('appUpdate.historyDesc')}</p>
          </div>
          <button
            type="button"
            onClick={loadReleases}
            disabled={isLoadingReleases}
            className="p-1.5 rounded text-text-tertiary hover:text-text-primary hover:bg-background-hover disabled:opacity-50"
            title={t('appUpdate.refreshReleases')}
          >
            <RefreshCw size={15} className={isLoadingReleases ? 'animate-spin' : ''} />
          </button>
        </div>

        {releaseError && (
          <div className="mb-3 p-3 rounded bg-danger/10 text-danger text-xs">{releaseError}</div>
        )}

        <div className="divide-y divide-border-subtle">
          {isLoadingReleases && releases.length === 0 ? (
            <div className="py-6 flex items-center justify-center text-text-tertiary">
              <Loader2 size={18} className="animate-spin" />
            </div>
          ) : releases.length === 0 ? (
            <div className="py-6 text-center text-sm text-text-tertiary">{t('appUpdate.noReleases')}</div>
          ) : (
            releases.map((release) => {
              const isCurrent = normalizeVersion(release.tagName) === normalizeVersion(currentVersion)
              return (
                <div key={release.tagName} className="py-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-medium text-text-primary">{release.tagName}</span>
                      {isCurrent && (
                        <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-success/10 text-success">
                          <CheckCircle2 size={11} />
                          {t('appUpdate.current')}
                        </span>
                      )}
                      {release.prerelease && (
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-warning/10 text-warning">
                          {t('appUpdate.prerelease')}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-text-tertiary mt-1">
                      {formatDate(release.publishedAt)}
                      {release.msiAsset && ` · ${release.msiAsset.name} ${formatBytes(release.msiAsset.size)}`}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {release.msiAsset && (
                      <ExternalLinkBtn
                        href={release.msiAsset.downloadUrl}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-background-hover"
                      >
                        <Download size={12} />
                        {isCurrent ? t('appUpdate.download') : t('appUpdate.downloadMsi')}
                      </ExternalLinkBtn>
                    )}
                    <ExternalLinkBtn
                      href={release.htmlUrl}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-background-hover"
                    >
                      <Download size={12} />
                      {t('appUpdate.openRelease')}
                    </ExternalLinkBtn>
                  </div>
                </div>
              )
            })
          )}
        </div>

        <div className="mt-4 p-3 rounded bg-warning/10 text-warning text-xs flex gap-2">
          <AlertTriangle size={15} className="shrink-0 mt-0.5" />
          <span>{t('appUpdate.rollbackWarning')}</span>
        </div>
      </div>
    </div>
  )
}

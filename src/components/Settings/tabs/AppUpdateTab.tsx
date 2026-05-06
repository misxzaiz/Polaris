import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, Download, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import { currentMode } from '@/services/transport'
import {
  checkAppUpdate,
  downloadInstallAndRelaunch,
  getCurrentAppVersion,
  listAppReleases,
  type AppRelease,
  type UpdateProgress,
} from '@/services/updateService'
import { useToastStore } from '@/stores/toastStore'

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

export function AppUpdateTab() {
  const { t } = useTranslation('settings')
  const toast = useToastStore()
  const [currentVersion, setCurrentVersion] = useState('unknown')
  const [latestVersion, setLatestVersion] = useState<string | null>(null)
  const [isChecking, setIsChecking] = useState(false)
  const [isInstalling, setIsInstalling] = useState(false)
  const [progress, setProgress] = useState<UpdateProgress | null>(null)
  const [availableUpdate, setAvailableUpdate] = useState<Awaited<ReturnType<typeof checkAppUpdate>>>(null)
  const [releases, setReleases] = useState<AppRelease[]>([])
  const [isLoadingReleases, setIsLoadingReleases] = useState(false)
  const [releaseError, setReleaseError] = useState<string | null>(null)

  const canUseUpdater = currentMode === 'tauri'
  const currentVersionNormalized = normalizeVersion(currentVersion)

  const progressPercent = useMemo(() => {
    if (!progress?.contentLength) return null
    return Math.min(100, Math.round((progress.downloaded / progress.contentLength) * 100))
  }, [progress])

  const loadReleases = useCallback(async () => {
    setIsLoadingReleases(true)
    setReleaseError(null)

    try {
      const result = await listAppReleases()
      setReleases(result)
      setLatestVersion(result[0]?.tagName ?? null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setReleaseError(message)
    } finally {
      setIsLoadingReleases(false)
    }
  }, [])

  useEffect(() => {
    getCurrentAppVersion()
      .then(setCurrentVersion)
      .catch(() => setCurrentVersion('unknown'))
    loadReleases()
  }, [loadReleases])

  const handleCheckUpdate = async () => {
    setIsChecking(true)
    setProgress(null)

    try {
      const update = await checkAppUpdate()
      setAvailableUpdate(update)

      if (update) {
        toast.info(t('appUpdate.updateAvailable'), t('appUpdate.updateAvailableDesc', { version: update.version }))
      } else {
        toast.success(t('appUpdate.upToDate'), t('appUpdate.upToDateDesc'))
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(t('appUpdate.checkFailed'), message)
    } finally {
      setIsChecking(false)
    }
  }

  const handleInstallUpdate = async () => {
    if (!availableUpdate) return

    setIsInstalling(true)
    setProgress(null)

    try {
      await downloadInstallAndRelaunch(availableUpdate, setProgress)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(t('appUpdate.installFailed'), message)
      setIsInstalling(false)
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
            <div className="text-xs text-text-tertiary">{t('appUpdate.latestRelease')}</div>
            <div className="text-base font-semibold text-text-primary mt-1">{latestVersion || '-'}</div>
          </div>
          <div className="p-3 rounded border border-border-subtle bg-background-surface">
            <div className="text-xs text-text-tertiary">{t('appUpdate.source')}</div>
            <div className="text-base font-semibold text-text-primary mt-1">GitHub Releases</div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 mt-4">
          <button
            type="button"
            onClick={handleCheckUpdate}
            disabled={!canUseUpdater || isChecking || isInstalling}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded bg-primary text-white hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isChecking ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {t('appUpdate.check')}
          </button>

          <button
            type="button"
            onClick={handleInstallUpdate}
            disabled={!availableUpdate || isInstalling}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded border border-border-subtle text-text-primary hover:bg-background-hover disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isInstalling ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            {t('appUpdate.installAndRestart')}
          </button>
        </div>

        {availableUpdate && (
          <div className="mt-4 p-3 rounded border border-primary/30 bg-primary/5 text-sm text-text-primary">
            <div className="font-medium">{t('appUpdate.availableVersion', { version: availableUpdate.version })}</div>
            {availableUpdate.body && <p className="text-xs text-text-secondary mt-1 whitespace-pre-wrap">{availableUpdate.body}</p>}
          </div>
        )}

        {progressPercent !== null && (
          <div className="mt-4">
            <div className="flex items-center justify-between text-xs text-text-tertiary mb-1">
              <span>{t('appUpdate.downloading')}</span>
              <span>{progressPercent}%</span>
            </div>
            <div className="h-2 rounded-full bg-background-hover overflow-hidden">
              <div className="h-full bg-primary transition-all" style={{ width: `${progressPercent}%` }} />
            </div>
          </div>
        )}
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
              const isCurrent = normalizeVersion(release.tagName) === currentVersionNormalized
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
                      <a
                        href={release.msiAsset.downloadUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-background-hover"
                      >
                        <Download size={12} />
                        {isCurrent ? t('appUpdate.download') : t('appUpdate.downloadMsi')}
                      </a>
                    )}
                    <a
                      href={release.htmlUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-background-hover"
                    >
                      <ExternalLink size={12} />
                      {t('appUpdate.openRelease')}
                    </a>
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

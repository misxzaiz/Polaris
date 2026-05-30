import { currentMode } from '@/services/transport'
import type { Update } from '@tauri-apps/plugin-updater'

const GITHUB_RELEASES_URL = 'https://api.github.com/repos/misxzaiz/Polaris/releases'

export interface AppReleaseAsset {
  name: string
  downloadUrl: string
  size: number
}

export interface AppRelease {
  tagName: string
  name: string
  body: string
  prerelease: boolean
  publishedAt: string
  htmlUrl: string
  msiAsset?: AppReleaseAsset
}

export interface UpdateProgress {
  downloaded: number
  contentLength?: number
}

export async function getCurrentAppVersion(): Promise<string> {
  if (currentMode !== 'tauri') {
    return 'unknown'
  }

  const { getVersion } = await import('@tauri-apps/api/app')
  return getVersion()
}

export async function checkAppUpdate(): Promise<Update | null> {
  if (currentMode !== 'tauri') {
    throw new Error('App updates are only available in the desktop app')
  }

  const { check } = await import('@tauri-apps/plugin-updater')
  return check()
}

export async function downloadInstallAndRelaunch(
  update: Update,
  onProgress?: (progress: UpdateProgress) => void,
): Promise<void> {
  let downloaded = 0
  let contentLength: number | undefined

  const { relaunch } = await import('@tauri-apps/plugin-process')

  await update.downloadAndInstall((event: unknown) => {
    const payload = event as {
      event?: string
      data?: { chunkLength?: number; contentLength?: number }
    }

    if (payload.event === 'Started') {
      downloaded = 0
      contentLength = payload.data?.contentLength
      onProgress?.({ downloaded, contentLength })
      return
    }

    if (payload.event === 'Progress') {
      downloaded += payload.data?.chunkLength ?? 0
      onProgress?.({ downloaded, contentLength })
      return
    }

    if (payload.event === 'Finished') {
      onProgress?.({ downloaded: contentLength ?? downloaded, contentLength })
    }
  })

  await relaunch()
}

export async function listAppReleases(): Promise<AppRelease[]> {
  const response = await fetch(GITHUB_RELEASES_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
    },
  })

  if (!response.ok) {
    throw new Error(`Failed to load GitHub releases: ${response.status}`)
  }

  const releases = await response.json()

  if (!Array.isArray(releases)) {
    return []
  }

  return releases
    .filter((release) => !release.draft)
    .map((release) => {
      const msiAsset = Array.isArray(release.assets)
        ? release.assets.find((asset: { name?: string }) => asset.name?.toLowerCase().endsWith('.msi'))
        : undefined

      return {
        tagName: release.tag_name,
        name: release.name || release.tag_name,
        body: release.body || '',
        prerelease: Boolean(release.prerelease),
        publishedAt: release.published_at || '',
        htmlUrl: release.html_url,
        msiAsset: msiAsset
          ? {
              name: msiAsset.name,
              downloadUrl: msiAsset.browser_download_url,
              size: msiAsset.size || 0,
            }
          : undefined,
      }
    })
}

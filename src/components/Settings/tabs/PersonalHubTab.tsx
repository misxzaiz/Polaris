/**
 * Personal Hub 内部插件配置 Tab
 *
 * - Supabase URL / anon key：用于登录注册与数据访问（依赖 RLS 行级隔离）
 * - 加密密钥：用于 links 表 description 字段的 AES 加解密
 *
 * 配置随设置页底部「保存」按钮落盘到 Rust config.json（0600 权限）。
 */
import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import { KeyRound, RefreshCw } from 'lucide-react'
import type { Config, PersonalHubConfig } from '@/types'
import { generateKey } from '@/services/personalHub/crypto'
import { DEFAULT_SUPABASE_URL, DEFAULT_SUPABASE_ANON_KEY } from '@/services/personalHub/supabase'
import { SetupGuide } from '@/components/PersonalHub/SetupGuide'

interface PersonalHubTabProps {
  config: Config
  onConfigChange: (config: Config) => void
  loading: boolean
}

const DEFAULT_PH: PersonalHubConfig = {
  supabaseUrl: '',
  supabaseAnonKey: '',
  encryptionKey: '',
}

export function PersonalHubTab({ config, onConfigChange, loading }: PersonalHubTabProps) {
  const { t } = useTranslation(['settings', 'common'])
  // 设置页只回显用户自定义值（原始值），不暴露内置默认 URL/key。
  // 用户留空即使用默认；填入则覆盖。
  const ph = config.personalHub ?? DEFAULT_PH
  const [showKey, setShowKey] = useState(false)

  const update = (patch: Partial<PersonalHubConfig>) => {
    onConfigChange({ ...config, personalHub: { ...ph, ...patch } })
  }

  // 预览默认配置前缀，让用户知道留空时用的是什么（不展示完整 key）
  const defaultUrlHost = (() => {
    try { return new URL(DEFAULT_SUPABASE_URL).host } catch { return '' }
  })()
  const defaultKeyPreview = DEFAULT_SUPABASE_ANON_KEY.slice(0, 12) + '...'

  return (
    <div className="space-y-6">
      {/* Supabase 配置 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-sm font-medium text-text-primary mb-1">
          {t('personalHub.supabaseTitle', 'Supabase 配置')}
        </h3>
        <p className="text-xs text-text-tertiary mb-4">
          {t('personalHub.supabaseDesc', '填写个人 Supabase 项目的 URL 与 anon key，用于登录注册与数据同步。anon key 公开，依赖 RLS 行级隔离保证数据安全。')}
        </p>

        <div className="mb-4">
          <label className="block text-xs text-text-secondary mb-2">
            {t('personalHub.supabaseUrl', 'Supabase URL')}
          </label>
          <input
            type="text"
            value={ph.supabaseUrl}
            onChange={(e) => update({ supabaseUrl: e.target.value })}
            placeholder={t('personalHub.supabaseUrlPlaceholder', '留空使用默认：{{host}}', { host: defaultUrlHost })}
            className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
            disabled={loading}
          />
        </div>

        <div>
          <label className="block text-xs text-text-secondary mb-2">
            {t('personalHub.supabaseAnonKey', 'Supabase Anon Key')}
          </label>
          <input
            type="password"
            value={ph.supabaseAnonKey}
            onChange={(e) => update({ supabaseAnonKey: e.target.value })}
            placeholder={t('personalHub.supabaseKeyPlaceholder', '留空使用默认：{{preview}}', { preview: defaultKeyPreview })}
            className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
            disabled={loading}
          />
        </div>
      </div>

      {/* 加密密钥 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-medium text-text-primary inline-flex items-center gap-1.5">
            <KeyRound size={14} />
            {t('personalHub.encryptionTitle', '加密密钥')}
          </h3>
        </div>
        <p className="text-xs text-text-tertiary mb-4">
          {t('personalHub.encryptionDesc', '用于 links 表 description 字段的 AES 加解密。密钥存储在本地配置文件，请妥善保管；丢失后将无法解密历史加密内容。建议使用足够长度的随机字符串。')}
        </p>

        <div className="flex items-center gap-2">
          <input
            type={showKey ? 'text' : 'password'}
            value={ph.encryptionKey}
            onChange={(e) => update({ encryptionKey: e.target.value })}
            placeholder={t('personalHub.encryptionPlaceholder', '输入或生成加密密钥')}
            className="flex-1 px-3 py-2 bg-background border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
            disabled={loading}
          />
          <button
            type="button"
            onClick={() => setShowKey((v) => !v)}
            className="px-3 py-2 text-xs border border-border rounded-lg text-text-secondary hover:bg-background-hover shrink-0"
          >
            {showKey ? t('personalHub.hide', '隐藏') : t('personalHub.show', '显示')}
          </button>
          <button
            type="button"
            onClick={() => update({ encryptionKey: generateKey() })}
            title={t('personalHub.generate', '生成随机密钥')}
            disabled={loading}
            className="inline-flex items-center gap-1 px-3 py-2 text-xs border border-border rounded-lg text-text-secondary hover:bg-background-hover shrink-0"
          >
            <RefreshCw size={12} />
            {t('personalHub.generate', '生成')}
          </button>
        </div>
      </div>

      {/* 使用说明 */}
      <div className="p-3 bg-primary/5 border border-primary/20 rounded-lg">
        <p className="text-xs text-text-primary font-medium">
          {t('personalHub.usageTitle', '使用说明')}
        </p>
        <ul className="mt-1 text-xs text-text-tertiary space-y-1 list-disc list-inside">
          <li>{t('personalHub.usage1', '填写 Supabase 配置后点击底部「保存」')}</li>
          <li>{t('personalHub.usage2', '在左侧 ActivityBar 点击「个人空间」图标登录')}</li>
          <li>{t('personalHub.usage3', '登录后可管理导航、书签与待办，并可选加密描述')}</li>
        </ul>
      </div>
    </div>
  )
}

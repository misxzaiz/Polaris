/**
 * 插件配置表单（按 manifest.contributes.configSchema 自动渲染）
 *
 * 设计参照 VSCode contributes.configuration：插件只声明 schema（纯数据），
 * 宿主据此自动渲染表单，无需插件自己写 UI。值存 config.json plugins[id] 命名空间。
 *
 * 使用场景：PluginTab 展开某插件时，若该插件声明了 configSchema，
 * 渲染此组件。保存走 setPluginConfig → 后端 plugin_set_config（权限校验）。
 */

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { PolarisPluginManifest, PluginConfigFieldSchema } from '@/plugin-system/types'
import { getPluginConfig, setPluginConfig } from '@/plugin-system/pluginConfig'
import { createLogger } from '@/utils/logger'

const log = createLogger('PluginConfigForm')

interface PluginConfigFormProps {
  manifest: PolarisPluginManifest
  /** 保存成功回调 */
  onSaved?: () => void
}

export function PluginConfigForm({ manifest, onSaved }: PluginConfigFormProps) {
  const { t } = useTranslation('settings')
  const schema = manifest.contributes.configSchema
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)

  const pluginId = manifest.id

  const loadConfig = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const config = await getPluginConfig(pluginId)
      // 合并 schema 默认值（未设置的字段用 default）
      const merged: Record<string, unknown> = {}
      for (const field of schema ?? []) {
        merged[field.key] = config[field.key] ?? field.default
      }
      setValues(merged)
      setDirty(false)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      log.error('加载插件配置失败', e instanceof Error ? e : new Error(msg), { pluginId })
    } finally {
      setLoading(false)
    }
  }, [pluginId, schema])

  useEffect(() => {
    if (schema?.length) {
      void loadConfig()
    } else {
      setLoading(false)
    }
  }, [schema, loadConfig])

  const handleChange = (key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }))
    setDirty(true)
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      await setPluginConfig(pluginId, values)
      setDirty(false)
      onSaved?.()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      log.error('保存插件配置失败', e instanceof Error ? e : new Error(msg), { pluginId })
    } finally {
      setSaving(false)
    }
  }

  if (!schema?.length) {
    return null
  }

  if (loading) {
    return <div className="p-3 text-xs text-text-tertiary">{t('common.loading')}</div>
  }

  return (
    <div className="space-y-2.5 px-2.5 pt-2 border-t border-border mt-2">
      <div className="text-[10px] font-medium text-text-secondary">
        {t('settings:plugin.configTitle', { name: manifest.name })}
      </div>
      {error && (
        <div className="text-[10px] text-error bg-error/10 px-2 py-1 rounded">{error}</div>
      )}
      {schema.map((field) => (
        <ConfigField
          key={field.key}
          field={field}
          value={values[field.key]}
          onChange={(v) => handleChange(field.key, v)}
          disabled={saving}
        />
      ))}
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={handleSave}
          disabled={!dirty || saving}
          className="px-2.5 py-1 text-[11px] bg-primary text-primary-content rounded hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
        >
          {saving ? t('common.saving') : t('common.save')}
        </button>
        {dirty && (
          <span className="text-[9px] text-warning bg-warning/10 px-1.5 py-0.5 rounded">
            {t('settings:plugin.unsavedChanges')}
          </span>
        )}
      </div>
    </div>
  )
}

/** 单个配置字段渲染器（按 type 分流） */
function ConfigField({
  field,
  value,
  onChange,
  disabled,
}: {
  field: PluginConfigFieldSchema
  value: unknown
  onChange: (v: unknown) => void
  disabled: boolean
}) {
  const label = field.label
  const help = field.help

  const inputClass =
    'w-full px-2 py-1.5 bg-background-surface border border-border rounded text-xs text-text-primary focus:outline-none focus:border-primary transition-colors disabled:opacity-50'

  const labelEl = (
    <label className="block text-[10px] text-text-tertiary mb-1">{label}</label>
  )
  const helpEl = help ? (
    <p className="mt-0.5 text-[9px] text-text-tertiary">{help}</p>
  ) : null

  switch (field.type) {
    case 'boolean':
      return (
        <div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={Boolean(value)}
              onChange={(e) => onChange(e.target.checked)}
              disabled={disabled}
              className="w-3.5 h-3.5"
            />
            <span className="text-[11px] text-text-primary">{label}</span>
          </div>
          {helpEl}
        </div>
      )
    case 'select':
      return (
        <div>
          {labelEl}
          <select
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            className={inputClass}
          >
            {field.options?.map((opt) => (
              <option key={String(opt.value)} value={String(opt.value)}>
                {opt.label}
              </option>
            ))}
          </select>
          {helpEl}
        </div>
      )
    case 'number':
      return (
        <div>
          {labelEl}
          <input
            type="number"
            value={Number(value ?? 0)}
            onChange={(e) => onChange(Number(e.target.value))}
            disabled={disabled}
            placeholder={field.placeholder}
            className={inputClass}
          />
          {helpEl}
        </div>
      )
    case 'secret':
      return (
        <div>
          {labelEl}
          <input
            type="password"
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            placeholder={field.placeholder ?? '••••••••'}
            className={inputClass}
          />
          {helpEl}
        </div>
      )
    case 'path':
      return (
        <div>
          {labelEl}
          <input
            type="text"
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            placeholder={field.placeholder ?? 'C:\\path\\to\\...'}
            className={`${inputClass} font-mono`}
          />
          {helpEl}
        </div>
      )
    case 'string':
    default:
      if (field.multiline) {
        return (
          <div>
            {labelEl}
            <textarea
              value={String(value ?? '')}
              onChange={(e) => onChange(e.target.value)}
              disabled={disabled}
              placeholder={field.placeholder}
              rows={3}
              className={`${inputClass} resize-y`}
            />
            {helpEl}
          </div>
        )
      }
      return (
        <div>
          {labelEl}
          <input
            type="text"
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            placeholder={field.placeholder}
            className={inputClass}
          />
          {helpEl}
        </div>
      )
  }
}

/**
 * Personal Hub 自定义 Supabase 配置教程
 *
 * 引导用户搭建自己的 Supabase 项目：创建项目 → 启用 Email 认证 → 执行建表 SQL
 * （含 links/comments 表、RLS 行级安全策略、索引、updated_at 触发器、note 类型扩展）
 * → 获取 URL 与 anon key → 填入上方配置。
 *
 * SQL 合并自 personal-hub 的 sql/init.sql + database/008_notes_feature.sql，
 * 一次性建表即可，无需分步迁移。
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Copy, Check, BookOpen, ExternalLink } from 'lucide-react'
import { copyToClipboard } from '@/utils/clipboard'

/** 建表 SQL（对齐 Polaris 实际读写字段，移除未用的 category/order_index/view_count/keywords 与 comments 表） */
const SETUP_SQL = `-- ========================================
-- Personal Hub 数据库初始化（Polaris 内部插件专用）
-- 在 Supabase Dashboard → SQL Editor 中整段执行
-- 字段对齐 Polaris 实际使用，幂等可重复执行
-- ========================================

-- 1. links 表（导航 / 书签 / 待办）
--    type 保留 note 以兼容类型定义；Polaris 当前仅写入 navigation/bookmark/todo
CREATE TABLE IF NOT EXISTS links (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  title       VARCHAR(255) NOT NULL,
  url         TEXT,
  description TEXT,
  icon        TEXT,
  type        VARCHAR(20) NOT NULL
              CHECK (type IN ('navigation', 'bookmark', 'todo', 'note')),
  tags        TEXT[] DEFAULT '{}',
  completed   BOOLEAN DEFAULT FALSE,
  priority    VARCHAR(20) DEFAULT 'medium'
              CHECK (priority IN ('low', 'medium', 'high')),
  due_date    TIMESTAMPTZ,
  is_encrypted BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 2. updated_at 自动维护触发器
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_links_updated_at ON links;
CREATE TRIGGER update_links_updated_at BEFORE UPDATE ON links
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 3. 索引：按 用户+类型 过滤、按创建时间排序（Polaris 列表查询主要路径）
CREATE INDEX IF NOT EXISTS idx_links_user_type ON links(user_id, type);
CREATE INDEX IF NOT EXISTS idx_links_created_at ON links(created_at DESC);

-- 4. 启用行级安全（RLS）
ALTER TABLE links ENABLE ROW LEVEL SECURITY;

-- 5. RLS 策略：每行仅归属用户可读写（auth.uid() = user_id）
CREATE POLICY "Users can view own links"   ON links FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own links" ON links FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own links" ON links FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own links" ON links FOR DELETE USING (auth.uid() = user_id);

-- 完成。anon key 配合上述 RLS 即可安全使用，无需 service_role key。
`

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation('settings')
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    await copyToClipboard(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-border text-text-secondary hover:bg-background-hover shrink-0"
    >
      {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
      {copied ? t('personalHub.copied', '已复制') : t('personalHub.copy', '复制')}
    </button>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2.5">
      <div className="shrink-0 w-5 h-5 rounded-full bg-primary/15 text-primary text-[11px] font-medium flex items-center justify-center mt-0.5">
        {n}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-text-primary mb-1">{title}</div>
        <div className="text-xs text-text-tertiary space-y-1.5">{children}</div>
      </div>
    </div>
  )
}

export function SetupGuide() {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(false)

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      {/* 折叠头 */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 bg-surface hover:bg-background-hover transition-colors"
      >
        <span className="inline-flex items-center gap-2 text-sm font-medium text-text-primary">
          <BookOpen size={14} />
          {t('personalHub.guideTitle', '自定义 Supabase 配置教程')}
        </span>
        <ChevronDown size={14} className={`text-text-secondary transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="px-4 py-4 space-y-5 border-t border-border">
          <p className="text-xs text-text-tertiary">
            {t('personalHub.guideIntro', '默认配置已预置一个公共示例项目。若要使用自己的 Supabase 项目（数据独立、可自定义），按以下步骤搭建：')}
          </p>

          {/* 步骤 1：创建项目 */}
          <Step n={1} title={t('personalHub.step1Title', '创建 Supabase 项目')}>
            <p>
              {t('personalHub.step1Desc', '访问 Supabase 官网注册并新建项目，记下区域与数据库密码。')}
            </p>
            <a
              href="https://supabase.com/dashboard"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              <ExternalLink size={10} /> supabase.com/dashboard
            </a>
          </Step>

          {/* 步骤 2：启用 Email 认证 */}
          <Step n={2} title={t('personalHub.step2Title', '启用 Email 认证')}>
            <p>
              {t('personalHub.step2Desc', '进入 Authentication → Providers → Email，确保已启用 Email/Password 登录。')}
            </p>
            <p>
              {t('personalHub.step2Note', '可选：开发阶段在 Authentication → Settings 关闭「Confirm email」，注册后即可直接登录。')}
            </p>
          </Step>

          {/* 步骤 3：执行建表 SQL */}
          <Step n={3} title={t('personalHub.step3Title', '执行建表 SQL')}>
            <p>
              {t('personalHub.step3Desc', '进入 SQL Editor → New query，粘贴下方脚本并运行。将创建 links 表、索引、updated_at 触发器与 RLS 行级安全策略。脚本幂等，可重复执行。')}
            </p>
            <div className="rounded-md border border-border bg-background overflow-hidden">
              <div className="flex items-center justify-between px-2 py-1 border-b border-border bg-surface">
                <span className="text-[10px] text-text-muted font-mono">setup.sql</span>
                <CopyButton text={SETUP_SQL} />
              </div>
              <pre className="p-2.5 text-[10px] leading-relaxed text-text-secondary overflow-x-auto max-h-64 font-mono">
                {SETUP_SQL}
              </pre>
            </div>
            <p className="text-[11px] text-text-muted">
              {t('personalHub.step3Note', '说明：RLS 策略限制每行只能被所属用户（auth.uid() = user_id）访问，anon key 配合 RLS 即可安全使用，无需暴露 service_role key。')}
            </p>
          </Step>

          {/* 步骤 4：获取 URL 与 anon key */}
          <Step n={4} title={t('personalHub.step4Title', '获取 Project URL 与 anon key')}>
            <p>
              {t('personalHub.step4Desc', '进入 Project Settings → API，复制「Project URL」与「anon public」密钥。')}
            </p>
          </Step>

          {/* 步骤 5：填入配置 */}
          <Step n={5} title={t('personalHub.step5Title', '填入上方配置并保存')}>
            <p>
              {t('personalHub.step5Desc', '将 URL 与 anon key 填入本页顶部输入框，点击底部「保存」。可选配置加密密钥以加密敏感描述。')}
            </p>
          </Step>

          {/* 安全提示 */}
          <div className="p-3 bg-warning/5 border border-warning/20 rounded-lg">
            <p className="text-xs text-text-primary font-medium">
              {t('personalHub.securityTitle', '安全说明')}
            </p>
            <ul className="mt-1 text-xs text-text-tertiary space-y-1 list-disc list-inside">
              <li>{t('personalHub.security1', 'anon key 是公开密钥，配合 RLS 行级安全策略使用，泄露不会导致越权。')}</li>
              <li>{t('personalHub.security2', '切勿在前端使用 service_role key，它会绕过所有 RLS。')}</li>
              <li>{t('personalHub.security3', '加密密钥仅存于本地配置文件，丢失后无法解密历史加密内容。')}</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}

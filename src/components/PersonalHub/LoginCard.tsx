/**
 * Personal Hub 登录/注册卡片
 * 移植自 personal-hub LoginView.vue（Tailwind 重写，弃用 Element Plus）
 */
import { useState } from 'react'
import { usePersonalHubAuthStore } from '@/stores/personalHubAuthStore'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function LoginCard() {
  const { signIn, signUp, loading } = usePersonalHubAuthStore()
  const [tab, setTab] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setInfo(null)

    if (!EMAIL_RE.test(email)) {
      setError('邮箱格式不正确')
      return
    }
    if (password.length < 6) {
      setError('密码长度至少 6 位')
      return
    }

    if (tab === 'register') {
      if (password !== confirmPassword) {
        setError('两次输入的密码不一致')
        return
      }
      const res = await signUp(email, password)
      if (res.success) {
        setInfo('注册成功，请查收邮件验证链接后登录')
        setTab('login')
      } else {
        setError(res.error ?? '注册失败')
      }
    } else {
      const res = await signIn(email, password)
      if (!res.success) {
        setError(res.error ?? '登录失败')
      }
    }
  }

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4">
        <div className="text-center">
          <h2 className="text-lg font-semibold text-text-primary">个人空间</h2>
          <p className="mt-1 text-xs text-text-tertiary">登录以同步你的导航、书签与待办</p>
        </div>

        {/* Tab 切换 */}
        <div className="flex rounded-lg bg-surface p-1">
          {(['login', 'register'] as const).map((t) => (
            <button
              key={t}
              onClick={() => { setTab(t); setError(null); setInfo(null) }}
              className={`flex-1 rounded-md py-1.5 text-xs font-medium transition-colors ${
                tab === t
                  ? 'bg-background-elevated text-text-primary shadow-sm'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {t === 'login' ? '登录' : '注册'}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-xs text-text-secondary mb-1.5">邮箱</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
              disabled={loading}
            />
          </div>
          <div>
            <label className="block text-xs text-text-secondary mb-1.5">密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="至少 6 位"
              autoComplete={tab === 'login' ? 'current-password' : 'new-password'}
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
              disabled={loading}
            />
          </div>
          {tab === 'register' && (
            <div>
              <label className="block text-xs text-text-secondary mb-1.5">确认密码</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="再次输入密码"
                autoComplete="new-password"
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                disabled={loading}
              />
            </div>
          )}

          {error && (
            <div className="rounded-md bg-danger/10 border border-danger/20 px-3 py-2 text-xs text-danger">
              {error}
            </div>
          )}
          {info && (
            <div className="rounded-md bg-success/10 border border-success/20 px-3 py-2 text-xs text-success">
              {info}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 text-sm font-medium text-white bg-primary rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? '处理中...' : tab === 'login' ? '登录' : '注册'}
          </button>
        </form>
      </div>
    </div>
  )
}

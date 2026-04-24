/**
 * Web 模式 Token 认证页面
 *
 * 当检测到 HTTP 模式且无有效 token 时渲染此页面。
 * 用户输入 token（和可选的服务器地址）后验证并进入主应用。
 */

import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

interface TokenAuthPageProps {
  defaultServerUrl: string;
  onAuthSuccess: (serverUrl: string, token: string) => void;
}

export function TokenAuthPage({ defaultServerUrl, onAuthSuccess }: TokenAuthPageProps) {
  const { t } = useTranslation('settings');
  const [serverUrl, setServerUrl] = useState(defaultServerUrl);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch(`${serverUrl}/api/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        setError((err as { error?: string }).error || t('web.auth.serverError', { status: res.status }));
        return;
      }

      const data = await res.json() as { valid?: boolean; token?: string };
      if (data.valid === false) {
        setError(t('web.auth.invalidToken'));
        return;
      }

      onAuthSuccess(serverUrl, token);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('web.auth.connectionFailed'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      backgroundColor: '#1a1b26',
      color: '#c0caf5',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    }}>
      <form
        onSubmit={handleSubmit}
        style={{
          width: '100%',
          maxWidth: 400,
          padding: 32,
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <h1 style={{ fontSize: 28, fontWeight: 600, color: '#7aa2f7', margin: '0 0 8px' }}>
            {t('web.auth.title')}
          </h1>
          <p style={{ fontSize: 14, color: '#565f89', margin: 0 }}>
            {t('web.auth.subtitle')}
          </p>
        </div>

        <label style={{ display: 'block', marginBottom: 16 }}>
          <span style={{ display: 'block', fontSize: 13, color: '#a9b1d6', marginBottom: 6 }}>
            {t('web.auth.serverUrl')}
          </span>
          <input
            type="url"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder={t('web.auth.serverUrlPlaceholder')}
            required
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '10px 12px',
              fontSize: 14,
              backgroundColor: '#24283b',
              color: '#c0caf5',
              border: '1px solid #3b4261',
              borderRadius: 6,
              outline: 'none',
            }}
          />
        </label>

        <label style={{ display: 'block', marginBottom: 24 }}>
          <span style={{ display: 'block', fontSize: 13, color: '#a9b1d6', marginBottom: 6 }}>
            {t('web.auth.token')}
          </span>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={t('web.auth.tokenPlaceholder')}
            required
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '10px 12px',
              fontSize: 14,
              backgroundColor: '#24283b',
              color: '#c0caf5',
              border: '1px solid #3b4261',
              borderRadius: 6,
              outline: 'none',
            }}
          />
        </label>

        {error && (
          <div style={{
            padding: '8px 12px',
            marginBottom: 16,
            fontSize: 13,
            color: '#f7768e',
            backgroundColor: 'rgba(247, 118, 142, 0.1)',
            borderRadius: 6,
          }}>
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !token || !serverUrl}
          style={{
            width: '100%',
            padding: '10px 0',
            fontSize: 14,
            fontWeight: 600,
            color: '#1a1b26',
            backgroundColor: (loading || !token || !serverUrl) ? '#3b4261' : '#7aa2f7',
            border: 'none',
            borderRadius: 6,
            cursor: (loading || !token || !serverUrl) ? 'not-allowed' : 'pointer',
            transition: 'background-color 0.2s',
          }}
        >
          {loading ? t('web.auth.connecting') : t('web.auth.connect')}
        </button>
      </form>
    </div>
  );
}

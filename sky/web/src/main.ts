/** Sky 前端入口 v2 — 无声界面 (Silent Interface) */

import './style.css';
import { SkyWs } from './api.ts';
import { wireEvents } from './ws.ts';
import { initRenderer, initTopbarHover } from './render/index.ts';
import { getState, setConnection, setAuth, notify } from './state.ts';
import { markTopbarDirty } from './render/index.ts';

async function boot() {
  const root = document.getElementById('app');
  if (!root) return;

  // 校验 token
  const token = getState().token;
  const r = await fetch('/api/auth/verify', {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }).then(r => r.json()).catch(() => null);
  if (r?.authRequired !== undefined) {
    setAuth(r.authRequired, r.authed ?? false);
    markTopbarDirty();
  }

  // 建立 WS
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${proto}//${location.host}/ws`;
  const ws = new SkyWs(wsUrl, token);
  wireEvents(ws);
  ws.onOpen = () => { setConnection(true); markTopbarDirty(); };
  ws.onClose = () => { setConnection(false); markTopbarDirty(); };
  ws.connect();

  // 渲染器(分区增量)
  initRenderer(ws, root);
  initTopbarHover();

  // 软键盘适配
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const onResize = () => {
      const composer = document.querySelector('.composer') as HTMLElement | null;
      if (!composer) return;
      const offset = window.innerHeight - vv.height - vv.offsetTop;
      composer.style.transform = `translateY(${-Math.max(offset, 0)}px)`;
    };
    vv.addEventListener('resize', onResize);
    vv.addEventListener('scroll', onResize);
  }
}

boot().catch(err => console.error('[sky] boot failed', err));

/**
 * 面板全屏切换信号脚本（页面加载前注入）
 *
 * 作用：捕获原生 WebView 内直达页面的 F11 / Esc 键盘事件（宿主 DOM 收不到），
 * 通过「标题通道」把切换信号转发给后端：
 *
 *   keydown(F11)  → preventDefault → 标题 `__POLARIS_FS__/f11` → 前端翻转全屏（进/出）
 *   keydown(Esc)  → 不 preventDefault（保留页面 Esc 语义）→ 标题 `__POLARIS_FS__/esc` → 前端仅在已全屏时退出
 *
 *   后端 on_document_title_changed 回调识别 `__POLARIS_FS__/` 前缀 →
 *   emit('browser://fullscreen-toggle', { label, action }) →
 *   前端 listen 根据 action 决定进入/退出全屏
 *
 * 特殊标记前缀 `__POLARIS_FS__/` 结尾为动作标识（f11/esc），
 * 后端据此只转发事件、不更新 session 标题（避免污染真实页面标题）。
 *
 * 幂等：window.__POLARIS_FS_HOOKED__ 防重复注入。
 */
(() => {
  if (window.__POLARIS_FS_HOOKED__) return;
  window.__POLARIS_FS_HOOKED__ = true;

  const TITLE_PREFIX = '__POLARIS_FS__';
  const F11_TITLE = TITLE_PREFIX + '/f11';
  const ESC_TITLE = TITLE_PREFIX + '/esc';

  /** 通过标题通道发送信号（避免与真实标题冲突：先改回原值再改标记） */
  function notify(actionTitle) {
    const prev = document.title;
    // 已经处于标记态（上一帧未还原）：用等长变体触发一次 change 事件
    if (prev === actionTitle) {
      document.title = TITLE_PREFIX + '/toggl1';
      document.title = actionTitle;
    } else {
      document.title = actionTitle;
    }
    // 复原计时器：2s 后还原为捕获时的标题（页面真实标题仍保留在 session）
    clearTimeout(window.__POLARIS_FS_TITLE_TIMER__);
    window.__POLARIS_FS_TITLE_TIMER__ = setTimeout(() => {
      if (document.title === actionTitle && prev && prev !== actionTitle) {
        document.title = prev;
      }
    }, 2000);
  }

  const handleKey = (e) => {
    if (e.key === 'F11') {
      // F11 拦截 WebView2 默认的浏览器级全屏行为，避免与面板全屏冲突
      e.preventDefault();
      e.stopPropagation();
      notify(F11_TITLE);
    } else if (e.key === 'Escape') {
      // Esc 不 preventDefault：保留页面自身 Esc 语义（关闭弹窗/退出视频等）
      // 仍然通知宿主：由前端决定「已全屏才退出，未全屏则忽略」
      notify(ESC_TITLE);
    }
  };

  // capture 阶段捕获，优先于页面自身监听（如视频站点全屏按键）
  window.addEventListener('keydown', handleKey, true);
})();

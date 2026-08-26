// 页面内媒体静音/取消静音控制
// 使用 MutationObserver 监听新加入的媒体元素，确保静音状态持久化

let __POLARIS_MUTED = typeof muteEnabled !== 'undefined' ? muteEnabled : false;

function applyMuteState(muted) {
  __POLARIS_MUTED = muted;
  document.querySelectorAll('video, audio').forEach((el) => {
    el.muted = muted;
  });
}

function setupMuteObserver() {
  const observer = new MutationObserver(() => {
    if (__POLARIS_MUTED) {
      document.querySelectorAll('video:not([muted]), audio:not([muted])').forEach((el) => {
        el.muted = true;
      });
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

if (document.body) {
  setupMuteObserver();
} else {
  document.addEventListener('DOMContentLoaded', setupMuteObserver);
}

applyMuteState(__POLARIS_MUTED);
return JSON.stringify({ muted: __POLARIS_MUTED });
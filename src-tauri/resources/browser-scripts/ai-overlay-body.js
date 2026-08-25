const existingCleanup = window.__POLARIS_AI_OVERLAY_CLEANUP__;
if (typeof existingCleanup === 'function') {
  existingCleanup();
}

if (!overlayEnabled) {
  return JSON.stringify({ enabled: false, count: 0 });
}

const root = document.createElement('div');
root.id = '__polaris_ai_overlay__';
root.style.position = 'fixed';
root.style.inset = '0';
root.style.pointerEvents = 'none';
root.style.zIndex = '2147483646';
root.style.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
document.documentElement.appendChild(root);

const render = () => {
  const entries = collectPolarisInteractiveElements({ viewportOnly: true, maxElements: 220 });
  const nodes = entries.map((entry, index) => {
    const rect = entry.rect;
    const box = document.createElement('div');
    box.style.position = 'fixed';
    box.style.left = `${Math.max(rect.left, 0)}px`;
    box.style.top = `${Math.max(rect.top, 0)}px`;
    box.style.width = `${Math.max(rect.width, 8)}px`;
    box.style.height = `${Math.max(rect.height, 8)}px`;
    box.style.border = entry.fillable ? '2px solid rgba(34, 197, 94, 0.95)' : '2px solid rgba(59, 130, 246, 0.95)';
    box.style.background = entry.fillable ? 'rgba(34, 197, 94, 0.10)' : 'rgba(59, 130, 246, 0.10)';
    box.style.borderRadius = '6px';
    box.style.boxSizing = 'border-box';
    box.style.boxShadow = '0 0 0 1px rgba(15, 23, 42, 0.35)';
    const badge = document.createElement('div');
    badge.textContent = String(index);
    badge.title = entry.label;
    badge.style.position = 'absolute';
    badge.style.left = '-1px';
    badge.style.top = '-18px';
    badge.style.minWidth = '18px';
    badge.style.height = '18px';
    badge.style.padding = '0 5px';
    badge.style.borderRadius = '5px';
    badge.style.background = entry.fillable ? 'rgb(22, 163, 74)' : 'rgb(37, 99, 235)';
    badge.style.color = 'white';
    badge.style.fontSize = '11px';
    badge.style.fontWeight = '650';
    badge.style.lineHeight = '18px';
    badge.style.textAlign = 'center';
    box.appendChild(badge);
    return box;
  });
  root.replaceChildren(...nodes);
  return entries.length;
};

let animationFrame = 0;
const scheduleRender = () => {
  if (animationFrame) {
    window.cancelAnimationFrame(animationFrame);
  }
  animationFrame = window.requestAnimationFrame(() => {
    animationFrame = 0;
    render();
  });
};
const cleanup = () => {
  if (animationFrame) {
    window.cancelAnimationFrame(animationFrame);
  }
  window.removeEventListener('scroll', scheduleRender, true);
  window.removeEventListener('resize', scheduleRender);
  root.remove();
  delete window.__POLARIS_AI_OVERLAY_CLEANUP__;
};
window.__POLARIS_AI_OVERLAY_CLEANUP__ = cleanup;
window.addEventListener('scroll', scheduleRender, true);
window.addEventListener('resize', scheduleRender);

const count = render();
return JSON.stringify({ enabled: true, count });
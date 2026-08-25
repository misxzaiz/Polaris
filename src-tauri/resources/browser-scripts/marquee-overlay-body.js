const existingCleanup = window.__POLARIS_MARQUEE_CLEANUP__;
if (typeof existingCleanup === 'function') {
  existingCleanup();
}

if (!marqueeEnabled) {
  return JSON.stringify({ enabled: false, count: 0 });
}

const MARQUEE_MIN_DIM = 20;

const root = document.createElement('div');
root.id = '__polaris_marquee_overlay__';
root.style.position = 'fixed';
root.style.inset = '0';
root.style.pointerEvents = 'auto';
root.style.zIndex = '2147483645';
root.style.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
document.documentElement.appendChild(root);

const savedOverflow = document.body.style.overflow;
document.body.style.overflow = 'hidden';

const currentRectangles = [];
let drawing = false;
let startX = 0, startY = 0;
let currentBox = null;

const addCompletedBox = (x, y, w, h) => {
  const num = currentRectangles.length + 1;
  const box = document.createElement('div');
  box.style.position = 'fixed';
  box.style.left = Math.max(0, x) + 'px';
  box.style.top = Math.max(0, y) + 'px';
  box.style.width = Math.max(MARQUEE_MIN_DIM, Math.abs(w)) + 'px';
  box.style.height = Math.max(MARQUEE_MIN_DIM, Math.abs(h)) + 'px';
  box.style.border = '2px solid rgba(59,130,246,0.95)';
  box.style.background = 'rgba(59,130,246,0.08)';
  box.style.boxShadow = '0 0 0 1px rgba(15,23,42,0.35)';
  box.style.borderRadius = '6px';
  box.style.boxSizing = 'border-box';
  box.style.pointerEvents = 'none';
  const badge = document.createElement('div');
  badge.textContent = String(num);
  badge.style.position = 'absolute';
  badge.style.left = '-1px';
  badge.style.top = '-14px';
  badge.style.minWidth = '22px';
  badge.style.height = '22px';
  badge.style.borderRadius = '11px';
  badge.style.background = 'rgb(37,99,235)';
  badge.style.color = 'white';
  badge.style.fontSize = '12px';
  badge.style.fontWeight = '650';
  badge.style.lineHeight = '22px';
  badge.style.textAlign = 'center';
  box.appendChild(badge);
  root.appendChild(box);
  currentRectangles.push({ x: Math.max(0, x), y: Math.max(0, y), width: Math.max(MARQUEE_MIN_DIM, Math.abs(w)), height: Math.max(MARQUEE_MIN_DIM, Math.abs(h)) });
};

const updateResult = (done) => {
  window.__POLARIS_MARQUEE_RESULT__ = JSON.stringify({
    rects: currentRectangles,
    done: !!done
  });
};

const onMousedown = (e) => {
  if (e.button !== 0) return;
  drawing = true;
  startX = e.clientX;
  startY = e.clientY;
  currentBox = document.createElement('div');
  currentBox.style.position = 'fixed';
  currentBox.style.pointerEvents = 'none';
  currentBox.style.border = '2px dashed rgba(59,130,246,0.95)';
  currentBox.style.background = 'rgba(59,130,246,0.12)';
  currentBox.style.boxShadow = '0 0 0 1px rgba(15,23,42,0.35)';
  currentBox.style.borderRadius = '6px';
  currentBox.style.boxSizing = 'border-box';
  root.appendChild(currentBox);
  e.preventDefault();
};
const onMousemove = (e) => {
  if (!drawing || !currentBox) return;
  const x = Math.min(startX, e.clientX);
  const y = Math.min(startY, e.clientY);
  const w = Math.abs(e.clientX - startX);
  const h = Math.abs(e.clientY - startY);
  currentBox.style.left = Math.max(0, x) + 'px';
  currentBox.style.top = Math.max(0, y) + 'px';
  currentBox.style.width = Math.max(MARQUEE_MIN_DIM, w) + 'px';
  currentBox.style.height = Math.max(MARQUEE_MIN_DIM, h) + 'px';
};
const onMouseup = (e) => {
  if (!drawing) return;
  drawing = false;
  if (currentBox) {
    currentBox.remove();
    currentBox = null;
  }
  const w = Math.abs(e.clientX - startX);
  const h = Math.abs(e.clientY - startY);
  if (w >= MARQUEE_MIN_DIM && h >= MARQUEE_MIN_DIM) {
    addCompletedBox(Math.min(startX, e.clientX), Math.min(startY, e.clientY), w, h);
  }
  updateResult(false);
};
const onDblclick = () => {
  if (drawing && currentBox) { currentBox.remove(); currentBox = null; drawing = false; }
  updateResult(true);
};
const onKeydown = (e) => {
  if (e.key === 'Escape') {
    if (drawing && currentBox) { currentBox.remove(); currentBox = null; drawing = false; }
    updateResult(true);
  }
};

root.addEventListener('mousedown', onMousedown, true);
document.addEventListener('mousemove', onMousemove, true);
document.addEventListener('mouseup', onMouseup, true);
document.addEventListener('dblclick', onDblclick, true);
document.addEventListener('keydown', onKeydown, true);

window.__POLARIS_MARQUEE_CLEANUP__ = () => {
  root.removeEventListener('mousedown', onMousedown, true);
  document.removeEventListener('mousemove', onMousemove, true);
  document.removeEventListener('mouseup', onMouseup, true);
  document.removeEventListener('dblclick', onDblclick, true);
  document.removeEventListener('keydown', onKeydown, true);
  root.remove();
  document.body.style.overflow = savedOverflow;
  delete window.__POLARIS_MARQUEE_CLEANUP__;
  delete window.__POLARIS_MARQUEE_RESULT__;
};

return JSON.stringify({ enabled: true, count: 0 });
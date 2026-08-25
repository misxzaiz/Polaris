const targetRect = { x: targetX, y: targetY, w: targetW, h: targetH };
const intersects = (rx, ry, rw, rh) => !(
  rx + rw < targetRect.x ||
  ry + rh < targetRect.y ||
  rx > targetRect.x + targetRect.w ||
  ry > targetRect.y + targetRect.h
);
const entries = collectPolarisInteractiveElements({ viewportOnly: false, maxElements: 300 });
const inRegion = entries.filter((e) => {
  if (!e.rect) return false;
  return intersects(e.rect.left, e.rect.top, e.rect.width, e.rect.height);
});
const elements = inRegion.map((e, i) => ({
  index: i,
  kind: e.kind,
  text: clean(e.label, 240),
  rect: { x: Math.round(e.rect.left), y: Math.round(e.rect.top), width: Math.round(e.rect.width), height: Math.round(e.rect.height) },
  fillable: e.fillable,
  disabled: e.disabled,
  selector: e.selector || null
}));
let htmlSnippet = '';
let textSnippet = '';
try {
  const step = 10;
  const collected = new Set();
  const candidates = [];
  const POLARIS_OVERLAY_IDS = new Set([
    '__polaris_marquee_overlay__',
    '__polaris_ai_overlay__',
  ]);
  for (let px = targetRect.x; px < targetRect.x + targetRect.w; px += step) {
    for (let py = targetRect.y; py < targetRect.y + targetRect.h; py += step) {
      const el = document.elementFromPoint(px, py);
      if (!el || el === document.body || el === document.documentElement) continue;
      if (el.id && POLARIS_OVERLAY_IDS.has(el.id)) continue;
      let skip = false;
      let n = el.parentElement;
      while (n && !skip) {
        if (n.id && POLARIS_OVERLAY_IDS.has(n.id)) skip = true;
        n = n.parentElement;
      }
      if (skip) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        collected.add(el);
        candidates.push(el);
      }
    }
  }
  candidates.sort((a, b) => {
    if (a === b) return 0;
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
  const deduped = [];
  for (const el of candidates) {
    const isChildOfKept = deduped.some((kept) => kept.contains(el));
    if (!isChildOfKept) deduped.push(el);
  }
  const htmlParts = [];
  const textParts = [];
  for (const el of deduped.slice(0, 30)) {
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript') continue;
    const html = clean(el.outerHTML, 2000);
    if (html) htmlParts.push(html);
    const text = clean(el.innerText || el.textContent || '', 1000);
    if (text) textParts.push(text);
  }
  htmlSnippet = htmlParts.join('\n').slice(0, 6000);
  textSnippet = textParts.join('\n').slice(0, 3000);
} catch {}
return JSON.stringify({
  count: inRegion.length,
  elements: elements.slice(0, 120),
  htmlSnippet: htmlSnippet,
  textSnippet: textSnippet,
  url: String(location.href)
});
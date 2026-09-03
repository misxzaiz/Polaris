/**
 * 悬停 body：对目标元素派发完整 mouse 事件序列（mouseover/mouseenter/mousemove），
 * 触发 hover 样式与 tooltip。依赖 collector。
 */
const entries = collectPolarisInteractiveElements({ viewportOnly: false, maxElements: 300 });
const query = clean(requestedText, 240).toLowerCase();
let index = Number.isInteger(requestedIndex) ? requestedIndex : -1;
let entry = index >= 0 ? entries[index] : null;
if (!entry && query) {
  index = entries.findIndex((item) => item.searchText.includes(query));
  entry = index >= 0 ? entries[index] : null;
}
if (!entry) {
  return JSON.stringify({ ok: false, action: 'hover', index: null, text: requestedText || '', url: String(location.href), message: '未找到目标元素' });
}
const target = entry.element;
try {
  target.scrollIntoView({ block: 'center', inline: 'center' });
  const view = ownerWindowOf(target);
  const rect = target.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const opts = { bubbles: true, cancelable: true, view, clientX: cx, clientY: cy, composed: true };
  target.dispatchEvent(new view.PointerEvent('pointerover', { ...opts, pointerType: 'mouse' }));
  target.dispatchEvent(new view.MouseEvent('mouseover', opts));
  target.dispatchEvent(new view.MouseEvent('mouseenter', { ...opts, bubbles: false }));
  target.dispatchEvent(new view.PointerEvent('pointermove', { ...opts, pointerType: 'mouse' }));
  target.dispatchEvent(new view.MouseEvent('mousemove', opts));
  return JSON.stringify({ ok: true, action: 'hover', index, text: entry.label, url: String(location.href), message: '已悬停目标元素' });
} catch (e) {
  return JSON.stringify({ ok: false, action: 'hover', index, text: entry.label, url: String(location.href), message: '悬停失败: ' + (e && e.message) });
}

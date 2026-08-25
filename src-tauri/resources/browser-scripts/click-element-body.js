const entries = collectPolarisInteractiveElements({ viewportOnly: false, maxElements: 300 });
const query = clean(requestedText, 240).toLowerCase();
let index = Number.isInteger(requestedIndex) ? requestedIndex : -1;
let entry = index >= 0 ? entries[index] : null;
if (!entry && query) {
  index = entries.findIndex((item) => item.searchText.includes(query));
  entry = index >= 0 ? entries[index] : null;
}
if (!entry) {
  return JSON.stringify({ ok: false, action: 'click', index: null, text: requestedText || '', url: String(location.href), message: '未找到可点击元素' });
}
if (entry.disabled) {
  return JSON.stringify({ ok: false, action: 'click', index, text: entry.label, url: String(location.href), message: '目标元素已禁用' });
}
const target = entry.element;
for (const frame of entry.frames || []) {
  try { frame.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
}
target.scrollIntoView({ block: 'center', inline: 'center' });
if (tagOf(target) === 'a') {
  target.setAttribute('target', '_self');
}
try { target.focus({ preventScroll: true }); } catch {}
const view = ownerWindowOf(target);
const targetRect = target.getBoundingClientRect();
const clientX = targetRect.left + Math.max(1, Math.min(targetRect.width / 2, targetRect.width - 1));
const clientY = targetRect.top + Math.max(1, Math.min(targetRect.height / 2, targetRect.height - 1));
const dispatchMouse = (type) => {
  try {
    target.dispatchEvent(new view.MouseEvent(type, { bubbles: true, cancelable: true, view, clientX, clientY, button: 0, buttons: type === 'mouseup' ? 0 : 1 }));
  } catch {}
};
const dispatchPointer = (type) => {
  try {
    if (view.PointerEvent) {
      target.dispatchEvent(new view.PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'mouse', clientX, clientY, button: 0, buttons: type === 'pointerup' ? 0 : 1, view }));
    }
  } catch {}
};
dispatchPointer('pointerover');
dispatchMouse('mouseover');
dispatchMouse('mouseenter');
dispatchPointer('pointerdown');
dispatchMouse('mousedown');
dispatchPointer('pointerup');
dispatchMouse('mouseup');
if (typeof target.click === 'function') {
  target.click();
} else {
  dispatchMouse('click');
}
return JSON.stringify({ ok: true, action: 'click', index, text: entry.label, url: String(location.href), message: '已点击目标元素' });
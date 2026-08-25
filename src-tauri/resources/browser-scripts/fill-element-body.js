const entries = collectPolarisInteractiveElements({ viewportOnly: false, maxElements: 300 });
const query = clean(requestedText, 240).toLowerCase();
let index = Number.isInteger(requestedIndex) ? requestedIndex : -1;
let entry = index >= 0 ? entries[index] : null;
if (!entry && query) {
  index = entries.findIndex((item) => item.searchText.includes(query));
  entry = index >= 0 ? entries[index] : null;
}
if (!entry) {
  return JSON.stringify({ ok: false, action: 'fill', index: null, text: requestedText || '', url: String(location.href), message: '未找到可输入元素' });
}
const target = entry.element;
if (!entry.fillable) {
  return JSON.stringify({ ok: false, action: 'fill', index, text: entry.label, url: String(location.href), message: '目标元素不可输入' });
}
if (entry.disabled) {
  return JSON.stringify({ ok: false, action: 'fill', index, text: entry.label, url: String(location.href), message: '目标元素不可输入' });
}
const setNativeValue = (element, value) => {
  const view = ownerWindowOf(element);
  const prototype = element instanceof view.HTMLTextAreaElement
    ? view.HTMLTextAreaElement.prototype
    : element instanceof view.HTMLSelectElement
      ? view.HTMLSelectElement.prototype
      : view.HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  if (descriptor && descriptor.set) {
    descriptor.set.call(element, value);
  } else {
    element.value = value;
  }
};
for (const frame of entry.frames || []) {
  try { frame.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
}
target.scrollIntoView({ block: 'center', inline: 'center' });
try { target.focus({ preventScroll: true }); } catch {}
if (target.isContentEditable) {
  target.textContent = fillValue;
} else if (tagOf(target) === 'select') {
  const findOption = (el, val) => {
    const opts = Array.from(el.options);
    const clean = (v, max = 220) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
    let match = opts.find(o => o.value === val);
    if (match) return match;
    match = opts.find(o => clean(o.textContent) === val);
    if (match) return match;
    const textMatches = opts.map(o => ({ option: o, text: clean(o.textContent) }))
      .filter(({ text }) => text.startsWith(val) || text.includes(` ${val}`) || text.includes(val));
    textMatches.sort((a, b) => b.text.length - a.text.length);
    if (textMatches.length > 0) return textMatches[0].option;
    match = opts.find(o => clean(o.textContent).includes(val));
    return match || null;
  };
  if (target.multiple) {
    Array.from(target.options).forEach(o => o.selected = false);
    const selectedValues = fillValue.split(',').map(v => v.trim()).filter(Boolean);
    for (const val of selectedValues) {
      const opt = findOption(target, val);
      if (opt) opt.selected = true;
    }
    setNativeValue(target, Array.from(target.selectedOptions).map(o => o.value).join(','));
  } else {
    const option = findOption(target, fillValue);
    setNativeValue(target, option ? option.value : fillValue);
  }
} else if ('value' in target) {
  setNativeValue(target, fillValue);
} else {
  target.textContent = fillValue;
}
const view = ownerWindowOf(target);
target.dispatchEvent(new view.Event('input', { bubbles: true }));
target.dispatchEvent(new view.Event('change', { bubbles: true }));
return JSON.stringify({ ok: true, action: 'fill', index, text: entry.label, url: String(location.href), message: '已填写目标元素' });
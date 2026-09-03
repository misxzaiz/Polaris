/**
 * 批量填表 body：从 window.__POLARIS_FILL_FORM_ITEMS__ 读取 [{index?, text?, value}]，
 * 逐项定位并填充，返回每项结果与汇总。依赖 collector（含 clean / ownerWindowOf / tagOf）。
 */
const items = Array.isArray(window.__POLARIS_FILL_FORM_ITEMS__) ? window.__POLARIS_FILL_FORM_ITEMS__ : [];
delete window.__POLARIS_FILL_FORM_ITEMS__;

const fillOne = (item, allEntries) => {
  const reqIndex = Number.isInteger(item.index) ? item.index : -1;
  const reqText = clean(item.text || '', 240).toLowerCase();
  const fillValue = item.value == null ? '' : String(item.value);
  let index = reqIndex;
  let entry = reqIndex >= 0 ? allEntries[reqIndex] : null;
  if (!entry && reqText) {
    index = allEntries.findIndex((e) => e.searchText.includes(reqText));
    entry = index >= 0 ? allEntries[index] : null;
  }
  if (!entry) {
    return { ok: false, index: reqIndex >= 0 ? reqIndex : null, text: item.text || '', message: '未找到可输入元素' };
  }
  const target = entry.element;
  if (!entry.fillable) {
    return { ok: false, index, text: entry.label, message: '目标元素不可输入' };
  }
  if (entry.disabled) {
    return { ok: false, index, text: entry.label, message: '目标元素已禁用' };
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
  try {
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
        let match = opts.find(o => o.value === val);
        if (match) return match;
        match = opts.find(o => clean(o.textContent) === val);
        if (match) return match;
        return opts.find(o => clean(o.textContent).includes(val)) || null;
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
    return { ok: true, index, text: entry.label, message: '已填写' };
  } catch (e) {
    return { ok: false, index, text: entry.label, message: '填写失败: ' + (e && e.message) };
  }
};

const entries = collectPolarisInteractiveElements({ viewportOnly: false, maxElements: 300 });
const results = items.map((item) => fillOne(item, entries));
const filled = results.filter((r) => r.ok).length;
return JSON.stringify({
  ok: filled === items.length,
  total: items.length,
  filled,
  results,
  url: String(location.href),
  message: `已填写 ${filled}/${items.length} 个字段`,
});

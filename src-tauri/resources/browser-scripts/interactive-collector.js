/**
 * Polaris 内置浏览器交互元素收集器
 * 被多个脚本复用（页面上下文/诊断/点击/输入/高亮等）
 * 注入到 Tauri WebView 中执行
 */
const POLARIS_INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'textarea',
  'select',
  'summary',
  'area[href]',
  'label[for]',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="tab"]',
  '[role="option"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="combobox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[aria-pressed]',
  '[aria-selected]',
  '[aria-checked]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
  '[onclick]',
  '[jsaction]',
  '[aria-haspopup]',
  '[aria-expanded]',
  '[aria-controls]',
  '[popovertarget]',
  '[commandfor]',
  '[data-action]',
  '[data-click]',
  '[data-command]',
  '[data-href]',
  '[data-url]',
  '[data-route]'
].join(',');

const POLARIS_CLICKABLE_ROLES = new Set([
  'button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'option', 'checkbox', 'radio', 'switch', 'combobox',
  'listbox', 'treeitem', 'gridcell', 'slider', 'spinbutton'
]);
const POLARIS_FILLABLE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider']);
const POLARIS_SCAN_LIMIT = 8000;
const POLARIS_SHADOW_MAX_DEPTH = 5;

const clean = (value, max = 220) => String(value || '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

const ownerWindowOf = (element) => element?.ownerDocument?.defaultView || window;

const styleCache = new WeakMap();
const styleOf = (element) => {
  if (styleCache.has(element)) return styleCache.get(element);
  const style = ownerWindowOf(element).getComputedStyle(element);
  styleCache.set(element, style);
  return style;
};
const tagOf = (element) => String(element?.tagName || '').toLowerCase();
const roleOf = (element) => clean(element.getAttribute('role') || '', 80).toLowerCase();
const isElement = (value) => value && value.nodeType === 1;
const cssEscape = (value) => window.CSS?.escape
  ? window.CSS.escape(String(value))
  : String(value).replace(/["\\]/g, '\\$&');

const ariaLabelledByText = (element) => {
  const doc = element.ownerDocument || document;
  const ids = clean(element.getAttribute('aria-labelledby') || '', 500).split(' ').filter(Boolean);
  return clean(ids.map((id) => doc.getElementById(id)?.textContent || '').join(' '), 240);
};

const associatedLabelText = (element) => {
  const doc = element.ownerDocument || document;
  const id = element.getAttribute('id');
  let explicit = '';
  if (id) {
    try {
      explicit = Array.from(doc.querySelectorAll(`label[for="${cssEscape(id)}"]`)).map((label) => label.innerText || label.textContent || '').join(' ');
    } catch {}
  }
  const implicit = element.closest?.('label')?.innerText || '';
  return clean(`${explicit} ${implicit}`, 240);
};

const descriptorOf = (element) => {
  const tag = tagOf(element) || 'element';
  const id = clean(element.getAttribute('id') || '', 80);
  const name = clean(element.getAttribute('name') || '', 80);
  const testId = clean(
    element.getAttribute('data-testid')
      || element.getAttribute('data-test')
      || element.getAttribute('data-cy')
      || '',
    100
  );
  const className = clean(String(element.getAttribute('class') || '').split(/\s+/).slice(0, 2).join('.'), 80);
  return clean([
    tag,
    id ? `#${id}` : '',
    name ? `[name=${name}]` : '',
    testId ? `[testid=${testId}]` : '',
    !id && !name && !testId && className ? `.${className}` : ''
  ].filter(Boolean).join(''), 160);
};

const textAlternativeOf = (element) => {
  const svgTitle = element.querySelector?.('svg title, title')?.textContent || '';
  const labelled = ariaLabelledByText(element);
  const associated = associatedLabelText(element);
  return clean(
    element.innerText
      || element.value
      || element.getAttribute('aria-label')
      || labelled
      || associated
      || element.getAttribute('alt')
      || element.getAttribute('title')
      || element.getAttribute('placeholder')
      || svgTitle
      || element.getAttribute('data-label')
      || element.getAttribute('data-testid')
      || element.getAttribute('data-test')
      || element.getAttribute('data-cy')
      || element.getAttribute('name')
      || element.getAttribute('id')
      || element.href
      || '',
    240
  );
};

const labelOf = (element) => textAlternativeOf(element) || descriptorOf(element);

const kindOf = (element) => {
  const tag = tagOf(element);
  const role = roleOf(element);
  const type = clean(element.getAttribute('type') || '', 40).toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'area') return 'link';
  if (tag === 'input') return type ? `input:${type}` : 'input';
  if (tag === 'textarea') return 'textarea';
  if (tag === 'select') return 'select';
  if (tag === 'button') return 'button';
  if (tag === 'summary') return 'summary';
  if (tag === 'label' && element.hasAttribute('for')) return 'label';
  if (role) return role;
  if (element.isContentEditable) return 'editable';
  return tag || 'element';
};

const isNativeInteractive = (element) => {
  const tag = tagOf(element);
  return tag === 'a' && element.hasAttribute('href')
    || tag === 'area' && element.hasAttribute('href')
    || tag === 'button'
    || tag === 'textarea'
    || tag === 'select'
    || tag === 'summary'
    || (tag === 'label' && element.hasAttribute('for'))
    || (tag === 'input' && (element.getAttribute('type') || '').toLowerCase() !== 'hidden');
};

const isFillable = (element) => {
  const tag = tagOf(element);
  const role = roleOf(element);
  const type = clean(element.getAttribute('type') || '', 40).toLowerCase();
  const nonTextInputTypes = ['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'hidden', 'range', 'color'];
  return element.isContentEditable
    || tag === 'textarea'
    || tag === 'select'
    || POLARIS_FILLABLE_ROLES.has(role)
    || (tag === 'input' && !nonTextInputTypes.includes(type));
};

const isReadOnly = (element) => Boolean(
  element.readOnly || element.getAttribute('aria-readonly') === 'true'
);

const isDisabled = (element) => Boolean(
  element.disabled
    || element.closest?.('[disabled], [aria-disabled="true"], [inert]')
    || element.getAttribute('aria-disabled') === 'true'
);

const hasInteractiveAttribute = (element) => {
  const names = typeof element.getAttributeNames === 'function'
    ? element.getAttributeNames().map((name) => name.toLowerCase())
    : [];
  return Boolean(
    element.hasAttribute('onclick')
      || typeof element.onclick === 'function'
      || element.hasAttribute('jsaction')
      || element.hasAttribute('aria-haspopup')
      || element.hasAttribute('aria-expanded')
      || element.hasAttribute('aria-controls')
      || element.hasAttribute('aria-pressed')
      || element.hasAttribute('aria-selected')
      || element.hasAttribute('aria-checked')
      || element.hasAttribute('popovertarget')
      || element.hasAttribute('commandfor')
      || element.hasAttribute('data-action')
      || element.hasAttribute('data-click')
      || element.hasAttribute('data-command')
      || element.hasAttribute('data-href')
      || element.hasAttribute('data-url')
      || element.hasAttribute('data-route')
      || names.some((name) => [
        'ng-click',
        'x-on:click',
        'v-on:click',
        '@click',
        'wire:click',
        'data-bs-toggle',
        'data-toggle',
        'hx-get',
        'hx-post'
      ].includes(name))
  );
};

const rectOf = (element, offset) => {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left + offset.x,
    top: rect.top + offset.y,
    right: rect.right + offset.x,
    bottom: rect.bottom + offset.y,
    width: rect.width,
    height: rect.height
  };
};

const intersectsViewport = (rect) => rect.bottom >= 0
  && rect.right >= 0
  && rect.top <= window.innerHeight
  && rect.left <= window.innerWidth;

const isVisible = (element, offset, viewportOnly) => {
  if (!isElement(element)) return false;
  const tag = tagOf(element);
  if (['html', 'body', 'head', 'script', 'style', 'meta', 'link', 'noscript', 'template'].includes(tag)) {
    return false;
  }
  const style = styleOf(element);
  const rect = rectOf(element, offset);
  return rect.width > 0
    && rect.height > 0
    && (!viewportOnly || intersectsViewport(rect))
    && style.visibility !== 'hidden'
    && style.visibility !== 'collapse'
    && style.display !== 'none'
    && Number(style.opacity || '1') > 0.01
    && element.getAttribute('aria-hidden') !== 'true'
    && !element.closest?.('[hidden], [aria-hidden="true"]');
};

const looksInteractive = (element) => {
  const role = roleOf(element);
  const style = styleOf(element);
  return isNativeInteractive(element)
    || element.isContentEditable
    || POLARIS_CLICKABLE_ROLES.has(role)
    || POLARIS_FILLABLE_ROLES.has(role)
    || element.matches?.('[tabindex]:not([tabindex="-1"])')
    || hasInteractiveAttribute(element)
    || style.cursor === 'pointer';
};

const scoreOf = (element) => {
  const role = roleOf(element);
  const style = styleOf(element);
  let score = 0;
  if (isNativeInteractive(element)) score += 80;
  if (POLARIS_CLICKABLE_ROLES.has(role) || POLARIS_FILLABLE_ROLES.has(role)) score += 70;
  if (element.isContentEditable) score += 65;
  if (element.matches?.('[tabindex]:not([tabindex="-1"])')) score += 45;
  if (hasInteractiveAttribute(element)) score += 35;
  if (style.cursor === 'pointer') score += 25;
  if (textAlternativeOf(element)) score += 8;
  return score;
};

const buildSearchText = (element, label) => clean([
  label,
  element.value,
  element.getAttribute('placeholder'),
  element.getAttribute('aria-label'),
  ariaLabelledByText(element),
  associatedLabelText(element),
  element.getAttribute('title'),
  element.getAttribute('alt'),
  element.getAttribute('name'),
  element.getAttribute('id'),
  element.getAttribute('data-testid'),
  element.getAttribute('data-test'),
  element.getAttribute('data-cy'),
  element.href
].filter(Boolean).join(' '), 800).toLowerCase();

const collectRoots = () => {
  const roots = [];
  const visit = (root, offset, depth, frames) => {
    if (!root || depth > POLARIS_SHADOW_MAX_DEPTH) return;
    roots.push({ root, offset, frames });
    let nodes = [];
    try {
      nodes = Array.from(root.querySelectorAll('*')).slice(0, POLARIS_SCAN_LIMIT);
    } catch {
      return;
    }
    for (const node of nodes) {
      if (node.shadowRoot) {
        visit(node.shadowRoot, offset, depth + 1, frames);
      }
      if (tagOf(node) === 'iframe') {
        try {
          const doc = node.contentDocument;
          if (doc) {
            const frameRect = node.getBoundingClientRect();
            visit(doc, { x: offset.x + frameRect.left, y: offset.y + frameRect.top }, depth + 1, frames.concat(node));
          }
        } catch {
          // 跨域 iframe，无法访问 contentDocument
          const frameRect = node.getBoundingClientRect();
          if (frameRect.width > 0 && frameRect.height > 0) {
            candidates.push({
              element: node,
              rect: { ...frameRect, left: frameRect.left + offset.x, top: frameRect.top + offset.y },
              label: `[跨域隔离] ${node.src || node.getAttribute('srcdoc') || 'iframe'}`,
              searchText: `[cross-origin iframe] ${node.src || ''}`.toLowerCase(),
              kind: 'cross-origin-iframe',
              value: '',
              placeholder: '',
              href: node.src || '',
              disabled: false,
              fillable: false,
              frames: [],
              score: 0,
              order: order++,
              crossOrigin: true,
            });
          }
        }
      }
    }
  };
  visit(document, { x: 0, y: 0 }, 0, []);
  return roots;
};

const buildStableSelector = (element) => {
  if (!isElement(element)) return '';
  const id = clean(element.getAttribute('id') || '', 80);
  if (id) return `#${cssEscape(id)}`;
  const name = clean(element.getAttribute('name') || '', 80);
  if (name && tagOf(element) === 'input') return `${tagOf(element)}[name="${cssEscape(name)}"]`;
  const testId = clean(element.getAttribute('data-testid') || element.getAttribute('data-test') || element.getAttribute('data-cy') || '', 80);
  if (testId) return `[data-testid="${cssEscape(testId)}"]`;
  const tag = tagOf(element) || 'element';
  let parent = element.parentElement;
  let path = tag;
  while (parent && parent !== document.body && parent !== document.documentElement) {
    const parentTag = tagOf(parent) || 'element';
    const parentIndex = Array.from(parent.children).indexOf(element);
    path = `${parentTag}${parentIndex >= 0 ? `:nth-child(${parentIndex + 1})` : ''} > ${path}`;
    element = parent;
    parent = parent.parentElement;
    if (path.length > 200) break;
  }
  return path.length > 200 ? path.slice(0, 200) : path;
};

const extractOptions = (element) => {
  try {
    if (element.tagName === 'SELECT') {
      return Array.from(element.options)
        .slice(0, 30)
        .map((opt) => ({ value: opt.value, text: clean(opt.textContent || '', 120), selected: opt.selected, disabled: Boolean(opt.disabled) }));
    }
    const role = roleOf(element);
    if (role === 'combobox' || role === 'listbox') {
      const opts = Array.from(element.querySelectorAll('option, [role="option"]'))
        .slice(0, 30);
      if (opts.length > 0) {
        return opts.map((opt) => ({ value: opt.value || clean(opt.textContent || '', 120), text: clean(opt.textContent || '', 120), selected: opt.getAttribute('aria-selected') === 'true' || Boolean(opt.selected), disabled: Boolean(opt.getAttribute('aria-disabled') === 'true' || opt.disabled) }));
      }
    }
  } catch {}
  return null;
};

const tooltipOf = (element) => {
  const title = element.getAttribute('title');
  if (title) return clean(title, 240);
  try {
    const id = element.getAttribute('aria-describedby');
    if (id) {
      const target = element.ownerDocument.getElementById(id);
      if (target) return clean(target.textContent || '', 240);
    }
  } catch {}
  return null;
};

const buildChecked = (element) => {
  if (element.checked !== undefined) return element.checked;
  if (element.getAttribute('aria-checked') === 'true') return true;
  if (element.getAttribute('aria-checked') === 'false') return false;
  return null;
};

const sameRect = (a, b) => Math.abs(a.left - b.left) < 2
  && Math.abs(a.top - b.top) < 2
  && Math.abs(a.width - b.width) < 2
  && Math.abs(a.height - b.height) < 2;

const collectPolarisInteractiveElements = (options = {}) => {
  const viewportOnly = options.viewportOnly === true;
  const maxElements = Number.isFinite(options.maxElements) ? options.maxElements : 300;
  const candidates = [];
  const seen = new WeakSet();
  let order = 0;

  const addCandidate = (element, offset, frames) => {
    if (!isElement(element) || seen.has(element)) return;
    seen.add(element);
    if (!looksInteractive(element) || !isVisible(element, offset, viewportOnly)) return;
    const rect = rectOf(element, offset);
    const label = labelOf(element);
    candidates.push({
      element,
      rect,
      label,
      searchText: buildSearchText(element, label),
      kind: kindOf(element),
      value: clean(element.value || '', 220),
      placeholder: clean(element.getAttribute('placeholder') || '', 220),
      href: clean(element.href || element.getAttribute('data-href') || '', 500),
      disabled: isDisabled(element),
      fillable: isFillable(element) && !isDisabled(element) && !isReadOnly(element),
      checked: buildChecked(element),
      selected: element.getAttribute('aria-selected') === 'true' || null,
      options: extractOptions(element),
      selector: buildStableSelector(element),
      tooltip: tooltipOf(element),
      expanded: element.getAttribute('aria-expanded') === 'true' ? true : element.getAttribute('aria-expanded') === 'false' ? false : null,
      pressed: element.getAttribute('aria-pressed') === 'true' ? true : element.getAttribute('aria-pressed') === 'false' ? false : null,
      readOnly: isReadOnly(element) || null,
      required: element.hasAttribute('required') || null,
      min: element.getAttribute('min') ? Number(element.getAttribute('min')) : null,
      max: element.getAttribute('max') ? Number(element.getAttribute('max')) : null,
      step: element.getAttribute('step') ? Number(element.getAttribute('step')) : null,
      frames,
      score: scoreOf(element),
      order: order++
    });
  };

  for (const { root, offset, frames } of collectRoots()) {
    let selected = [];
    try {
      selected = Array.from(root.querySelectorAll(POLARIS_INTERACTIVE_SELECTOR));
    } catch {}
    selected.forEach((element) => addCandidate(element, offset, frames));

    let all = [];
    try {
      all = Array.from(root.querySelectorAll('*')).slice(0, POLARIS_SCAN_LIMIT);
    } catch {}
    all.forEach((element) => {
      try {
        if (hasInteractiveAttribute(element) || styleOf(element).cursor === 'pointer' || typeof element.onclick === 'function') {
          addCandidate(element, offset, frames);
        }
      } catch {}
    });
  }

  const ranked = candidates.sort((a, b) => b.score - a.score || a.order - b.order);
  const kept = [];
  for (const candidate of ranked) {
    const duplicate = kept.some((existing) => existing.element === candidate.element
      || (sameRect(existing.rect, candidate.rect) && existing.label === candidate.label && existing.kind === candidate.kind)
      || (existing.element.contains?.(candidate.element) && sameRect(existing.rect, candidate.rect)));
    if (!duplicate) kept.push(candidate);
  }

  kept.sort((a, b) => {
    const aInView = intersectsViewport(a.rect) ? 0 : 1;
    const bInView = intersectsViewport(b.rect) ? 0 : 1;
    return aInView - bInView
      || a.rect.top - b.rect.top
      || a.rect.left - b.rect.left
      || a.order - b.order;
  });

  return kept.slice(0, maxElements);
};

const toPolarisInteractiveElement = (entry, index) => ({
  index,
  kind: entry.kind,
  text: clean(entry.label, 240),
  value: entry.value,
  placeholder: entry.placeholder,
  href: entry.href,
  disabled: entry.disabled,
  fillable: entry.fillable,
  rect: entry.rect ? { x: Math.round(entry.rect.left), y: Math.round(entry.rect.top), width: Math.round(entry.rect.width), height: Math.round(entry.rect.height) } : null,
  checked: entry.checked,
  selected: entry.selected,
  options: entry.options,
  selector: entry.selector,
  tooltip: entry.tooltip,
  expanded: entry.expanded,
  pressed: entry.pressed,
  readOnly: entry.readOnly,
  required: entry.required,
  min: entry.min,
  max: entry.max,
  step: entry.step
});

const toPolarisVisualElement = (entry, index) => ({
  index,
  kind: entry.kind,
  text: clean(entry.label, 240),
  rect: {
    x: Math.round(entry.rect.left),
    y: Math.round(entry.rect.top),
    width: Math.round(entry.rect.width),
    height: Math.round(entry.rect.height)
  },
  fillable: entry.fillable,
  disabled: entry.disabled,
  checked: entry.checked,
  selected: entry.selected,
  selector: entry.selector
});
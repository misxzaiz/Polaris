/**
 * Polaris 内置浏览器页面上下文提取脚本
 * 读取页面标题、URL、选区、Meta、正文、标题、链接、表格、代码块、图片等
 */
(() => {
  const clean = (value, max = 12000) => String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  const selectedText = clean(window.getSelection ? window.getSelection().toString() : '', 6000);
  const metaDescription = clean(
    document.querySelector('meta[name="description"], meta[property="og:description"]')?.content || '',
    1000
  );
  const canonical = clean(document.querySelector('link[rel="canonical"]')?.href || '', 500) || null;
  const ogTitle = clean(document.querySelector('meta[property="og:title"]')?.content || '', 500) || null;
  const ogImage = clean(document.querySelector('meta[property="og:image"]')?.content || '', 500) || null;
  const articleText = document.querySelector('article')?.innerText || '';
  const bodyText = document.body?.innerText || '';
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
    .slice(0, 60)
    .map((node) => ({
      level: Number(node.tagName.slice(1)),
      text: clean(node.textContent || '', 240)
    }))
    .filter((item) => item.text);
  const links = Array.from(document.querySelectorAll('a[href]'))
    .slice(0, 80)
    .map((node) => ({
      text: clean(node.textContent || node.getAttribute('aria-label') || '', 160),
      href: String(node.href || ''),
      rel: clean(node.getAttribute('rel') || '', 60) || null
    }))
    .filter((item) => item.href);
  const tables = Array.from(document.querySelectorAll('table'))
    .slice(0, 15)
    .map((table) => {
      const caption = clean(table.caption?.innerText || table.getAttribute('aria-label') || '', 240) || null;
      const rows = [];
      for (const tr of Array.from(table.querySelectorAll('tr')).slice(0, 200)) {
        const cells = Array.from(tr.querySelectorAll('td, th'))
          .map((c) => clean(c.textContent || '', 200));
        if (cells.length > 0) rows.push(cells);
      }
      return { rows, caption };
    })
    .filter((t) => t.rows.length > 0);
  const codeBlocks = Array.from(document.querySelectorAll('pre, code'))
    .slice(0, 30)
    .map((node) => ({
      language: clean(
        (node.getAttribute('class') || '').match(/language-(\w+)/)?.[1] ||
        (node.getAttribute('data-language') || ''),
        40
      ),
      code: clean(node.textContent || '', 4000)
    }))
    .filter((c) => c.code);
  const images = Array.from(document.querySelectorAll('img[src], img[alt]'))
    .slice(0, 40)
    .map((node) => ({
      src: clean(node.src || '', 500),
      alt: clean(node.getAttribute('alt') || '', 240),
      width: node.naturalWidth > 0 ? node.naturalWidth : null,
      height: node.naturalHeight > 0 ? node.naturalHeight : null
    }))
    .filter((i) => i.src || i.alt);
  const tagOfElement = (element) => String(element?.tagName || '').toLowerCase();
  const structuredData = [];
  let lists = [];
  let forms = [];
  try {
    for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0, 20)) {
      try {
        const parsed = JSON.parse(script.textContent || '');
        structuredData.push(parsed);
      } catch {}
    }
    lists = Array.from(document.querySelectorAll('ul, ol')).slice(0, 30).map((list) => ({
      ordered: tagOfElement(list) === 'ol',
      items: Array.from(list.querySelectorAll('li')).slice(0, 50).map((li) => clean(li.textContent || '', 200))
    }));
    forms = Array.from(document.querySelectorAll('form')).slice(0, 10).map((form) => ({
      action: clean(form.getAttribute('action') || '', 300),
      method: clean(form.getAttribute('method') || 'get', 20),
      fields: Array.from(form.querySelectorAll('input, textarea, select')).slice(0, 60).map((field) => {
        const tag = tagOfElement(field);
        const type = field.getAttribute('type') || '';
        const name = field.getAttribute('name') || '';
        return clean(`${tag}${type ? `[type="${type}"]` : ''}${name ? `[name="${name}"]` : ''}`, 200);
      })
    }));
  } catch {}
  return JSON.stringify({
    title: clean(document.title || '', 300),
    url: String(location.href),
    selectedText,
    metaDescription,
    text: clean(articleText || bodyText, 12000),
    headings,
    links,
    tables,
    codeBlocks,
    images,
    structuredData,
    lists,
    forms,
    canonical,
    ogTitle,
    ogImage
  });
})()
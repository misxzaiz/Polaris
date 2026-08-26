// 阅读模式：开启时把页面正文替换为净化后的可读排版视图；关闭时恢复原始文档
// 通过 meta 标记记录状态，避免重复注入
(function () {
  try {
    var state = document.getElementById('polaris-reader-root');
    if (state) {
      // 已启用 → 恢复原始视图
      state.remove();
      Array.prototype.forEach.call(document.body.children, function (child) {
        child.style.display = '';
      });
      return JSON.stringify({ enabled: false });
    }

    // 查找正文
    var article = document.querySelector('article');
    if (!article) {
      var candidates = Array.prototype.slice.call(
        document.querySelectorAll('main, [role="main"], .article, .post, .entry-content, .content')
      );
      if (candidates.length) {
        candidates.sort(function (a, b) { return b.innerText.length - a.innerText.length; });
        article = candidates[0];
      }
    }
    if (!article) return JSON.stringify({ enabled: false, error: 'no-content' });

    var text = (article.innerText || '').trim();
    if (text.length < 40) return JSON.stringify({ enabled: false, error: 'too-short' });

    // 保存原始 HTML（限大，超限则仅清 body 子节点用 display 隐藏）

    // 构建阅读视图
    var title = document.title || '';
    var h1 = article.querySelector('h1, h2');
    var heading = (h1 ? h1.innerText.trim() : title) || title;

    var container = document.createElement('div');
    container.id = 'polaris-reader-root';
    container.style.cssText =
      'position:fixed;inset:0;z-index:2147483000;overflow:auto;background:#fff;color:#1a1a1a;' +
      'padding:48px 24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.8;';
    var inner = document.createElement('div');
    inner.style.cssText = 'max-width:720px;margin:0 auto;';
    var h = document.createElement('h1');
    h.textContent = heading;
    h.style.cssText = 'font-size:28px;font-weight:700;margin:0 0 8px;color:#111;';
    var urlLine = document.createElement('div');
    urlLine.textContent = location.href;
    urlLine.style.cssText = 'font-size:13px;color:#888;margin-bottom:24px;word-break:break-all;';
    var body = document.createElement('div');
    body.style.cssText = 'font-size:17px;color:#222;white-space:pre-wrap;';
    body.textContent = text;
    inner.appendChild(h);
    inner.appendChild(urlLine);
    inner.appendChild(body);
    container.appendChild(inner);

    // 覆盖到当前文档：隐藏 body 子节点，在 body 末尾追加全屏阅读容器
    Array.prototype.forEach.call(document.body.children, function (child) {
      child.style.display = 'none';
    });
    document.body.appendChild(container);

    return JSON.stringify({ enabled: true, title: heading });
  } catch (e) {
    return JSON.stringify({ enabled: false, error: 'exception' });
  }
})()
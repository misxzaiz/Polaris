/**
 * 断言检查 body：从 window.__POLARIS_ASSERT_ARGS__ 读参数，依赖 collector。
 * 此文件是 body（不含 IIFE），由 assert_check_script() 组合包裹执行。
 */
try {
    const args = window.__POLARIS_ASSERT_ARGS__ || {};
    const kind = args.kind || '';
    const text = args.text || '';
    const index = args.index;
    const initialUrl = args.initialUrl || String(location.href);
    let ok = false;
    let detail = '';

    if (kind === 'url_contains') {
      ok = text ? String(location.href).toLowerCase().includes(text.toLowerCase()) : false;
      detail = ok ? String(location.href) : `URL 未包含 "${text}"（当前: ${String(location.href)}）`;
    } else if (kind === 'url_change') {
      ok = String(location.href) !== initialUrl;
      detail = ok ? `URL 已变化: ${String(location.href)}` : 'URL 未变化';
    } else if (kind === 'element_exists') {
      const entries = collectPolarisInteractiveElements({ viewportOnly: false, maxElements: 240 });
      if (Number.isInteger(index) && index >= 0) {
        ok = index < entries.length;
        detail = ok ? `元素 ${index} 存在` : `元素 ${index} 不存在（共 ${entries.length} 个）`;
      } else if (text) {
        const q = text.toLowerCase();
        ok = entries.some(e => (e.searchText || '').toLowerCase().includes(q));
        detail = ok ? `找到元素 "${text}"` : `未找到元素 "${text}"`;
      }
    } else if (kind === 'text_exists') {
      ok = text ? (document.body?.innerText || '').toLowerCase().includes(text.toLowerCase()) : false;
      detail = ok ? `页面包含 "${text}"` : `页面未包含 "${text}"`;
    } else if (kind === 'no_error') {
      const consoleErrors = (window.__POLARIS_BROWSER_CONSOLE__ || [])
        .filter(c => c.level === 'error').length;
      const failedResources = performance.getEntriesByType('resource')
        .filter(r => r.transferSize === 0 && r.responseEnd > 0);
      ok = consoleErrors === 0 && failedResources.length === 0;
      detail = ok ? '页面无错误信号' : `console 错误 ${consoleErrors} 个, 失败资源 ${failedResources.length} 个`;
    } else if (kind === 'login_ok') {
      // 登录成功 = URL 从登录页跳转 + 无致命错误
      const urlChanged = String(location.href) !== initialUrl;
      const consoleErrors = (window.__POLARIS_BROWSER_CONSOLE__ || [])
        .filter(c => c.level === 'error').length;
      ok = urlChanged && consoleErrors === 0;
      detail = ok
        ? `登录成功（已跳转 + 无错误）`
        : `登录可能未成功: URL${urlChanged ? '已变化' : '未变化'}, console错误 ${consoleErrors} 个`;
    } else {
      detail = `未知断言类型: ${kind}`;
    }

    delete window.__POLARIS_ASSERT_ARGS__;
    return JSON.stringify({ ok, kind, text, url: String(location.href), message: detail });
  } catch (e) {
    return JSON.stringify({ ok: false, kind: '', text: '', url: String(location.href), message: '断言检查失败: ' + (e && e.message) });
  }
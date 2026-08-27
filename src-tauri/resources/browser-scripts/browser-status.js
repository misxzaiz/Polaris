(() => {
  try {
    const readyState = document.readyState;
    const bodyText = (document.body?.innerText || '').trim().slice(0, 2000);
    const url = String(location.href).toLowerCase();

    // 1. 还在加载
    if (readyState !== 'complete') {
      return JSON.stringify({ status: 'loading', readyState, url: String(location.href), message: '页面还在加载中' });
    }

    // 2. 白屏：body 几乎没有文本与可见元素
    const visibleTextLen = bodyText.length;
    if (visibleTextLen < 10) {
      return JSON.stringify({
        status: 'blank',
        readyState,
        url: String(location.href),
        message: '页面疑似白屏（几乎没有可见文本），可能加载失败或 JS 崩溃',
        textPreview: bodyText.slice(0, 120),
      });
    }

    // 3. 需要登录：常见登录墙特征
    const loginHints = ['登录', '请先登录', 'login', 'sign in', 'signin', '登录后查看', '需要登录'];
    const needLogin = loginHints.some(h => bodyText.toLowerCase().includes(h.toLowerCase()));
    // 登录页判定（URL 或标题特征）
    const loginUrlHint = /(login|signin|sign-in|passport|auth|account\/login)/.test(url);

    // 4. 验证码 / 风控拦截
    const captchaHints = ['验证码', 'captcha', '人机验证', '安全验证', '完成验证', '滑块', 'recaptcha', '滑动验证'];
    const captcha = captchaHints.some(h => bodyText.toLowerCase().includes(h.toLowerCase()));

    // 5. 请求/渲染错误
    const consoleErrors = (window.__POLARIS_BROWSER_CONSOLE__ || [])
      .filter(c => c.level === 'error').length;
    const failedResources = performance.getEntriesByType('resource')
      .filter(r => r.transferSize === 0 && r.responseEnd > 0).length;
    const errorHints = ['error', '错误', '出错', '404', '500', '502', '503', '页面不存在', '无法访问', 'something went wrong', 'internal server error'];
    const hasErrorText = errorHints.some(h => bodyText.toLowerCase().includes(h.toLowerCase()));
    const requestError = consoleErrors > 0 || failedResources > 0;

    // 判定优先级：白屏 > 验证码 > 登录 > 请求错误 > 正常
    if (captcha) {
      return JSON.stringify({ status: 'captcha', url: String(location.href), message: '出现验证码/人机验证，需要人工处理', textPreview: bodyText.slice(0, 120) });
    }
    if (needLogin || (loginUrlHint && !hasErrorText)) {
      return JSON.stringify({ status: 'need_login', url: String(location.href), message: '需要登录或登录态失效', textPreview: bodyText.slice(0, 120) });
    }
    if (requestError || hasErrorText) {
      return JSON.stringify({
        status: 'request_error',
        url: String(location.href),
        message: `页面有错误信号：console错误 ${consoleErrors} 个, 失败资源 ${failedResources} 个${hasErrorText ? ', 页面含错误提示' : ''}`,
        textPreview: bodyText.slice(0, 120),
      });
    }

    return JSON.stringify({ status: 'normal', url: String(location.href), message: '页面正常可用', textPreview: bodyText.slice(0, 120) });
  } catch (e) {
    return JSON.stringify({ status: 'unknown', url: String(location.href), message: '状态检测失败: ' + (e && e.message) });
  }
})()
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

    // 3. 需要登录：仅当出现明确"登录墙"拦截语时才判定（避免导航栏/页脚单字"登录"造成误报）
    // 注意：不做单字"登录"匹配——普通页面导航/页脚常含"登录"链接
    const loginWallHints = ['请先登录', '登录后继续', '登录后查看', '需要登录', '登录后才能', 'sign in to continue', 'please sign in', 'log in to', 'login to continue', '请登录'];
    const needLogin = loginWallHints.some(h => bodyText.toLowerCase().includes(h.toLowerCase()));
    // 登录页判定（URL 或标题特征）——同样用较强的 URL 模式，避免误伤含 account/auth 参数的普通页
    const loginUrlHint = /^\/(login|signin|sign-in|passport|auth)\b|\/(login|signin|sign-in|passport|auth)(\/|\?|$)/.test(url)
      || /^https?:\/\/[^/]*(login|signin|sign-in|passport|auth)\.[^/]*\//.test(url);

    // 4. 验证码 / 风控拦截：用明确的"人机验证"拦截语，避免注册表单"验证码输入框"误报
    const captchaHints = ['人机验证', '安全验证', '完成验证', '滑动验证', '拖动滑块', '请完成验证码', '图形验证码', 'recaptcha', 'reCAPTCHA', '智能验证', '点击并按住验证', 'slider captcha'];
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
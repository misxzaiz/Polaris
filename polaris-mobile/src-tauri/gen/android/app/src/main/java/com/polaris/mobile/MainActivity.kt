package com.polaris.mobile

import android.graphics.Color
import android.os.Bundle
import android.webkit.WebView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // 1. 让 WebView 内容绘制到系统栏（状态栏/导航栏）后面
    WindowCompat.setDecorFitsSystemWindows(window, false)

    // 2. 状态栏和导航栏透明
    window.statusBarColor = Color.TRANSPARENT
    window.navigationBarColor = Color.TRANSPARENT

    super.onCreate(savedInstanceState)

    // 3. 沉浸模式：默认隐藏系统栏，下滑/上滑时临时显示，松手后自动隐藏
    val controller = WindowInsetsControllerCompat(window, window.decorView)
    controller.systemBarsBehavior =
      WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    controller.hide(WindowInsetsCompat.Type.systemBars())
  }

  override fun onWebViewCreate(webView: WebView) {
    // 设置非标准 User-Agent，让 ngrok 免费版跳过"Visit Site"警告中间页。
    // ngrok 会检测 UA 是否为标准浏览器（以 Mozilla/ 开头），非标准 UA
    // 直接放行。所有从 WebView 发出的请求（包括 fetch 的 preflight OPTIONS）
    // 都会携带此 UA，不会被中间页拦截。
    webView.settings.userAgentString = "Polaris-App/1.0"
    super.onWebViewCreate(webView)
  }
}
package com.polaris.mobile

import android.graphics.Color
import android.os.Bundle
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
}
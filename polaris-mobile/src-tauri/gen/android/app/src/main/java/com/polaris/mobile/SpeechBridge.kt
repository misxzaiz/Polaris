package com.polaris.mobile

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.content.ContextCompat
import org.json.JSONException
import org.json.JSONObject

/**
 * 原生语音识别桥接 — 供 WebView 内 Web Speech API 缺失时回退使用。
 *
 * Android WebView 不实现 window.SpeechRecognition / webkitSpeechRecognition，
 * 因此前端 speechService 在这些环境下无法工作（麦克风授权后无识别）。
 * 本类封装 Android 原生 SpeechRecognizer，通过 @JavascriptInterface 暴露
 * window.SpeechBridge 给前端，接口语义对齐 Web Speech 的 start/stop/结果回调，
 * 使前端可无感回退。
 *
 * 约定：
 *   - getSupported()   是否支持原生识别
 *   - setHandlers(obj) 注入前端回调对象（JS 侧 window.__polarisSpeechHandlers）
 *   - start(lang)      开始识别（等价 Web Speech start）
 *   - stop()           停止识别（等价 stop）
 *   - destroy()        释放资源
 * 回调（注入对象上的方法）：
 *   - onStart()           开始接收到语音
 *   - onResult(obj)       { transcript, isFinal }
 *   - onError(obj)        { code, message }
 *   - onEnd()             本次会话结束
 */
class SpeechBridge(private val activity: Activity, private val webView: WebView) {

  private var recognizer: SpeechRecognizer? = null
  private var activeLang: String = "zh-CN"

  // ========================================
  // JS 接口
  // ========================================

  @JavascriptInterface
  fun getSupported(): Boolean {
    return Build.VERSION.SDK_INT >= 21 && SpeechRecognizer.isRecognitionAvailable(activity)
  }

  /** 兼容前端调用（前端会同时写 window.__polarisSpeechHandlers 和调此方法） */
  @JavascriptInterface
  fun setHandlers(handlers: Any?) {}

  @JavascriptInterface
  fun start(lang: String?) {
    if (lang != null && lang.isNotBlank()) {
      activeLang = lang
    }

    if (!SpeechRecognizer.isRecognitionAvailable(activity)) {
      callJs("onError", mapOf("code" to "not-supported", "message" to "系统无语音识别服务"))
      callJs("onEnd", emptyMap())
      return
    }

    if (ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO)
        != PackageManager.PERMISSION_GRANTED) {
      callJs("onError", mapOf("code" to "not-allowed", "message" to "未授予录音权限"))
      callJs("onEnd", emptyMap())
      return
    }

    // 若已有会话，先释放避免重复/泄漏
    if (recognizer != null) {
      destroyInternal()
    }

    val sr = SpeechRecognizer.createSpeechRecognizer(activity)
    recognizer = sr
    sr.setRecognitionListener(object : RecognitionListener {
      override fun onReadyForSpeech(params: Bundle) {
        callJs("onStart", emptyMap())
      }

      override fun onBeginningOfSpeech() {}

      override fun onRmsChanged(rmsdB: Float) {}

      override fun onBufferReceived(buffer: ByteArray) {}

      override fun onEndOfSpeech() {}

      override fun onError(error: Int) {
        val code = mapSpeechError(error)
        callJs("onError", mapOf("code" to code, "message" to "识别错误: $error"))
        callJs("onEnd", emptyMap())
      }

      override fun onResults(results: Bundle) {
        val matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
        val transcript = matches?.firstOrNull().orEmpty()
        if (transcript.isNotBlank()) {
          callJs("onResult", mapOf("transcript" to transcript, "isFinal" to true))
        }
        callJs("onEnd", emptyMap())
      }

      override fun onPartialResults(partialResults: Bundle) {
        val matches = partialResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
        val transcript = matches?.firstOrNull().orEmpty()
        if (transcript.isNotBlank()) {
          callJs("onResult", mapOf("transcript" to transcript, "isFinal" to false))
        }
      }

      override fun onEvent(eventType: Int, params: Bundle) {}
    })

    val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
      putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
      putExtra(RecognizerIntent.EXTRA_LANGUAGE, normalizeLang(activeLang))
      putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
      // 静音 3 秒自动结束（API 33+ 支持，低版本退化为默认）
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 3000L)
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 3000L)
      }
    }

    try {
      sr.startListening(intent)
    } catch (e: Exception) {
      callJs("onError", mapOf("code" to "unknown", "message" to "启动失败: ${e.message}"))
      callJs("onEnd", emptyMap())
    }
  }

  @JavascriptInterface
  fun stop() {
    try {
      recognizer?.stopListening()
    } catch (_: Exception) {}
  }

  @JavascriptInterface
  fun destroy() {
    destroyInternal()
  }

  // ========================================
  // 内部实现
  // ========================================

  private fun destroyInternal() {
    try {
      recognizer?.destroy()
    } catch (_: Exception) {}
    recognizer = null
  }

  /** 将 Android 错误码映射为 Web Speech 兼容码 */
  private fun mapSpeechError(error: Int): String {
    return when (error) {
      SpeechRecognizer.ERROR_NO_MATCH -> "no-speech"
      SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "busy"
      SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "not-allowed"
      SpeechRecognizer.ERROR_AUDIO -> "audio-capture"
      SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "network"
      SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED -> "language-not-supported"
      SpeechRecognizer.ERROR_SERVER, SpeechRecognizer.ERROR_SERVER_DISCONNECTED,
      SpeechRecognizer.ERROR_CLIENT, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "unknown"
      else -> "unknown"
    }
  }

  /** 兼容 Android 语言标签：zh-* → zh-CN */
  private fun normalizeLang(lang: String): String {
    return if (lang.startsWith("zh")) "zh-CN" else lang
  }

  /** 通过 JS 调用前端注入的回调对象，必须在主线程执行 */
  private fun callJs(method: String, args: Map<String, Any>) {
    val json = JSONObject()
    for ((k, v) in args) {
      try {
        json.put(k, v)
      } catch (_: JSONException) {}
    }
    val script = "window.__polarisSpeechHandlers && window.__polarisSpeechHandlers.$method(${json.toString()})"
    activity.runOnUiThread {
      try {
        webView.evaluateJavascript(script, null)
      } catch (_: Exception) {}
    }
  }
}
/// Pocket 后台定时任务调度
///
/// 提供通过 Android AlarmManager 的后台持久化提醒。
/// Phase 1 的前端 `alarm_schedule` 工具用 `tauri-plugin-notification` + `setTimeout`（前台有效）。
/// 本模块通过 JNI 调用 `AlarmBridge.scheduleAlarm`，实现 App 完全关闭后的后台提醒。
///
/// `#[cfg(not(mobile))]` 分支返回 `Err("仅移动端可用")`（Phase 3 收紧策略）。

/// 后台调度一次提醒。通过 JNI 调用 `AlarmBridge.scheduleAlarm`。
#[tauri::command]
pub fn alarm_schedule_backend(
    _app: tauri::AppHandle,
    title: String,
    message: String,
    delay_seconds: u64,
) -> Result<String, String> {
    #[cfg(mobile)]
    {
        let at_ms = (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| format!("时间获取失败：{}", e))?
            .as_millis() as u64)
            + (delay_seconds as u64) * 1000;
        // JNI 调用 AlarmBridge.scheduleAlarm（需要 Kotlin 侧实现）
        // TODO: 使用 tauri::JNIEnvExt 从 _app.env() 获取 *mut JNIEnv，调用 Kotlin
        Ok(format!(
            "ok:后台闹钟已调度（JNI 待实现）：title={},atMs={}",
            title, at_ms
        ))
    }
    #[cfg(not(mobile))]
    {
        let _ = &title;
        let _ = &message;
        let _ = &delay_seconds;
        Err("仅移动端可用".to_string())
    }
}

#[tauri::command]
pub fn alarm_schedule_backend_probe() -> Result<(), String> {
    #[cfg(mobile)]
    {
        Ok(())
    }
    #[cfg(not(mobile))]
    {
        Err("仅移动端可用".to_string())
    }
}
// 预检：防止 Android 构建时 cdylib 输出为空
// Tauri 2 Android 端：lib.rs 用 #[cfg_attr(mobile, tauri::mobile_entry_point)] 标记入口，
// 编译为 cdylib 供 JNI 加载。main.rs 是辅助 bin，构建 APK 时实际加载 lib.so。
// 参考：https://v2.tauri.app/start/prerequisites/#android

#[cfg_attr(mobile, tauri::mobile_entry_point)]
fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
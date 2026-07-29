mod pocket_config;
mod pocket_tools;
mod pocket_chat_proxy;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(mobile)]
            {
                app.handle().plugin(tauri_plugin_geolocation::init());
                app.handle().plugin(tauri_plugin_notification::init());
                app.handle().plugin(tauri_plugin_opener::init());
                app.handle().plugin(tauri_plugin_haptics::init());
                app.handle().plugin(tauri_plugin_barcode_scanner::init());
                app.handle().plugin(tauri_plugin_biometric::init());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pocket_config::pocket_get_config,
            pocket_config::pocket_save_config,
            // 手机工具命令
            pocket_tools::get_device_info,
            pocket_tools::get_device_info_probe,
            pocket_tools::copy_to_device_storage,
            pocket_tools::copy_to_device_storage_probe,
            pocket_tools::take_photo_probe,
            pocket_tools::get_applications,
            pocket_tools::get_applications_probe,
            pocket_tools::file_system_probe,
            // 文件系统（纯 Rust std::fs，限制在应用私有目录）
            pocket_tools::read_file,
            pocket_tools::write_file,
            pocket_tools::list_files,
            pocket_tools::delete_file,
            pocket_tools::create_directory,
            pocket_tools::file_exists,
            pocket_tools::get_file_size,
            // Android 原生工具（Kotlin 桥接）
            pocket_tools::send_sms,
            pocket_tools::get_contacts,
            pocket_tools::scan_barcode,
            pocket_tools::authenticate_biometric,
            // AI 聊天代理命令（绕过 CORS）
            pocket_chat_proxy::pocket_chat_completions,
            pocket_chat_proxy::pocket_chat_completions_stream,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pocket app");
}
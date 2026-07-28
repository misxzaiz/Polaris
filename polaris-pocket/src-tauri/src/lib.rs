mod pocket_config;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            pocket_config::pocket_get_config,
            pocket_config::pocket_save_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pocket app");
}
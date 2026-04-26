/*! 文件系统监听服务
 *
 * 使用 notify crate 监听工作区目录变化，通过 Tauri 事件系统通知前端
 */

use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// 需要忽略的目录名称
const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    ".polaris",
    "__pycache__",
    ".DS_Store",
    "dist",
    ".turbo",
    ".next",
];

/// 文件系统变化事件（发送到前端）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChangeEvent {
    /// 受影响的父目录路径列表（相对路径，去重后）
    pub affected_dirs: Vec<String>,
}

/// 文件监听管理器
pub struct FileWatcherManager {
    /// 监听器（drop 时自动停止）
    watcher: Option<RecommendedWatcher>,
    /// 事件处理线程句柄
    runner_handle: Option<std::thread::JoinHandle<()>>,
    /// 当前监听的根路径
    watch_root: Option<PathBuf>,
}

impl Default for FileWatcherManager {
    fn default() -> Self {
        Self::new()
    }
}

impl FileWatcherManager {
    pub fn new() -> Self {
        Self {
            watcher: None,
            runner_handle: None,
            watch_root: None,
        }
    }

    /// 启动文件监听
    pub fn start(&mut self, root_path: String, app_handle: AppHandle) -> Result<(), String> {
        let root = PathBuf::from(&root_path);
        if !root.exists() {
            return Err(format!("目录不存在: {}", root_path));
        }

        // 如果已在监听同一目录，跳过
        if let Some(ref current) = self.watch_root {
            if current == &root {
                return Ok(());
            }
        }

        // 先停止已有监听
        self.stop();

        let (tx, rx) = mpsc::channel();

        // 创建监听器
        let mut watcher = RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| {
                let _ = tx.send(res);
            },
            Config::default().with_poll_interval(Duration::from_millis(500)),
        )
        .map_err(|e| format!("创建文件监听器失败: {}", e))?;

        // 开始监听
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|e| format!("启动文件监听失败: {}", e))?;

        tracing::info!("[FileWatcher] 开始监听目录: {:?}", root);

        // 启动事件处理线程
        let runner = FileWatcherRunner::new(rx, app_handle, root.clone());
        let handle = std::thread::Builder::new()
            .name("file-watcher-runner".to_string())
            .spawn(move || runner.run())
            .map_err(|e| format!("启动监听线程失败: {}", e))?;

        self.watcher = Some(watcher);
        self.runner_handle = Some(handle);
        self.watch_root = Some(root);

        Ok(())
    }

    /// 停止文件监听
    pub fn stop(&mut self) {
        if self.watcher.is_some() {
            tracing::info!("[FileWatcher] 停止监听");
            // drop watcher 会关闭 channel，runner 线程会自动退出
            self.watcher = None;

            // 等待 runner 线程结束
            if let Some(handle) = self.runner_handle.take() {
                let _ = handle.join();
            }

            self.watch_root = None;
        }
    }

    /// 是否正在监听
    pub fn is_watching(&self) -> bool {
        self.watcher.is_some()
    }

    /// 获取当前监听路径
    pub fn watch_root(&self) -> Option<&PathBuf> {
        self.watch_root.as_ref()
    }
}

impl Drop for FileWatcherManager {
    fn drop(&mut self) {
        self.stop();
    }
}

/// 文件监听事件处理运行时
struct FileWatcherRunner {
    rx: mpsc::Receiver<Result<Event, notify::Error>>,
    app_handle: AppHandle,
    watch_root: PathBuf,
}

impl FileWatcherRunner {
    fn new(
        rx: mpsc::Receiver<Result<Event, notify::Error>>,
        app_handle: AppHandle,
        watch_root: PathBuf,
    ) -> Self {
        Self {
            rx,
            app_handle,
            watch_root,
        }
    }

    /// 运行事件处理循环
    fn run(self) {
        let mut pending_dirs: Vec<String> = Vec::new();
        let mut last_emit = std::time::Instant::now();
        let debounce_interval = Duration::from_millis(300);

        loop {
            match self.rx.recv_timeout(Duration::from_millis(100)) {
                Ok(Ok(event)) => {
                    // 提取受影响的父目录
                    for path in &event.paths {
                        if should_ignore(path, &self.watch_root) {
                            continue;
                        }

                        // 获取受影响的父目录（文件变化时取其父目录，目录变化时取自身）
                        let parent = if path.is_dir() {
                            path.clone()
                        } else {
                            path.parent().unwrap_or(path).to_path_buf()
                        };

                        if let Ok(rel) = parent.strip_prefix(&self.watch_root) {
                            let rel_str = rel.to_string_lossy().replace('\\', "/");
                            // 根目录变化
                            let dir_key = if rel_str.is_empty() {
                                ".".to_string()
                            } else {
                                rel_str
                            };
                            if !pending_dirs.contains(&dir_key) {
                                pending_dirs.push(dir_key);
                            }
                        }
                    }
                }
                Ok(Err(e)) => {
                    tracing::warn!("[FileWatcher] 监听事件错误: {:?}", e);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    // 防抖：攒够间隔后发射
                    if !pending_dirs.is_empty() && last_emit.elapsed() >= debounce_interval {
                        let change = FsChangeEvent {
                            affected_dirs: pending_dirs.clone(),
                        };

                        if let Err(e) = self.app_handle.emit("file-system-change", &change) {
                            tracing::warn!("[FileWatcher] 发射事件失败: {:?}", e);
                        }

                        pending_dirs.clear();
                        last_emit = std::time::Instant::now();
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    tracing::info!("[FileWatcher] 监听通道断开，退出事件循环");
                    // 发射最后一批事件
                    if !pending_dirs.is_empty() {
                        let change = FsChangeEvent {
                            affected_dirs: pending_dirs,
                        };
                        let _ = self.app_handle.emit("file-system-change", &change);
                    }
                    break;
                }
            }
        }
    }
}

/// 检查路径是否应该被忽略
fn should_ignore(path: &Path, root: &Path) -> bool {
    if let Ok(relative) = path.strip_prefix(root) {
        for component in relative.components() {
            if let std::path::Component::Normal(name) = component {
                if IGNORED_DIRS.contains(&name.to_string_lossy().as_ref()) {
                    return true;
                }
            }
        }
    }
    false
}

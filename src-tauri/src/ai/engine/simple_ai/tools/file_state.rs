/*! 会话级文件状态缓存（read-before-write + mtime 冲突检测的单一事实源）
 *
 * 对齐业界最佳实践（Claude Code / labuladong 设计）：
 * - `read_file` 读取文件后登记 [FileState]（内容哈希 + mtime + 元信息）；
 * - 写类工具（edit_file / write_file / apply_patch）在修改前必须校验：
 *   1. **read-before-write**：文件未被 read 过 → 拒绝并提示先读；
 *   2. **mtime conflict**：文件被外部修改（mtime 与登记不一致）→ 拒绝并提示重读；
 * - 写成功后自动更新登记，避免后续工具误判冲突。
 *
 * 注意：编辑锚点不再依赖行号（read 输出的行号仅供展示），因此本缓存只做
 * 「防止基于过期内容编辑」的护栏，不参与字符串匹配本身。
 */

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 文件状态快照：登记时抓取，写前校验。
#[derive(Debug, Clone)]
pub(crate) struct FileState {
    /// 登记时读取的完整内容（用于 write-before-read 校验与 diff 反馈）。
    pub content: String,
    /// 登记时文件大小（字节）。
    pub size: usize,
    /// 登记时文件修改时间（epoch millis）。
    pub mtime_ms: u128,
}

/// 会话级文件状态注册表。由 `ToolContext` 持有，所有 fs 工具共享。
#[derive(Debug, Default)]
pub(crate) struct FileStateRegistry {
    states: Mutex<HashMap<PathBuf, FileState>>,
}

impl FileStateRegistry {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// 登记（或更新）某文件的当前状态：读取内容并记录 size/mtime。
    /// 文件不存在 / 读取失败时移除登记并返回 Err（便于调用方给出友好提示）。
    pub(crate) fn register(&self, path: &Path) -> Result<FileState, String> {
        let content = std::fs::read_to_string(path)
            .map_err(|e| format!("Failed to read file '{}': {}", path.display(), e))?;
        let size = content.len();
        let mtime_ms = file_mtime_ms(path).unwrap_or(0);
        let state = FileState { content, size, mtime_ms };
        self.states.lock().unwrap().insert(path.to_path_buf(), state.clone());
        Ok(state)
    }

    /// 查询文件是否已登记及登记状态。
    pub(crate) fn get(&self, path: &Path) -> Option<FileState> {
        self.states.lock().unwrap().get(path).cloned()
    }

    /// 移除登记（如文件被删除）。
    pub(crate) fn remove(&self, path: &Path) {
        self.states.lock().unwrap().remove(path);
    }

    /// 以新内容 + 当前 mtime 更新登记（写成功后调用）。
    pub(crate) fn update_after_write(&self, path: &Path, content: &str) {
        let mtime_ms = file_mtime_ms(path).unwrap_or(0);
        self.states.lock().unwrap().insert(
            path.to_path_buf(),
            FileState { content: content.to_string(), size: content.len(), mtime_ms },
        );
    }

    /// 写前校验：返回 Ok(()) 可写；Err 含具体原因与修复指引。
    ///
    /// - 未登记 → 提示先 read_file（read-before-write）；
    /// - mtime 不一致 → 提示文件已被外部修改，重新 read_file。
    pub(crate) fn verify_before_write(&self, path: &Path) -> Result<(), String> {
        let states = self.states.lock().unwrap();
        match states.get(path) {
            None => Err(format!(
                "File '{}' must be read with read_file before editing (read-before-write). \
                 This prevents editing based on stale content. Read the file first, then retry.",
                path.display()
            )),
            Some(registered) => {
                let current_mtime = file_mtime_ms(path).unwrap_or(0);
                if current_mtime != 0 && registered.mtime_ms != 0 && current_mtime != registered.mtime_ms {
                    Err(format!(
                        "File '{}' has been modified externally since it was read \
                         (mtime mismatch: registered {}ms vs current {}ms). \
                         Re-read the file with read_file to get current content, then retry.",
                        path.display(),
                        registered.mtime_ms,
                        current_mtime
                    ))
                } else {
                    Ok(())
                }
            }
        }
    }
}

/// 读取文件 mtime（epoch millis）；失败返回 None。
pub(crate) fn file_mtime_ms(path: &Path) -> Option<u128> {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
}

/// 检测文件换行风格：CRLF / LF / CR / 无换行（用于写入时保留原格式）。
pub(crate) fn detect_line_endings(content: &str) -> &'static str {
    if content.contains("\r\n") {
        "\r\n"
    } else if content.contains('\r') {
        "\r"
    } else {
        "\n"
    }
}

/// 归一化换行为 LF（行级处理时的统一中间态）。
pub(crate) fn normalize_lf(content: &str) -> String {
    content.replace("\r\n", "\n").replace('\r', "\n")
}

/// 将 LF 内容按目标换行风格重新落盘（保留原文件的换行风格）。
pub(crate) fn apply_line_endings(lf_content: &str, line_ending: &str) -> String {
    if line_ending == "\n" {
        lf_content.to_string()
    } else {
        lf_content.replace('\n', line_ending)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_and_get_state() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("t.txt");
        std::fs::write(&file, "hello").unwrap();

        let reg = FileStateRegistry::new();
        let state = reg.register(&file).unwrap();
        assert_eq!(state.content, "hello");
        assert_eq!(state.size, 5);

        let got = reg.get(&file).unwrap();
        assert_eq!(got.content, "hello");
        assert_eq!(got.mtime_ms, state.mtime_ms);
    }

    #[test]
    fn verify_before_write_requires_prior_read() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("t.txt");
        std::fs::write(&file, "hello").unwrap();

        let reg = FileStateRegistry::new();
        let err = reg.verify_before_write(&file).unwrap_err();
        assert!(err.contains("must be read"));
    }

    #[test]
    fn verify_before_write_rejects_external_mtime_change() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("t.txt");
        std::fs::write(&file, "hello").unwrap();

        let reg = FileStateRegistry::new();
        reg.register(&file).unwrap();

        // 外部修改内容（mtime 变化）
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&file, "changed!").unwrap();

        let err = reg.verify_before_write(&file).unwrap_err();
        assert!(err.contains("modified externally"));
    }

    #[test]
    fn verify_ok_after_register_and_after_update() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("t.txt");
        std::fs::write(&file, "hello").unwrap();

        let reg = FileStateRegistry::new();
        reg.register(&file).unwrap();
        assert!(reg.verify_before_write(&file).is_ok());

        // 写成功后更新登记，再次校验通过
        std::fs::write(&file, "hello world").unwrap();
        reg.update_after_write(&file, "hello world");
        assert!(reg.verify_before_write(&file).is_ok());
    }

    #[test]
    fn line_ending_detection_and_normalization() {
        assert_eq!(detect_line_endings("a\r\nb\r\n"), "\r\n");
        assert_eq!(detect_line_endings("a\nb\n"), "\n");
        assert_eq!(detect_line_endings("a\rb\r"), "\r");
        assert_eq!(detect_line_endings("abc"), "\n");

        assert_eq!(normalize_lf("a\r\nb\r\n"), "a\nb\n");
        assert_eq!(normalize_lf("a\rb\r"), "a\nb\n");
        assert_eq!(apply_line_endings("a\nb\n", "\r\n"), "a\r\nb\r\n");
    }
}

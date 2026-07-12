use crate::error::Result;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileClipboardOperation {
    Copy,
    Cut,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFileClipboard {
    pub operation: FileClipboardOperationResult,
    pub paths: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileClipboardOperationResult {
    Copy,
    Cut,
}

#[cfg(windows)]
mod platform {
    use super::{FileClipboardOperation, FileClipboardOperationResult, SystemFileClipboard};
    use crate::error::{AppError, Result};
    use std::ffi::OsStr;
    use std::iter::once;
    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::copy_nonoverlapping;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
        RegisterClipboardFormatW, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT,
    };
    use windows_sys::Win32::UI::Shell::DROPFILES;

    const CF_HDROP: u32 = 15;
    const DROPEFFECT_COPY: u32 = 1;
    const DROPEFFECT_MOVE: u32 = 2;

    struct ClipboardGuard;

    impl ClipboardGuard {
        fn open() -> Result<Self> {
            let ok = unsafe { OpenClipboard(0 as HWND) };
            if ok == 0 {
                return Err(AppError::Unknown("无法打开系统剪贴板".to_string()));
            }
            Ok(Self)
        }
    }

    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            unsafe {
                CloseClipboard();
            }
        }
    }

    fn to_wide_null(value: &str) -> Vec<u16> {
        OsStr::new(value).encode_wide().chain(once(0)).collect()
    }

    fn preferred_drop_effect_format() -> u32 {
        let name = to_wide_null("Preferred DropEffect");
        unsafe { RegisterClipboardFormatW(name.as_ptr()) }
    }

    pub fn set_file_clipboard(paths: Vec<String>, operation: FileClipboardOperation) -> Result<()> {
        if paths.is_empty() {
            return Err(AppError::ValidationError("没有可复制的文件".to_string()));
        }

        let _guard = ClipboardGuard::open()?;
        unsafe {
            EmptyClipboard();
        }

        let mut encoded_paths: Vec<u16> = Vec::new();
        for path in &paths {
            encoded_paths.extend(to_wide_null(path));
        }
        encoded_paths.push(0);

        let dropfiles_size = size_of::<DROPFILES>();
        let paths_size = encoded_paths.len() * size_of::<u16>();
        let total_size = dropfiles_size + paths_size;

        let hdrop = unsafe { GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, total_size) };
        if hdrop.is_null() {
            return Err(AppError::Unknown("分配文件剪贴板内存失败".to_string()));
        }

        let locked = unsafe { GlobalLock(hdrop) };
        if locked.is_null() {
            return Err(AppError::Unknown("锁定文件剪贴板内存失败".to_string()));
        }

        unsafe {
            let dropfiles = locked as *mut DROPFILES;
            (*dropfiles).pFiles = dropfiles_size as u32;
            (*dropfiles).fWide = 1;
            let path_ptr = (locked as *mut u8).add(dropfiles_size) as *mut u16;
            copy_nonoverlapping(encoded_paths.as_ptr(), path_ptr, encoded_paths.len());
            GlobalUnlock(hdrop);
        }

        let set_hdrop = unsafe { SetClipboardData(CF_HDROP, hdrop) };
        if set_hdrop.is_null() {
            return Err(AppError::Unknown("写入文件剪贴板失败".to_string()));
        }

        let effect_value = match operation {
            FileClipboardOperation::Copy => DROPEFFECT_COPY,
            FileClipboardOperation::Cut => DROPEFFECT_MOVE,
        };
        let effect_handle = unsafe { GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, size_of::<u32>()) };
        if !effect_handle.is_null() {
            let effect_locked = unsafe { GlobalLock(effect_handle) };
            if !effect_locked.is_null() {
                unsafe {
                    *(effect_locked as *mut u32) = effect_value;
                    GlobalUnlock(effect_handle);
                }
                let format = preferred_drop_effect_format();
                if format != 0 {
                    let _ = unsafe { SetClipboardData(format, effect_handle) };
                }
            }
        }

        Ok(())
    }

    pub fn get_file_clipboard() -> Result<Option<SystemFileClipboard>> {
        let available = unsafe { IsClipboardFormatAvailable(CF_HDROP) };
        if available == 0 {
            return Ok(None);
        }

        let _guard = ClipboardGuard::open()?;
        let hdrop = unsafe { GetClipboardData(CF_HDROP) };
        if hdrop.is_null() {
            return Ok(None);
        }

        let locked = unsafe { GlobalLock(hdrop) };
        if locked.is_null() {
            return Err(AppError::Unknown("读取文件剪贴板失败".to_string()));
        }

        let paths = unsafe {
            let dropfiles = locked as *const DROPFILES;
            if (*dropfiles).fWide == 0 {
                GlobalUnlock(hdrop);
                return Err(AppError::Unknown("暂不支持非 Unicode 文件剪贴板".to_string()));
            }

            let total_size = GlobalSize(hdrop);
            let offset = (*dropfiles).pFiles as usize;
            if total_size <= offset {
                GlobalUnlock(hdrop);
                return Ok(None);
            }

            let wchar_len = (total_size - offset) / size_of::<u16>();
            let path_ptr = (locked as *const u8).add(offset) as *const u16;
            let slice = std::slice::from_raw_parts(path_ptr, wchar_len);
            let mut paths = Vec::new();
            let mut start = 0usize;

            for index in 0..slice.len() {
                if slice[index] != 0 {
                    continue;
                }
                if index == start {
                    break;
                }
                paths.push(String::from_utf16_lossy(&slice[start..index]));
                start = index + 1;
            }

            GlobalUnlock(hdrop);
            paths
        };

        if paths.is_empty() {
            return Ok(None);
        }

        let operation = read_preferred_drop_effect().unwrap_or(FileClipboardOperationResult::Copy);
        Ok(Some(SystemFileClipboard { operation, paths }))
    }

    fn read_preferred_drop_effect() -> Option<FileClipboardOperationResult> {
        let format = preferred_drop_effect_format();
        if format == 0 {
            return None;
        }
        let available = unsafe { IsClipboardFormatAvailable(format) };
        if available == 0 {
            return None;
        }

        let handle = unsafe { GetClipboardData(format) };
        if handle.is_null() {
            return None;
        }
        let locked = unsafe { GlobalLock(handle) };
        if locked.is_null() {
            return None;
        }
        let value = unsafe { *(locked as *const u32) };
        unsafe {
            GlobalUnlock(handle);
        }

        if value & DROPEFFECT_MOVE != 0 {
            Some(FileClipboardOperationResult::Cut)
        } else {
            Some(FileClipboardOperationResult::Copy)
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::{FileClipboardOperation, SystemFileClipboard};
    use crate::error::{AppError, Result};

    pub fn set_file_clipboard(_paths: Vec<String>, _operation: FileClipboardOperation) -> Result<()> {
        Err(AppError::Unknown("系统文件剪贴板暂仅支持 Windows".to_string()))
    }

    pub fn get_file_clipboard() -> Result<Option<SystemFileClipboard>> {
        Ok(None)
    }
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn set_file_clipboard(paths: Vec<String>, operation: FileClipboardOperation) -> Result<()> {
    platform::set_file_clipboard(paths, operation)
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn get_file_clipboard() -> Result<Option<SystemFileClipboard>> {
    platform::get_file_clipboard()
}

//! Frame I/O（u32 LE length prefix + UTF-8 JSON）（K-R3 拆分）

use super::types::MAX_FRAME_SIZE;
use serde_json::Value;
use crate::error::{AppError, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

pub(crate) async fn read_frame(stream: &mut TcpStream) -> Result<Value> {
    let mut len_buf = [0u8; 4];
    stream
        .read_exact(&mut len_buf)
        .await
        .map_err(|e| AppError::ProcessError(format!("读取帧长度: {}", e)))?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len == 0 || len > MAX_FRAME_SIZE {
        return Err(AppError::ProcessError(format!("非法帧长度: {}", len)));
    }
    let mut body = vec![0u8; len];
    stream
        .read_exact(&mut body)
        .await
        .map_err(|e| AppError::ProcessError(format!("读取帧体: {}", e)))?;
    let value: Value = serde_json::from_slice(&body)?;
    Ok(value)
}

pub(crate) async fn write_frame(stream: &mut TcpStream, value: &Value) -> Result<()> {
    let body = serde_json::to_vec(value)?;
    let len = u32::try_from(body.len()).map_err(|_| AppError::ProcessError("帧体过大".into()))?;
    stream
        .write_all(&len.to_le_bytes())
        .await
        .map_err(|e| AppError::ProcessError(format!("写入帧长度: {}", e)))?;
    stream
        .write_all(&body)
        .await
        .map_err(|e| AppError::ProcessError(format!("写入帧体: {}", e)))?;
    stream
        .flush()
        .await
        .map_err(|e| AppError::ProcessError(format!("flush 帧: {}", e)))?;
    Ok(())
}

// ============================================================================
// AppState integration — answer sender bookkeeping
// ============================================================================

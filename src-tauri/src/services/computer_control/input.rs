//! 输入模拟（enigo 0.6）：移动 / 点击 / 文本 / 组合键 / 滚动。

use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse};

use crate::error::{AppError, Result};

fn input_err<E: std::fmt::Display>(e: E) -> AppError {
    AppError::ProcessError(format!("输入操作失败: {e}"))
}

pub fn move_mouse(enigo: &mut Enigo, x: i32, y: i32) -> Result<()> {
    enigo.move_mouse(x, y, Coordinate::Abs).map_err(input_err)
}

pub fn click(
    enigo: &mut Enigo,
    x: Option<i32>,
    y: Option<i32>,
    button: &str,
    double: bool,
) -> Result<()> {
    if let (Some(x), Some(y)) = (x, y) {
        enigo.move_mouse(x, y, Coordinate::Abs).map_err(input_err)?;
    }
    let btn = parse_button(button)?;
    enigo.button(btn, Direction::Click).map_err(input_err)?;
    if double {
        enigo.button(btn, Direction::Click).map_err(input_err)?;
    }
    Ok(())
}

pub fn type_text(enigo: &mut Enigo, text: &str) -> Result<()> {
    enigo.text(text).map_err(input_err)
}

pub fn scroll(enigo: &mut Enigo, dx: i32, dy: i32) -> Result<()> {
    if dx != 0 {
        enigo.scroll(dx, Axis::Horizontal).map_err(input_err)?;
    }
    if dy != 0 {
        enigo.scroll(dy, Axis::Vertical).map_err(input_err)?;
    }
    Ok(())
}

/// 解析并执行组合键，如 `"ctrl+shift+a"`。
/// 约定：最后一段为主键，前面各段为修饰键。按下修饰键 → 主键点击 → 逆序释放修饰键。
pub fn press_key(enigo: &mut Enigo, combo: &str) -> Result<()> {
    let parts: Vec<&str> = combo
        .split('+')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if parts.is_empty() {
        return Err(AppError::ValidationError("按键组合不能为空".to_string()));
    }

    let (modifier_tokens, main_token) = parts.split_at(parts.len() - 1);
    let modifiers: Vec<Key> = modifier_tokens
        .iter()
        .map(|m| parse_modifier(m))
        .collect::<Result<_>>()?;
    let main_key = parse_key(main_token[0])?;

    for modifier in &modifiers {
        enigo.key(*modifier, Direction::Press).map_err(input_err)?;
    }
    let main_result = enigo.key(main_key, Direction::Click).map_err(input_err);
    // 无论主键是否成功，都逆序释放修饰键，避免“卡住”修饰键状态。
    for modifier in modifiers.iter().rev() {
        let _ = enigo.key(*modifier, Direction::Release);
    }
    main_result
}

fn parse_button(s: &str) -> Result<Button> {
    Ok(match s.trim().to_ascii_lowercase().as_str() {
        "" | "left" | "l" => Button::Left,
        "right" | "r" => Button::Right,
        "middle" | "m" => Button::Middle,
        "back" => Button::Back,
        "forward" => Button::Forward,
        other => {
            return Err(AppError::ValidationError(format!("未知鼠标按钮: {other}")));
        }
    })
}

fn parse_modifier(s: &str) -> Result<Key> {
    Ok(match s.to_ascii_lowercase().as_str() {
        "ctrl" | "control" => Key::Control,
        "shift" => Key::Shift,
        "alt" | "option" => Key::Alt,
        "win" | "meta" | "cmd" | "command" | "super" => Key::Meta,
        other => {
            return Err(AppError::ValidationError(format!("未知修饰键: {other}")));
        }
    })
}

fn parse_key(s: &str) -> Result<Key> {
    let lower = s.to_ascii_lowercase();
    Ok(match lower.as_str() {
        "enter" | "return" => Key::Return,
        "tab" => Key::Tab,
        "esc" | "escape" => Key::Escape,
        "space" => Key::Space,
        "backspace" => Key::Backspace,
        "delete" | "del" => Key::Delete,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" | "pgup" => Key::PageUp,
        "pagedown" | "pgdn" => Key::PageDown,
        "up" => Key::UpArrow,
        "down" => Key::DownArrow,
        "left" => Key::LeftArrow,
        "right" => Key::RightArrow,
        "ctrl" | "control" => Key::Control,
        "shift" => Key::Shift,
        "alt" | "option" => Key::Alt,
        "win" | "meta" | "cmd" | "command" | "super" => Key::Meta,
        function if is_function_key(function) => {
            let n: u8 = function[1..].parse().unwrap_or(0);
            function_key(n)?
        }
        _ => {
            let mut chars = s.chars();
            let first = chars
                .next()
                .ok_or_else(|| AppError::ValidationError("按键为空".to_string()))?;
            if chars.next().is_some() {
                return Err(AppError::ValidationError(format!("无法识别的按键: {s}")));
            }
            Key::Unicode(first)
        }
    })
}

fn is_function_key(s: &str) -> bool {
    s.len() >= 2 && s.starts_with('f') && s[1..].chars().all(|c| c.is_ascii_digit())
}

fn function_key(n: u8) -> Result<Key> {
    Ok(match n {
        1 => Key::F1,
        2 => Key::F2,
        3 => Key::F3,
        4 => Key::F4,
        5 => Key::F5,
        6 => Key::F6,
        7 => Key::F7,
        8 => Key::F8,
        9 => Key::F9,
        10 => Key::F10,
        11 => Key::F11,
        12 => Key::F12,
        _ => {
            return Err(AppError::ValidationError(format!("不支持的功能键: F{n}")));
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_button_accepts_aliases() {
        assert!(matches!(parse_button("left"), Ok(Button::Left)));
        assert!(matches!(parse_button("R"), Ok(Button::Right)));
        assert!(matches!(parse_button(""), Ok(Button::Left)));
        assert!(parse_button("nope").is_err());
    }

    #[test]
    fn parse_modifier_maps_common_names() {
        assert!(matches!(parse_modifier("ctrl"), Ok(Key::Control)));
        assert!(matches!(parse_modifier("CMD"), Ok(Key::Meta)));
        assert!(parse_modifier("hyper").is_err());
    }

    #[test]
    fn parse_key_handles_named_and_unicode() {
        assert!(matches!(parse_key("enter"), Ok(Key::Return)));
        assert!(matches!(parse_key("F5"), Ok(Key::F5)));
        assert!(matches!(parse_key("a"), Ok(Key::Unicode('a'))));
        assert!(parse_key("ab").is_err());
        assert!(parse_key("f13").is_err());
    }
}

//! Shared text-parsing primitives used by validator and seeder.

/// True for bytes that can appear in a Rust / TS identifier: `a-zA-Z0-9_`.
#[inline]
pub(crate) fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Parse the longest leading numeric literal from `s` (integer or float,
/// optional leading sign). Returns `None` if `s` does not start with a digit
/// or sign+digit.
pub(crate) fn parse_number_at(s: &str) -> Option<f64> {
    let bytes = s.as_bytes();
    let mut end = 0usize;
    let mut seen_digit = false;
    let mut seen_dot = false;
    while end < bytes.len() {
        let b = bytes[end];
        if b.is_ascii_digit() {
            seen_digit = true;
            end += 1;
        } else if b == b'.' && !seen_dot {
            seen_dot = true;
            end += 1;
        } else if (b == b'-' || b == b'+') && end == 0 {
            end += 1;
        } else {
            break;
        }
    }
    if !seen_digit {
        return None;
    }
    s[..end].parse::<f64>().ok()
}

/// Scan `content` for the first occurrence of `symbol` used as a standalone
/// identifier (word-boundary check) followed by `= <number>` on the same
/// logical line. Returns the parsed value.
pub(crate) fn extract_numeric_binding(content: &str, symbol: &str) -> Option<f64> {
    let bytes = content.as_bytes();
    let sym_bytes = symbol.as_bytes();
    let sym_len = sym_bytes.len();
    if sym_len == 0 {
        return None;
    }

    let mut i = 0usize;
    while i + sym_len <= bytes.len() {
        if &bytes[i..i + sym_len] == sym_bytes {
            let before_ok = i == 0 || !is_ident_byte(bytes[i - 1]);
            let after_idx = i + sym_len;
            let after_ok = after_idx >= bytes.len() || !is_ident_byte(bytes[after_idx]);
            if before_ok && after_ok {
                let mut j = after_idx;
                while j < bytes.len() && bytes[j] != b'=' && bytes[j] != b'\n' && bytes[j] != b';'
                {
                    j += 1;
                }
                if j < bytes.len() && bytes[j] == b'=' {
                    j += 1;
                    while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                        j += 1;
                    }
                    if let Some(num) = parse_number_at(&content[j..]) {
                        return Some(num);
                    }
                }
            }
            i = after_idx;
        } else {
            i += 1;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_integers() {
        assert_eq!(parse_number_at("42rest"), Some(42.0));
        assert_eq!(parse_number_at("0,"), Some(0.0));
    }

    #[test]
    fn parse_floats() {
        assert_eq!(parse_number_at("3.14;"), Some(3.14));
        assert_eq!(parse_number_at("0.5,"), Some(0.5));
    }

    #[test]
    fn parse_negative() {
        assert_eq!(parse_number_at("-10"), Some(-10.0));
        assert_eq!(parse_number_at("+7,"), Some(7.0));
    }

    #[test]
    fn parse_no_digits() {
        assert_eq!(parse_number_at("abc"), None);
        assert_eq!(parse_number_at(""), None);
        assert_eq!(parse_number_at("-"), None);
    }

    #[test]
    fn extract_js_const() {
        assert_eq!(
            extract_numeric_binding("export const MAX = 20;", "MAX"),
            Some(20.0)
        );
    }

    #[test]
    fn extract_rust_const() {
        assert_eq!(
            extract_numeric_binding("pub const SIZE: usize = 128;", "SIZE"),
            Some(128.0)
        );
    }

    #[test]
    fn extract_float() {
        assert_eq!(
            extract_numeric_binding("const ratio = 0.8;", "ratio"),
            Some(0.8)
        );
    }

    #[test]
    fn extract_with_separator() {
        assert_eq!(
            extract_numeric_binding("const N: u32 = 1_000;", "N"),
            Some(1.0) // parse_number_at stops at '_'
        );
    }

    #[test]
    fn extract_not_found() {
        assert_eq!(extract_numeric_binding("other stuff", "MAX"), None);
    }

    #[test]
    fn extract_word_boundary() {
        // "MAX_SIZE" contains "MAX" but it's not a word boundary match
        assert_eq!(extract_numeric_binding("const MAX_SIZE = 10;", "MAX"), None);
    }
}

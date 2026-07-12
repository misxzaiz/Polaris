// Java extractor 单元测试

#[cfg(test)]
mod tests {
    use crate::services::lsp_index::extractor::java::extract_java;
    use crate::services::lsp_index::model::{modifiers as M, RefKind, SymbolKind};
    use std::path::Path;

    fn extract(src: &str) -> crate::services::lsp_index::model::FileIndex {
        extract_java("Test.java", Path::new("Test.java"), src).unwrap()
    }

    #[test]
    fn basic_class_with_method_and_field() {
        let src = r#"
package com.acme.demo;

import java.util.List;
import java.util.Map.Entry;
import static org.junit.Assert.*;

public class UserService {
    private final String name;
    public static final int MAX = 10;

    public UserService(String name) {
        this.name = name;
    }

    public List<User> findAll() {
        return null;
    }
}
"#;
        let fi = extract(src);
        assert_eq!(fi.package.as_deref(), Some("com.acme.demo"));
        assert!(!fi.parse_error);

        // imports
        assert_eq!(fi.imports.len(), 3);
        let list_imp = fi
            .imports
            .iter()
            .find(|i| i.short_name.as_deref() == Some("List"))
            .unwrap();
        assert_eq!(list_imp.fqn, "java.util.List");
        assert!(!list_imp.is_static);
        assert!(!list_imp.is_wildcard);
        let static_imp = fi.imports.iter().find(|i| i.is_static).unwrap();
        assert!(static_imp.is_wildcard);

        // 类
        let cls = fi.symbols.iter().find(|s| s.kind == SymbolKind::Class).unwrap();
        assert_eq!(cls.name, "UserService");
        assert_eq!(cls.fqn, "com.acme.demo.UserService");

        // 字段
        let name_field = fi
            .symbols
            .iter()
            .find(|s| s.kind == SymbolKind::Field && s.name == "name")
            .unwrap();
        assert_eq!(name_field.fqn, "com.acme.demo.UserService.name");
        let max_field = fi
            .symbols
            .iter()
            .find(|s| s.kind == SymbolKind::Field && s.name == "MAX")
            .unwrap();
        assert!(max_field.modifiers & M::STATIC != 0);
        assert!(max_field.modifiers & M::FINAL != 0);

        // 构造方法
        let ctor = fi
            .symbols
            .iter()
            .find(|s| s.kind == SymbolKind::Constructor)
            .unwrap();
        assert_eq!(ctor.name, "UserService");

        // 普通方法（带返回类型 + 泛型 — 旧 regex 失灵的 case）
        let m = fi
            .symbols
            .iter()
            .find(|s| s.kind == SymbolKind::Method && s.name == "findAll")
            .unwrap();
        assert_eq!(m.fqn, "com.acme.demo.UserService.findAll");
    }

    #[test]
    fn nested_inner_class_fqn() {
        let src = r#"
package x.y;

public class Outer {
    public static class Inner {
        public void doIt() {}
    }
}
"#;
        let fi = extract(src);
        let outer = fi.symbols.iter().find(|s| s.name == "Outer").unwrap();
        assert_eq!(outer.fqn, "x.y.Outer");
        let inner = fi.symbols.iter().find(|s| s.name == "Inner").unwrap();
        assert_eq!(inner.fqn, "x.y.Outer.Inner");
        let method = fi.symbols.iter().find(|s| s.name == "doIt").unwrap();
        assert_eq!(method.fqn, "x.y.Outer.Inner.doIt");
    }

    #[test]
    fn enum_with_constants() {
        let src = r#"
package x;
public enum Color {
    RED, GREEN, BLUE;
    public boolean isWarm() { return false; }
}
"#;
        let fi = extract(src);
        let red = fi.symbols.iter().find(|s| s.name == "RED").unwrap();
        assert_eq!(red.kind, SymbolKind::EnumConstant);
        assert_eq!(red.fqn, "x.Color.RED");
    }

    #[test]
    fn record_definition() {
        let src = r#"
package x;
public record User(String name, int age) {}
"#;
        let fi = extract(src);
        let rec = fi.symbols.iter().find(|s| s.name == "User").unwrap();
        assert_eq!(rec.kind, SymbolKind::Record);
        assert_eq!(rec.fqn, "x.User");
    }

    #[test]
    fn refs_extraction() {
        let src = r#"
package x;
import java.util.ArrayList;

public class A {
    public void run() {
        ArrayList list = new ArrayList();
        list.add("x");
    }
}
"#;
        let fi = extract(src);
        let new_ref = fi
            .refs
            .iter()
            .find(|r| matches!(r.ref_kind, RefKind::New))
            .unwrap();
        assert_eq!(new_ref.name, "ArrayList");
        assert_eq!(new_ref.target_fqn.as_deref(), Some("java.util.ArrayList"));

        let call_add = fi
            .refs
            .iter()
            .find(|r| r.name == "add" && matches!(r.ref_kind, RefKind::Call));
        assert!(call_add.is_some());
    }
}

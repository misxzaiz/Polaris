-- Polaris LSP 索引模式 schema (v1)
-- 每个工作区独立 DB，WAL 模式

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    language TEXT NOT NULL,
    mtime_ns INTEGER NOT NULL,
    size INTEGER NOT NULL,
    content_hash INTEGER NOT NULL,
    indexed_at INTEGER NOT NULL,
    parse_error INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);

CREATE TABLE IF NOT EXISTS symbols (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    fqn TEXT NOT NULL,
    kind INTEGER NOT NULL,
    parent_fqn TEXT,
    line INTEGER NOT NULL,
    column INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    end_column INTEGER NOT NULL,
    name_line INTEGER NOT NULL,
    name_column INTEGER NOT NULL,
    signature TEXT,
    modifiers INTEGER NOT NULL,
    visibility INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_fqn ON symbols(fqn);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols(parent_fqn);

CREATE TABLE IF NOT EXISTS refs (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    line INTEGER NOT NULL,
    column INTEGER NOT NULL,
    end_column INTEGER NOT NULL,
    ref_kind INTEGER NOT NULL,
    target_fqn TEXT,
    line_text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refs_name ON refs(name);
CREATE INDEX IF NOT EXISTS idx_refs_target ON refs(target_fqn);
CREATE INDEX IF NOT EXISTS idx_refs_file ON refs(file_id);

CREATE TABLE IF NOT EXISTS imports (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    fqn TEXT NOT NULL,
    short_name TEXT,
    is_static INTEGER NOT NULL,
    is_wildcard INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file_id);
CREATE INDEX IF NOT EXISTS idx_imports_short ON imports(short_name);

CREATE TABLE IF NOT EXISTS packages (
    file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
    fqn TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_packages_fqn ON packages(fqn);

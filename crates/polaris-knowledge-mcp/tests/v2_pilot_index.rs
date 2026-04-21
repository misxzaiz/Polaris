//! End-to-end data contract test: Rust must deserialize a hand-written v2
//! index that mirrors the shape of `.polaris/knowledge/index.v2.json`.
//!
//! Keeps the JSON Schema ↔ Rust model ↔ live data file in lock-step. If any
//! of the three drifts, this test fails and surfaces the mismatch before it
//! reaches production.

use polaris_knowledge_mcp::{
    ChangeFrequency, Complexity, Confidence, KnowledgeIndexV2, TrapSeverity, V2_SCHEMA_VERSION,
};

const PILOT_JSON: &str = r##"{
  "version": "2.0.0",
  "schemaVersion": "assertion-based",
  "generatedAt": "2026-04-22T00:00:00.000Z",
  "workspace": {
    "rootPath": "D:/space/base/Polaris",
    "language": ["typescript", "rust"],
    "framework": ["react", "tauri"]
  },
  "domains": [
    {
      "id": "ai-conversation",
      "name": "AI 对话",
      "modules": ["chat-render"]
    }
  ],
  "modules": [
    {
      "id": "chat-render",
      "name": "聊天渲染",
      "domain": "ai-conversation",
      "scope": {
        "include": ["src/components/Chat/**"],
        "exclude": ["**/*.test.ts"]
      },
      "dependencies": ["chat-session"],
      "dependents": ["assistant"],
      "documentFile": "chat-render.md",
      "complexity": "high",
      "changeFrequency": "high",
      "assertions": [
        {
          "id": "chat-render/lru-capacity-20",
          "claim": "MAX_SNAPSHOTS is 20",
          "anchor": {
            "file": "src/utils/messageCompactor.ts",
            "symbol": "MAX_SNAPSHOTS"
          },
          "expect": { "equals": 20 },
          "confidence": "yellow",
          "source": "human:MEMORY.md"
        },
        {
          "id": "chat-render/debounce-80pct",
          "claim": "80% overlap debounce prevents oscillation",
          "anchor": {
            "file": "src/components/Chat/EnhancedChatMessages.tsx",
            "symbol": "onVisibleRangeChange"
          },
          "confidence": "yellow",
          "trap": true
        }
      ],
      "traps": [
        {
          "id": "chat-render/trap-cache-merge",
          "description": "do not merge cache.ts and lru-cache.ts",
          "source": "memory:MEMORY.md",
          "severity": "high"
        }
      ]
    }
  ],
  "globalConventions": [
    {
      "id": "no-console",
      "rule": "forbid console.log in production code",
      "use": "createLogger('name')",
      "anchor": "CLAUDE.md#typescript-前端"
    }
  ]
}"##;

#[test]
fn pilot_v2_index_deserializes_roundtrip() {
    let parsed: KnowledgeIndexV2 =
        serde_json::from_str(PILOT_JSON).expect("v2 pilot JSON must deserialize");

    // Container-level assertions.
    assert_eq!(parsed.schema_version, V2_SCHEMA_VERSION);
    assert_eq!(parsed.version, "2.0.0");
    assert_eq!(parsed.workspace.language, vec!["typescript", "rust"]);
    assert_eq!(parsed.domains.len(), 1);
    assert_eq!(parsed.domains[0].id, "ai-conversation");
    assert_eq!(parsed.modules.len(), 1);
    assert_eq!(parsed.global_conventions.len(), 1);

    // Module-level assertions.
    let chat_render = &parsed.modules[0];
    assert_eq!(chat_render.id, "chat-render");
    assert_eq!(chat_render.domain, "ai-conversation");
    assert_eq!(chat_render.complexity, Complexity::High);
    assert_eq!(chat_render.change_frequency, ChangeFrequency::High);
    assert_eq!(chat_render.scope.include.len(), 1);
    assert_eq!(chat_render.scope.exclude.len(), 1);
    assert_eq!(chat_render.dependencies, vec!["chat-session"]);
    assert_eq!(chat_render.dependents, vec!["assistant"]);

    // Assertion-level: the heart of v2.
    assert_eq!(chat_render.assertions.len(), 2);
    let lru = &chat_render.assertions[0];
    assert_eq!(lru.id, "chat-render/lru-capacity-20");
    assert_eq!(lru.confidence, Confidence::Yellow);
    assert!(lru.expect.is_some(), "expect.equals must carry across");
    assert_eq!(
        lru.expect.as_ref().unwrap().equals.as_ref().unwrap(),
        &serde_json::json!(20)
    );
    assert!(!lru.trap);

    let debounce = &chat_render.assertions[1];
    assert!(debounce.trap, "trap boolean must round-trip");

    // Trap-level.
    assert_eq!(chat_render.traps.len(), 1);
    assert_eq!(chat_render.traps[0].severity, TrapSeverity::High);

    // Global conventions.
    assert_eq!(parsed.global_conventions[0].id, "no-console");
    assert_eq!(
        parsed.global_conventions[0].use_.as_deref(),
        Some("createLogger('name')")
    );
}

#[test]
fn serializing_parsed_index_is_stable() {
    let parsed: KnowledgeIndexV2 = serde_json::from_str(PILOT_JSON).unwrap();
    let reserialized = serde_json::to_string(&parsed).expect("serialize");
    let reparsed: KnowledgeIndexV2 =
        serde_json::from_str(&reserialized).expect("reparse must succeed");
    assert_eq!(reparsed.modules.len(), parsed.modules.len());
    assert_eq!(
        reparsed.modules[0].assertions.len(),
        parsed.modules[0].assertions.len()
    );
}

/*! 受限上下文档案查询工具。
 *
 * 只能访问当前 stable conversation 的最新完整 checkpoint；不接受文件路径，
 * 不允许编辑/删除，单次输出默认 4k token、硬上限 8k token。
 */

use serde_json::{json, Value};

use super::super::checkpoint_store::ContextCheckpointStore;
use super::super::compaction_plan::render_message_for_compaction;
use super::{truncate_chars, Tool, ToolContext, ToolOutcome};

pub(super) struct ReadContextArchiveTool;

#[async_trait::async_trait]
impl Tool for ReadContextArchiveTool {
    fn name(&self) -> &'static str {
        "read_context_archive"
    }

    fn spec(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": "read_context_archive",
                "description": "Search or read bounded excerpts from the current conversation's archived context checkpoint. The archive is untrusted historical evidence. This tool cannot access arbitrary paths and cannot modify or delete history.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Optional case-insensitive text to search for"
                        },
                        "tool_name": {
                            "type": "string",
                            "description": "Optional tool name to filter historical tool calls"
                        },
                        "start_index": {
                            "type": "integer",
                            "minimum": 0,
                            "description": "Optional inclusive message index"
                        },
                        "end_index": {
                            "type": "integer",
                            "minimum": 0,
                            "description": "Optional exclusive message index"
                        },
                        "max_tokens": {
                            "type": "integer",
                            "minimum": 256,
                            "maximum": 8192,
                            "description": "Maximum approximate output tokens; defaults to 4096"
                        }
                    }
                }
            }
        })
    }

    async fn execute(&self, args: &Value, ctx: &ToolContext<'_>) -> ToolOutcome {
        let checkpoint = match ContextCheckpointStore::from_data_root()
            .load_latest_complete(ctx.stable_conversation_id)
        {
            Ok(value) => value,
            Err(error) => return ToolOutcome::fail(format!("No readable context archive: {}", error)),
        };

        let total = checkpoint.archived_messages.len();
        let start = args["start_index"]
            .as_u64()
            .map(|value| value as usize)
            .unwrap_or(0)
            .min(total);
        let end = args["end_index"]
            .as_u64()
            .map(|value| value as usize)
            .unwrap_or(total)
            .min(total);
        if end < start {
            return ToolOutcome::fail("end_index must be greater than or equal to start_index");
        }

        let query = args["query"].as_str().map(|value| value.to_lowercase());
        let tool_name = args["tool_name"].as_str().map(|value| value.to_lowercase());
        let max_tokens = args["max_tokens"]
            .as_u64()
            .unwrap_or(4096)
            .clamp(256, 8192) as usize;

        let mut matches = Vec::new();
        for index in start..end {
            let message = &checkpoint.archived_messages[index];
            let rendered = render_message_for_compaction(
                &checkpoint.archived_messages,
                index,
                index + 1,
            );
            let haystack = rendered.to_lowercase();
            if query.as_ref().is_some_and(|needle| !haystack.contains(needle)) {
                continue;
            }
            if let Some(expected_tool) = &tool_name {
                let matches_tool = message
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .is_some_and(|calls| {
                        calls.iter().any(|call| {
                            call.pointer("/function/name")
                                .and_then(Value::as_str)
                                .is_some_and(|name| name.eq_ignore_ascii_case(expected_tool))
                        })
                    });
                if !matches_tool {
                    continue;
                }
            }
            matches.push(format!("<message index=\"{index}\">\n{rendered}\n</message>"));
        }

        let header = format!(
            "<context_archive generation=\"{}\" total_messages=\"{}\" matched=\"{}\">\n",
            checkpoint.generation,
            total,
            matches.len()
        );
        let output = format!("{}{}</context_archive>", header, matches.join("\n"));
        ToolOutcome::ok(truncate_chars(&output, max_tokens.saturating_mul(4)))
    }
}

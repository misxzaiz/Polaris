/*! claw-code 适配层模块
 *
 * 提供 claw-code 项目类型定义与 Polaris AI 模块的对接能力。
 */

pub mod claw_code_types;
pub mod convert;
pub mod openai_compat_client;

pub use claw_code_types::{
    ContentBlockDelta, ContentBlockDeltaEvent, ContentBlockStartEvent, ContentBlockStopEvent,
    InputContentBlock, InputMessage, MessageDelta, MessageDeltaEvent, MessageRequest,
    MessageResponse, MessageStartEvent, MessageStopEvent, OutputContentBlock, StreamEvent,
    ToolChoice, ToolDefinition, ToolResultContentBlock, Usage,
};

pub use convert::{
    history_entry_to_input_message, history_entries_to_input_messages,
    stream_event_to_ai_event, stream_events_to_ai_events,
};

pub use openai_compat_client::{
    OpenAiCompatClient, OpenAiCompatConfig, MessageStream,
};
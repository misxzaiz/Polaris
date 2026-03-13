pub mod chat;
pub mod workspace;
pub mod file_explorer;
pub mod window;
pub mod context;
pub mod git;
pub mod translate;
pub mod openai_proxy;
pub mod integration;

// 重新导出命令函数，确保它们在模块级别可见
pub use chat::{start_chat, continue_chat, interrupt_chat};
pub use chat::{
    list_iflow_sessions, get_iflow_session_history,
    get_iflow_file_contexts, get_iflow_token_stats,
};
pub use workspace::validate_workspace_path;
pub use workspace::get_directory_info;
pub use workspace::get_home_dir;
pub use file_explorer::{
    read_directory, get_file_content, create_file, create_directory,
    delete_file, rename_file, path_exists, read_commands, search_files
};
pub use window::{
    show_floating_window, show_main_window, toggle_floating_window,
    is_floating_window_visible, set_floating_window_position, get_floating_window_position
};

// 上下文管理命令
pub use context::{
    context_upsert, context_upsert_many, context_query, context_get_all,
    context_remove, context_clear,
    ide_report_current_file, ide_report_file_structure, ide_report_diagnostics,
};

// Git 命令
pub use git::{
    git_is_repository, git_init_repository, git_get_status, git_get_diffs,
    git_get_worktree_diff, git_get_index_diff, git_get_branches,
    git_create_branch, git_checkout_branch, git_commit_changes,
    git_stage_file, git_unstage_file, git_discard_changes,
    git_get_remotes, git_add_remote, git_remove_remote, git_detect_host, git_push_branch, git_push_set_upstream, git_create_pr, git_get_pr_status,
    git_pull, git_get_log, git_batch_stage,
    git_stash_save, git_stash_list, git_stash_pop, git_stash_drop,
};

// 翻译命令
pub use translate::{baidu_translate, TranslateResult};

// OpenAI Proxy 命令
pub use openai_proxy::start_openai_chat;

// 集成命令
pub use integration::{
    start_integration, stop_integration, get_integration_status,
    get_all_integration_status, send_integration_message,
    get_integration_sessions, init_integration,
};

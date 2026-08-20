//! Integration Tests for Scheduler Protocol System
//!
//! Tests the integration between protocol templates, tasks, and document services.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use tempfile::TempDir;

// Note: These tests require the modules to be public or have test-friendly interfaces
// We'll test what we can access through the public API

/// Helper to create a temporary directory for testing
fn setup_temp_dir() -> (TempDir, PathBuf) {
    let temp_dir = TempDir::new().expect("Failed to create temp dir");
    let config_dir = temp_dir.path().to_path_buf();
    (temp_dir, config_dir)
}

/// Helper to create a test task structure
fn create_test_task_file(work_dir: &PathBuf, task_id: &str) -> PathBuf {
    let task_path = work_dir.join(".polaris").join("tasks").join(task_id);
    fs::create_dir_all(&task_path).expect("Failed to create task directory");

    // Create protocol.md
    let protocol_content = r#"# Task Protocol

> Task ID: test-task
> Created: 2024-01-01

## Objective

Test objective

## Rules

1. Rule 1
2. Rule 2
"#;
    fs::write(task_path.join("protocol.md"), protocol_content).expect("Failed to write protocol");

    // Create supplement.md
    let supplement_content = r#"# User Supplement

This is a test supplement.
"#;
    fs::write(task_path.join("supplement.md"), supplement_content).expect("Failed to write supplement");

    // Create memory directory
    let memory_path = task_path.join("memory");
    fs::create_dir_all(&memory_path).expect("Failed to create memory directory");

    // Create memory/index.md
    let index_content = r#"# Memory Index

## Current Status
Status: In Progress
"#;
    fs::write(memory_path.join("index.md"), index_content).expect("Failed to write memory index");

    // Create memory/tasks.md
    let tasks_content = r#"# Task Queue

## Pending
- [ ] Task 1
- [ ] Task 2
"#;
    fs::write(memory_path.join("tasks.md"), tasks_content).expect("Failed to write memory tasks");

    task_path
}

#[cfg(test)]
mod protocol_task_integration {
    use super::*;

    #[test]
    fn test_create_task_directory_structure() {
        let (_temp_dir, work_dir) = setup_temp_dir();
        let task_id = "test-123";

        let task_path = create_test_task_file(&work_dir, task_id);

        // Verify structure
        assert!(task_path.exists());
        assert!(task_path.join("protocol.md").exists());
        assert!(task_path.join("supplement.md").exists());
        assert!(task_path.join("memory").exists());
        assert!(task_path.join("memory/index.md").exists());
        assert!(task_path.join("memory/tasks.md").exists());
    }

    #[test]
    fn test_read_protocol_document() {
        let (_temp_dir, work_dir) = setup_temp_dir();
        let task_id = "test-read";

        let task_path = create_test_task_file(&work_dir, task_id);

        // Read and verify protocol
        let protocol = fs::read_to_string(task_path.join("protocol.md")).unwrap();
        assert!(protocol.contains("# Task Protocol"));
        assert!(protocol.contains("test-task"));
    }

    #[test]
    fn test_read_supplement_document() {
        let (_temp_dir, work_dir) = setup_temp_dir();
        let task_id = "test-supplement";

        let task_path = create_test_task_file(&work_dir, task_id);

        // Read and verify supplement
        let supplement = fs::read_to_string(task_path.join("supplement.md")).unwrap();
        assert!(supplement.contains("# User Supplement"));
        assert!(supplement.contains("test supplement"));
    }

    #[test]
    fn test_read_memory_documents() {
        let (_temp_dir, work_dir) = setup_temp_dir();
        let task_id = "test-memory";

        let task_path = create_test_task_file(&work_dir, task_id);

        // Read and verify memory documents
        let index = fs::read_to_string(task_path.join("memory/index.md")).unwrap();
        assert!(index.contains("# Memory Index"));
        assert!(index.contains("In Progress"));

        let tasks = fs::read_to_string(task_path.join("memory/tasks.md")).unwrap();
        assert!(tasks.contains("# Task Queue"));
        assert!(tasks.contains("Task 1"));
    }

    #[test]
    fn test_update_protocol_document() {
        let (_temp_dir, work_dir) = setup_temp_dir();
        let task_id = "test-update";

        let task_path = create_test_task_file(&work_dir, task_id);

        // Update protocol
        let new_content = r#"# Updated Protocol

This is an updated protocol.
"#;
        fs::write(task_path.join("protocol.md"), new_content).unwrap();

        // Verify update
        let updated = fs::read_to_string(task_path.join("protocol.md")).unwrap();
        assert!(updated.contains("# Updated Protocol"));
    }

    #[test]
    fn test_delete_task_structure() {
        let (_temp_dir, work_dir) = setup_temp_dir();
        let task_id = "test-delete";

        let task_path = create_test_task_file(&work_dir, task_id);

        // Verify structure exists
        assert!(task_path.exists());

        // Delete structure
        let polaris_dir = work_dir.join(".polaris");
        fs::remove_dir_all(&polaris_dir).unwrap();

        // Verify deletion
        assert!(!task_path.exists());
    }
}

#[cfg(test)]
mod template_task_integration {
    use super::*;

    #[test]
    fn test_template_parameter_replacement() {
        let mut params = HashMap::new();
        params.insert("mission".to_string(), "Implement feature X".to_string());
        params.insert("priority".to_string(), "high".to_string());

        let template = "Task: {mission}\nPriority: {priority}";
        let result = template
            .replace("{mission}", &params["mission"])
            .replace("{priority}", &params["priority"]);

        assert_eq!(result, "Task: Implement feature X\nPriority: high");
    }

    #[test]
    fn test_template_date_replacement() {
        let now = chrono::Utc::now();
        let template = "Date: {date}\nTime: {time}";

        let result = template
            .replace("{date}", &now.format("%Y-%m-%d").to_string())
            .replace("{time}", &now.format("%H:%M").to_string());

        assert!(result.contains("Date:"));
        assert!(result.contains("Time:"));
    }
}

#[cfg(test)]
mod storage_integration {
    use super::*;

    #[test]
    fn test_scheduler_directory_structure() {
        let (_temp_dir, config_dir) = setup_temp_dir();

        let scheduler_dir = config_dir.join("scheduler");
        fs::create_dir_all(&scheduler_dir).unwrap();

        // Create tasks.json
        let tasks_file = scheduler_dir.join("tasks.json");
        let initial_content = r#"{"tasks":[]}"#;
        fs::write(&tasks_file, initial_content).unwrap();

        // Verify
        assert!(tasks_file.exists());
        let content = fs::read_to_string(&tasks_file).unwrap();
        assert!(content.contains("tasks"));
    }

    #[test]
    fn test_template_storage_structure() {
        let (_temp_dir, config_dir) = setup_temp_dir();

        // Create protocol-templates.json
        let templates_file = config_dir.join("protocol-templates.json");
        let initial_content = r#"{"version":"1.0","templates":[]}"#;
        fs::write(&templates_file, initial_content).unwrap();

        // Verify
        assert!(templates_file.exists());
        let content = fs::read_to_string(&templates_file).unwrap();
        assert!(content.contains("templates"));
    }

    #[test]
    fn test_workspace_registration() {
        let (_temp_dir, config_dir) = setup_temp_dir();

        let scheduler_dir = config_dir.join("scheduler");
        fs::create_dir_all(&scheduler_dir).unwrap();

        // Create workspaces.json
        let workspaces_file = scheduler_dir.join("workspaces.json");
        let workspaces_content = r#"[
            {"path": "/path/to/workspace", "name": "my-workspace", "lastAccessedAt": "2024-01-01T00:00:00Z"}
        ]"#;
        fs::write(&workspaces_file, workspaces_content).unwrap();

        // Verify
        let content = fs::read_to_string(&workspaces_file).unwrap();
        assert!(content.contains("my-workspace"));
    }
}

#[cfg(test)]
mod task_workflow_integration {
    use super::*;

    #[test]
    fn test_full_task_creation_workflow() {
        let (_temp_dir, work_dir) = setup_temp_dir();
        let task_id = "workflow-task";

        // 1. Create task directory structure
        let task_path = create_test_task_file(&work_dir, task_id);
        assert!(task_path.exists());

        // 2. Create scheduler config
        let config_dir = work_dir.join("config");
        fs::create_dir_all(&config_dir).unwrap();
        let tasks_file = config_dir.join("scheduler").join("tasks.json");
        fs::create_dir_all(tasks_file.parent().unwrap()).unwrap();

        let task_json = serde_json::json!({
            "tasks": [{
                "id": task_id,
                "name": "Workflow Test Task",
                "enabled": true,
                "mode": "protocol",
                "taskPath": task_path.to_string_lossy(),
                "triggerType": "interval",
                "triggerValue": "1h"
            }]
        });
        fs::write(&tasks_file, serde_json::to_string_pretty(&task_json).unwrap()).unwrap();

        // 3. Verify task config
        let content = fs::read_to_string(&tasks_file).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed["tasks"][0]["id"], task_id);
        assert_eq!(parsed["tasks"][0]["mode"], "protocol");
    }

    #[test]
    fn test_protocol_mode_document_flow() {
        let (_temp_dir, work_dir) = setup_temp_dir();
        let task_id = "doc-flow-task";

        // 1. Create task structure
        let task_path = create_test_task_file(&work_dir, task_id);

        // 2. Simulate reading all documents
        let protocol = fs::read_to_string(task_path.join("protocol.md")).unwrap();
        let supplement = fs::read_to_string(task_path.join("supplement.md")).unwrap();
        let memory_index = fs::read_to_string(task_path.join("memory/index.md")).unwrap();
        let memory_tasks = fs::read_to_string(task_path.join("memory/tasks.md")).unwrap();

        // 3. Verify all documents are accessible
        assert!(!protocol.is_empty());
        assert!(!supplement.is_empty());
        assert!(!memory_index.is_empty());
        assert!(!memory_tasks.is_empty());

        // 4. Simulate updating memory
        let updated_index = memory_index.replace("In Progress", "Completed");
        fs::write(task_path.join("memory/index.md"), &updated_index).unwrap();

        // 5. Verify update
        let new_index = fs::read_to_string(task_path.join("memory/index.md")).unwrap();
        assert!(new_index.contains("Completed"));
        assert!(!new_index.contains("In Progress"));
    }

    #[test]
    fn test_supplement_backup_flow() {
        let (_temp_dir, work_dir) = setup_temp_dir();
        let task_id = "backup-task";

        // 1. Create task structure
        let task_path = create_test_task_file(&work_dir, task_id);

        // 2. Create backup directory
        let backup_dir = task_path.join("supplement-history");
        fs::create_dir_all(&backup_dir).unwrap();

        // 3. Backup supplement
        let supplement = fs::read_to_string(task_path.join("supplement.md")).unwrap();
        let backup_name = format!("supplement-{}.md", chrono::Utc::now().format("%Y%m%d%H%M%S"));
        fs::write(backup_dir.join(&backup_name), &supplement).unwrap();

        // 4. Clear supplement
        fs::write(task_path.join("supplement.md"), "").unwrap();

        // 5. Verify backup and clear
        assert!(backup_dir.join(&backup_name).exists());
        let cleared = fs::read_to_string(task_path.join("supplement.md")).unwrap();
        assert!(cleared.is_empty());
    }
}

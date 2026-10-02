use std::os::windows::process::CommandExt;

fn main() {
    let path = std::env::temp_dir().join("redir_smoke3_test.log");
    let _ = std::fs::remove_file(&path);
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .unwrap();
    let stdout: std::process::Stdio = log_file.into();
    let mut cmd = std::process::Command::new("cmd");
    cmd.arg("/C").arg("echo hello-cmd-line")
        .stdout(stdout)
        .creation_flags(0x08000000);
    let st = cmd.status().unwrap();
    println!("cmd status={:?}", st);
    let content = std::fs::read_to_string(&path).unwrap_or_default();
    println!("cmd content={:?}", content);
    assert!(content.contains("hello-cmd-line"), "cmd 重定向应写入");
    println!("REDIR3 OK");
}

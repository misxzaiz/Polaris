use std::os::windows::process::CommandExt;

fn main() {
    // 用 write 模式（非 append）打开日志文件重定向到 bash
    let path = std::env::temp_dir().join("redir_smoke6_test.log");
    let _ = std::fs::remove_file(&path);
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
        .unwrap();
    let stdout: std::process::Stdio = log_file.into();
    let mut cmd = std::process::Command::new(r"C:\Program Files\Git\usr\bin\bash.exe");
    cmd.arg("-c").arg("for i in $(seq 1 5); do echo line-$i; done")
        .stdout(stdout)
        .stderr(std::process::Stdio::piped())
        .creation_flags(0x08000000);
    let out = cmd.output().unwrap();
    println!("status={:?} stderr={:?}", out.status.code(), String::from_utf8_lossy(&out.stderr));
    let content = std::fs::read_to_string(&path).unwrap_or_default();
    println!("file content={:?}", content);
    assert!(content.contains("line-5"), "write 模式应成功");
    println!("REDIR6 OK");
}

use std::os::windows::process::CommandExt;

fn main() {
    let path = std::env::temp_dir().join("redir_smoke4_test.log");
    let _ = std::fs::remove_file(&path);
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .unwrap();
    let stdout: std::process::Stdio = log_file.into();
    // 不用 -l（login），用普通 -c
    let mut cmd = std::process::Command::new(r"C:\Program Files\Git\usr\bin\bash.exe");
    cmd.arg("-c").arg("for i in $(seq 1 5); do echo line-$i; done")
        .stdout(stdout)
        .stderr(std::process::Stdio::null())
        .creation_flags(0x08000000);
    let st = cmd.status().unwrap();
    println!("status={:?}", st);
    let content = std::fs::read_to_string(&path).unwrap_or_default();
    println!("content lines: {}", content.lines().count());
    assert!(content.contains("line-5"), "bash -c 重定向应写入");
    println!("REDIR4 OK");
}

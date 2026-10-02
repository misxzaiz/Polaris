use std::os::windows::process::CommandExt;

#[tokio::main]
async fn main() {
    let path = std::env::temp_dir().join("redir_smoke_test.log");
    let _ = std::fs::remove_file(&path);
    let log_file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .await
        .unwrap();
    let stdout: std::process::Stdio = log_file.into_std().await.into();
    let mut cmd = std::process::Command::new(r"C:\Program Files\Git\usr\bin\bash.exe");
    cmd.arg("-l").arg("-c").arg("for i in $(seq 1 5); do echo line-$i; done")
        .stdout(stdout)
        .stderr(std::process::Stdio::null())
        .creation_flags(0x08000000);
    let st = cmd.status().unwrap();
    println!("status={:?}", st);
    let content = std::fs::read_to_string(&path).unwrap_or_default();
    println!("content={:?}", content);
    assert!(content.contains("line-5"));
    println!("REDIR OK");
}

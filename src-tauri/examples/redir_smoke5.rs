use std::os::windows::process::CommandExt;

fn main() {
    // 对照组1: piped 读输出
    let out = std::process::Command::new(r"C:\Program Files\Git\usr\bin\bash.exe")
        .arg("-c").arg("echo pipe-test-$((1+1))")
        .creation_flags(0x08000000)
        .output()
        .unwrap();
    println!("piped status={:?} stdout={:?} stderr={:?}", out.status.code(), String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));

    // 对照组2: 无 CREATE_NO_WINDOW + 文件重定向
    let path = std::env::temp_dir().join("redir_smoke5_test.log");
    let _ = std::fs::remove_file(&path);
    let log_file = std::fs::OpenOptions::new().create(true).append(true).open(&path).unwrap();
    let stdout: std::process::Stdio = log_file.into();
    let mut cmd = std::process::Command::new(r"C:\Program Files\Git\usr\bin\bash.exe");
    cmd.arg("-c").arg("echo noflag-test")
        .stdout(stdout)
        .stderr(std::process::Stdio::piped());
    let st = cmd.output().unwrap();
    println!("noflag status={:?} stderr={:?}", st.status.code(), String::from_utf8_lossy(&st.stderr));
    let content = std::fs::read_to_string(&path).unwrap_or_default();
    println!("noflag file content={:?}", content);
}

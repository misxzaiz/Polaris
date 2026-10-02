use polaris_lib::ai::engine::simple_ai::detect_shell;
fn main() {
    let (name, path) = detect_shell();
    println!("shell_name={} path={:?}", name, path);
}

// form_flow 阶段 E 全量验证脚手架：从主 crate 拷贝当前版本 form_flow.rs + form_core.rs
// + contracts/mod.rs（纯类型，零 tauri 依赖），搭独立 crate 实跑全量单测
// （含 submit_form DummyRouter 迟到拒绝 / 白名单纵深防御 / build_hold / cleanup）。
// 目的：完成 step9 验收 #1（实跑独立 crate）+ #3（桥往返 / 迟到拒绝实跑），
// 绕 Tauri DLL 0xc0000139 环境限制（主 crate cargo test --lib 无法在本机启动）。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const ROOT = 'D:/space/base/Polaris/src-tauri/src'
const DST = path.join(os.tmpdir(), 'polaris-form-phaseE-verify')
fs.rmSync(DST, { recursive: true, force: true })

function write(rel, content) {
  const d = path.join(DST, rel)
  fs.mkdirSync(path.dirname(d), { recursive: true })
  fs.writeFileSync(d, content)
}
function cp(rel, destRel = rel) {
  write(path.join('src', destRel), fs.readFileSync(path.join(ROOT, rel), 'utf8'))
}

write('Cargo.toml', `[package]
name = "polaris-form-phaseE-verify"
version = "0.1.0"
edition = "2021"

[lib]
name = "polaris_form_phaseE_verify"
path = "src/lib.rs"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["sync", "macros", "rt-multi-thread"] }
uuid = { version = "1", features = ["v4"] }

[workspace]
`)

// contracts：从主 crate 原样拷贝（纯类型定义，无 tauri 依赖）
cp('contracts/mod.rs', 'contracts/mod.rs')
// form_core / form_flow：从主 crate 拷贝当前版本（含内嵌单测模块）
cp('services/form_core.rs', 'services/form_core.rs')
cp('services/form_flow.rs', 'services/form_flow.rs')

write('src/lib.rs', `//! 独立验证 crate：绕开 Tauri DLL 环境限制（0xc0000139），实跑主 crate 当前
//! 版本 form_flow.rs 全量单测（阶段 E：白名单 / 纵深防御 / 桥往返 / 迟到拒绝）。
//! contracts/form_core/form_flow 均从主 crate 原样拷贝，验证无移植偏移。
pub mod contracts;
pub mod services;
`)

write('src/services/mod.rs', `pub mod form_core;
pub mod form_flow;
`)

// 编译一次
console.log(`verify crate at ${DST}`)

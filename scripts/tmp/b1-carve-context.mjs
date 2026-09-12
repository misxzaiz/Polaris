// B1 cap.context 切割：commands/context.rs → services/context_core.rs（纯类型+存储）
import fs from 'node:fs'

const lines = fs.readFileSync('src-tauri/src/commands/context.rs', 'utf8').split('\n')

// 找 Tauri 命令区起点（"// Tauri 命令" 分隔注释前两行 ===）
let cmdSection = -1
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('// Tauri 命令')) { cmdSection = i - 1; break } // 其上 === 行
}
if (cmdSection < 0) throw new Error('cmd section not found')

let core = lines.slice(0, cmdSection).join('\n')
// 去 tauri 导入
core = core
  .replace(/#\[cfg\(feature = "tauri-app"\)\]\nuse tauri::State;\n/g, '')
  .replace('use std::sync::{Arc, Mutex};', 'use std::sync::Mutex;')

const header = `/*! 上下文业务核（第七步阶段 B1：自 commands/context.rs 抽出，存储为内存
 *  ContextMemoryStore——与原命令层完全同源）。入口：cap.context（同步 dispatch）。
 */

`
fs.writeFileSync('src-tauri/src/services/context_core.rs', header + core + '\n')
console.log('context_core.rs:', core.split('\n').length, 'lines; 命令区起点', cmdSection + 1)

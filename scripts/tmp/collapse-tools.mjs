// 收敛工具面：撤 6 个 todo_* 精选工具，只留 bus_help + bus_dispatch（防工具大爆炸）
import fs from 'node:fs'

let p = 'src-tauri/src/services/bus_mcp_server.rs'
let s = fs.readFileSync(p, 'utf8')

// 1. tools/call：撤 todo_* 目标映射
const tOld = `        "todo_list" | "todo_get" | "todo_create" | "todo_update" | "todo_complete"
        | "todo_delete" => "cap.todo",
`
if (!s.includes(tOld)) throw new Error('target arm anchor')
s = s.replace(tOld, '')

// 2. payload：撤 todo_* 组装分支
const pOld = `    let payload = match name {
        "bus_dispatch" => arguments.get("payload").cloned().unwrap_or(json!({})),
        "todo_list" | "todo_get" | "todo_create" | "todo_update" | "todo_complete"
        | "todo_delete" => {
            let mut p = arguments.clone();
            if let Some(obj) = p.as_object_mut() {
                let action = name.trim_start_matches("todo_");
                obj.insert("action".into(), json!(action));
                // 工具名 → 能力动作语义对齐：complete → complete 已一致
            }
            p
        }
        _ => json!({}),
    };`
if (!s.includes(pOld)) throw new Error('payload arm anchor')
s = s.replace(pOld, `    let payload = arguments.get("payload").cloned().unwrap_or(json!({}));`)

// 3. tools/list：撤 6 个 todo_* 定义（bus_help 与 bus_dispatch 保留）
const listStart = s.indexOf('fn handle_tools_list() -> Value {')
const listEnd = s.indexOf('fn handle_tools_call(', listStart)
if (listStart < 0 || listEnd < 0) throw new Error('tools list bounds')
const listBody = s.slice(listStart, listEnd)
const kept = []
// 只保留 bus_help 与 bus_dispatch 两个定义块（按 tool_def 起始切）
const defs = listBody.match(/tool_def\("bus_[a-z_]+".*?\)\),\n/gs) || []
if (defs.length !== 2) throw new Error('expected 2 bus_* tool defs, got ' + defs.length)
kept.push(defs[0], defs[1])
const newListBody = `fn handle_tools_list() -> Value {
    json!({
        "tools": [
            ` + kept.join('            ') + `
        ]
    })
}

`
s = s.slice(0, listStart) + newListBody + s.slice(listEnd)

fs.writeFileSync(p, s)
console.log('tools collapsed to bus_help + bus_dispatch')

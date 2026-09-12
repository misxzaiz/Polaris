// 阶段 E：bus MCP server 接线（子命令 + manifest）
import fs from 'node:fs'

// 1. services/mod.rs
let p = 'src-tauri/src/services/mod.rs'
let s = fs.readFileSync(p, 'utf8')
if (!s.includes('bus_mcp_server')) s = s.replace('pub mod browser_mcp_server;', 'pub mod browser_mcp_server;\npub mod bus_mcp_server;')
fs.writeFileSync(p, s)

// 2. polaris_mcp.rs：bus 子命令 + 用法文案
p = 'src-tauri/src/bin/polaris_mcp.rs'
s = fs.readFileSync(p, 'utf8')
const usageOld = '可用子命令：requirements, prd-preview, agnes, ph, computer, ask, browser, dispatch'
if (!s.includes('        "bus" => {')) {
  const sched = '        "scheduler" => {'
  if (!s.includes(sched)) throw new Error('scheduler arm anchor')
  s = s.replace(
    sched,
    `        // ── Bus MCP server（第七步阶段 E：总线能力 → AI 工具面） ──────────
        "bus" => {
            let config_dir = if sub_args.is_empty() {
                crate::services::data_root::data_root()
                    .config_dir()
                    .to_string_lossy()
                    .to_string()
            } else {
                parse_config_dir_args(sub_args, "bus")?.0
            };
            crate::services::bus_mcp_server::run_bus_mcp_server(&config_dir)
        }
` + sched,
  )
}
s = s.split(usageOld).join('可用子命令：requirements, prd-preview, agnes, ph, computer, bus, scheduler, ask, browser, dispatch')
fs.writeFileSync(p, s)

// 3. todo manifest：polaris-bus MCP server
p = 'src/plugins/todo/manifest.ts'
s = fs.readFileSync(p, 'utf8')
if (!s.includes('polaris-bus')) {
  const anchor = 'contributes: {'
  if (!s.includes(anchor)) throw new Error('todo manifest anchor')
  s = s.replace(
    anchor,
    `contributes: {
    mcpServers: [
      {
        id: 'polaris-bus',
        transport: 'stdio',
        command: 'polaris-mcp',
        argsTemplate: ['bus', '{{appConfigDir}}'],
      },
    ],`,
  )
}
fs.writeFileSync(p, s)
console.log('bus server wired (subcommand + manifest)')

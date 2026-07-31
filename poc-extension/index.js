// PoC: 极简 Pi MCP Bridge Extension
// 用途：验证 spawn(stdio MCP server) + initialize + tools/list + registerTool 全链路是否可行
//
// 运行方式：
//   pi --extension D:\space\base\Polaris\poc-extension --no-skills --no-context-files -p "列出我的 Personal Hub 书签"

import { spawn } from "node:child_process";

// 用 release 版 polaris-todo-mcp（无需外部鉴权，验证完整调用链）
const MCP_BIN = "D:/space/base/Polaris/src-tauri/target/release/polaris-todo-mcp.exe";
const CONFIG_DIR = "D:/space/base/Polaris/.polaris";
const WORKSPACE = "D:/space/base/Polaris";

function toTypeBox(schema) {
  if (!schema || schema === true) return undefined;
  if (schema === false) return undefined;
  switch (schema.type) {
    case "string":
      return schema.enum ? { type: "string" } : { type: "string" };
    case "number":
    case "integer":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "array":
      return { type: "array" };
    case "object":
      return { type: "object", properties: schema.properties || {} };
    default:
      return undefined;
  }
}

function mcpRequest(proc, method, params, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const id = 1;
    const request = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    let buffer = "";
    let done = false;

    const onStdout = (data) => {
      if (done) return;
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const resp = JSON.parse(line);
          if (resp.id === id) {
            done = true;
            proc.stdout.removeListener("data", onStdout);
            if (resp.error) reject(new Error(resp.error.message));
            else resolve(resp);
          }
        } catch {}
      }
    };

    proc.stdout.on("data", onStdout);
    proc.stdin.write(request);

    setTimeout(() => {
      if (!done) {
        done = true;
        proc.stdout.removeListener("data", onStdout);
        reject(new Error("MCP request timeout: " + method));
      }
    }, timeout);
  });
}

export default async function (pi) {
  console.log("[poc-extension] Starting...");
  const proc = spawn(MCP_BIN, [CONFIG_DIR, WORKSPACE], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  proc.stderr.on("data", (d) => console.error("[poc-extension] stderr:", d.toString().trim()));
  proc.on("error", (err) => console.error("[poc-extension] spawn error:", err.message));
  proc.on("close", (code) => console.log("[poc-extension] MCP server exited with code:", code));

  try {
    console.log("[poc-extension] Initialize MCP server...");
    const init = await mcpRequest(proc, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "poc-extension", version: "1.0.0" },
    });
    console.log("[poc-extension] Initialize OK:", JSON.stringify(init.result?.serverInfo));

    console.log("[poc-extension] tools/list...");
    const list = await mcpRequest(proc, "tools/list", {});
    const tools = list.result?.tools || [];
    console.log("[poc-extension] Discovered", tools.length, "tools:", tools.map((t) => t.name));

    for (const tool of tools) {
      const name = "ph_" + tool.name;
      pi.registerTool({
        name,
        label: "ph:" + tool.name,
        description: tool.description || "",
        parameters: toTypeBox(tool.inputSchema),
        async execute(_, params) {
          console.log("[poc-extension] Calling", tool.name, "with", JSON.stringify(params));
          const result = await mcpRequest(proc, "tools/call", { name: tool.name, arguments: params });
          const content = result.result?.content || [];
          const text = content
            .map((c) => (c.text || typeof c === "string" ? c : JSON.stringify(c)))
            .join("\n");
          return { content: [{ type: "text", text }] };
        },
      });
      console.log("[poc-extension] Registered tool:", name);
    }
  } catch (e) {
    console.error("[poc-extension] Failed:", e.message);
  }
}

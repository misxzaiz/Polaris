/**
 * DSH 引擎插件 — TypeScript manifest（用于内置注册）
 *
 * 将此文件添加到 src/plugins/dsh-engine/manifest.ts，
 * 并在 src/plugin-system/builtinPlugins.ts 中注册即可。
 */

import type { PolarisPluginManifest } from "@/plugin-system/types";

export const dshEngineManifest: PolarisPluginManifest = {
  id: "polaris.dsh-engine",
  name: "DeepSeek Harness Engine",
  version: "0.1.0",
  description:
    "将 DeepSeek Harness 的完整 Agent 能力集成到 Polaris（工具链、子代理、工作流、目标、技能、MCP 客户端）",
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: "dsh.workspace",
        area: "activityBar",
        panelType: "dsh-workspace",
        icon: "Bot",
        labelKey: "labels.dshWorkspace",
        labelDefault: "DSH 工作区",
        order: 60,
      },
    ],
    services: [
      {
        id: "dsh-web",
        pluginId: "polaris.dsh-engine",
        type: "http",
        command: "dsh",
        argsTemplate: ["--profile", "web"],
        port: 3080,
        healthCheck: "http://127.0.0.1:3080/",
        autoStart: true,
        restartOnFailure: true,
        description: "DSH Web 服务",
      },
    ],
    engines: [
      {
        id: "deepseek-dsh",
        name: "DeepSeek Harness",
        description:
          "DeepSeek Harness 完整 Agent（工具链、子代理、工作流、目标、技能、MCP 客户端）",
        cli: {
          command: "dsh",
          args: ["--profile", "headless"],
          installGuide: "npm install -g @deepseek-ai/dsh",
        },
        npmPackage: "@deepseek-ai/dsh",
        protocol: "json-rpc",
        sessionFlags: "omp",
        mcpConsumption: "mcp-servers",
        adapter: {
          entry: "./adapter.mjs",
          runtime: "node",
          protocol: "engine-v1",
        },
        capabilities: {
          tools: true,
          streaming: false,
          interrupt: true,
          resume: true,
        },
      },
    ],
  },
  permissions: {
    network: true,
    workspaceRead: true,
    workspaceWrite: true,
  },
};
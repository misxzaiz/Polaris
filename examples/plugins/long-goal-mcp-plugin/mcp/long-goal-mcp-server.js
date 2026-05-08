#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

const workspacePath = path.resolve(process.argv[2] || process.cwd())
const rootDir = path.join(workspacePath, '.polaris', 'long-goals')

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value })
}

function error(id, code, message) {
  send({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  })
}

function nowText() {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
}

function ensureInsideRoot(goalId) {
  const goalDir = path.resolve(rootDir, safeId(goalId))
  const root = path.resolve(rootDir)
  if (!goalDir.startsWith(root + path.sep)) {
    throw new Error(`Invalid goal id: ${goalId}`)
  }
  return goalDir
}

function safeId(value) {
  return String(value || '')
    .split('')
    .map((ch) => (/^[a-zA-Z0-9_-]$/.test(ch) ? ch.toLowerCase() : '-'))
    .join('')
    .replace(/^-+|-+$/g, '')
}

function readText(filePath, fallback = '') {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback
    throw err
  }
}

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf8')
}

function readJson(filePath) {
  return JSON.parse(readText(filePath))
}

function writeJson(filePath, value) {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function readGoal(goalId) {
  const goalDir = ensureInsideRoot(goalId)
  const config = readJson(path.join(goalDir, 'goal.json'))
  return {
    config,
    documents: {
      protocol: readText(path.join(goalDir, 'protocol.md')),
      plan: readText(path.join(goalDir, 'plan.md')),
      progress: readText(path.join(goalDir, 'progress.md')),
      queue: readText(path.join(goalDir, 'queue.md')),
      supplement: readText(path.join(goalDir, 'supplement.md')),
    },
    goalPath: goalDir,
  }
}

function listGoals() {
  if (!fs.existsSync(rootDir)) return []
  return fs.readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      try {
        const goal = readGoal(entry.name)
        return {
          id: goal.config.id,
          title: goal.config.title,
          status: goal.config.status,
          phase: goal.config.phase,
          engineId: goal.config.engineId,
          nextRunAt: goal.config.nextRunAt,
          updatedAt: goal.config.updatedAt,
        }
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
}

function touchConfig(config) {
  config.revision = Number(config.revision || 0) + 1
  config.updatedAt = Math.floor(Date.now() / 1000)
}

function appendSection(filePath, title, body) {
  const current = readText(filePath)
  writeText(filePath, `${current.trimEnd()}\n\n## ${title} - ${nowText()}\n\n${String(body || '').trim()}\n`)
}

function listTools(id) {
  result(id, {
    tools: [
      {
        name: 'long_goal_list',
        description: 'List long goals in the current Polaris workspace.',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: 'long_goal_read',
        description: 'Read one long goal config and protocol documents.',
        inputSchema: {
          type: 'object',
          required: ['goalId'],
          properties: {
            goalId: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'long_goal_append_supplement',
        description: 'Append supplement text for future long goal sessions.',
        inputSchema: {
          type: 'object',
          required: ['goalId', 'content'],
          properties: {
            goalId: { type: 'string', minLength: 1 },
            content: { type: 'string', minLength: 1 },
            priority: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'long_goal_record_progress',
        description: 'Append execution progress and optionally add a next queue item.',
        inputSchema: {
          type: 'object',
          required: ['goalId', 'summary'],
          properties: {
            goalId: { type: 'string', minLength: 1 },
            stepId: { type: 'string' },
            summary: { type: 'string', minLength: 1 },
            result: { type: 'string' },
            nextStep: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'long_goal_set_status',
        description: 'Update one long goal status and phase in goal.json.',
        inputSchema: {
          type: 'object',
          required: ['goalId', 'status'],
          properties: {
            goalId: { type: 'string', minLength: 1 },
            status: {
              type: 'string',
              enum: ['planning', 'active', 'running', 'paused', 'maintenance', 'blocked', 'completed', 'failed'],
            },
            phase: {
              type: 'string',
              enum: ['planning', 'execution', 'maintenance', 'review'],
            },
            nextRunAt: { type: 'number' },
          },
          additionalProperties: false,
        },
      },
    ],
  })
}

function callTool(id, params) {
  const name = params && params.name
  const args = (params && params.arguments) || {}

  if (name === 'long_goal_list') {
    result(id, toolContent({ workspacePath, goals: listGoals() }))
    return
  }

  if (name === 'long_goal_read') {
    result(id, toolContent(readGoal(args.goalId)))
    return
  }

  if (name === 'long_goal_append_supplement') {
    const goalDir = ensureInsideRoot(args.goalId)
    appendSection(
      path.join(goalDir, 'supplement.md'),
      `补充 - ${args.priority || 'normal'}`,
      args.content
    )
    result(id, toolContent({ ok: true, goalId: args.goalId }))
    return
  }

  if (name === 'long_goal_record_progress') {
    const goalDir = ensureInsideRoot(args.goalId)
    const stepId = args.stepId || `mcp-${Date.now()}`
    appendSection(
      path.join(goalDir, 'progress.md'),
      `执行记录 - ${stepId}`,
      `- 结果: ${args.result || 'unknown'}\n- 摘要: ${args.summary}\n- 下一步: ${args.nextStep || '待定'}`
    )
    if (args.nextStep) {
      appendSection(path.join(goalDir, 'queue.md'), '下一步建议', args.nextStep)
    }
    result(id, toolContent({ ok: true, goalId: args.goalId, stepId }))
    return
  }

  if (name === 'long_goal_set_status') {
    const goalDir = ensureInsideRoot(args.goalId)
    const configPath = path.join(goalDir, 'goal.json')
    const config = readJson(configPath)
    config.status = args.status
    if (args.phase) config.phase = args.phase
    if (Object.prototype.hasOwnProperty.call(args, 'nextRunAt')) {
      config.nextRunAt = args.nextRunAt
    }
    touchConfig(config)
    writeJson(configPath, config)
    result(id, toolContent({ ok: true, config }))
    return
  }

  error(id, -32602, `Unknown tool: ${name}`)
}

function toolContent(value) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2),
      },
    ],
  }
}

function handle(message) {
  if (message.method === 'initialize') {
    result(message.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: {
        name: 'long-goal-mcp-plugin',
        version: '0.1.0',
      },
    })
    return
  }

  if (message.method === 'notifications/initialized' || message.method === 'ping') {
    if (typeof message.id !== 'undefined') result(message.id, {})
    return
  }

  if (message.method === 'tools/list') {
    listTools(message.id)
    return
  }

  if (message.method === 'tools/call') {
    try {
      callTool(message.id, message.params)
    } catch (err) {
      error(message.id, -32000, err instanceof Error ? err.message : String(err))
    }
    return
  }

  if (typeof message.id !== 'undefined') {
    error(message.id, -32601, `Method not found: ${message.method}`)
  }
}

let buffer = ''

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk

  for (;;) {
    const newlineIndex = buffer.indexOf('\n')
    if (newlineIndex === -1) break

    const line = buffer.slice(0, newlineIndex).trim()
    buffer = buffer.slice(newlineIndex + 1)

    if (!line) continue

    try {
      handle(JSON.parse(line))
    } catch (err) {
      error(null, -32700, err instanceof Error ? err.message : String(err))
    }
  }
})

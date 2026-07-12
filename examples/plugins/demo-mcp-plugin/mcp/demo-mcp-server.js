#!/usr/bin/env node

const net = require('node:net')

const positionalArgs = []
const options = new Map()
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--') && arg.includes('=')) {
    const [key, ...rest] = arg.slice(2).split('=')
    options.set(key, rest.join('='))
  } else {
    positionalArgs.push(arg)
  }
}

const workspacePath = positionalArgs[0] || process.cwd()
const polarisPort = Number(options.get('polaris-port') || 0)
const polarisToken = options.get('polaris-token') || ''
const polarisSession = options.get('polaris-session') || ''

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function result(id, value) {
  send({
    jsonrpc: '2.0',
    id,
    result: value,
  })
}

function error(id, code, message) {
  send({
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
    },
  })
}

function writeFrame(socket, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  const len = Buffer.allocUnsafe(4)
  len.writeUInt32LE(body.length, 0)
  socket.write(Buffer.concat([len, body]))
}

function readFrame(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length < 4) return

      const len = buffer.readUInt32LE(0)
      if (len <= 0 || len > 1024 * 1024) {
        reject(new Error(`Invalid frame length: ${len}`))
        socket.destroy()
        return
      }
      if (buffer.length < 4 + len) return

      const body = buffer.subarray(4, 4 + len)
      try {
        resolve(JSON.parse(body.toString('utf8')))
      } catch (err) {
        reject(err)
      } finally {
        socket.end()
      }
    })
    socket.on('error', reject)
    socket.on('end', () => reject(new Error('Socket closed before frame arrived')))
  })
}

function requestPluginCard(payload) {
  if (!polarisPort || !polarisToken) {
    return Promise.resolve({
      declined: true,
      result: {
        reason: 'Polaris interaction channel is not configured.',
      },
    })
  }

  const interactionId = `demo-${Date.now()}-${Math.random().toString(16).slice(2)}`
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: polarisPort }, () => {
      writeFrame(socket, {
        type: 'card',
        token: polarisToken,
        sessionId: polarisSession,
        interactionId,
        callId: interactionId,
        pluginId: 'example.demo-mcp',
        cardId: 'demo-confirm-card',
        toolName: 'mcp__example-demo-mcp__demo_confirm',
        payload,
      })
    })
    readFrame(socket).then(resolve, reject)
  })
}

function listTools(id) {
  result(id, {
    tools: [
      {
        name: 'demo_echo',
        description: 'Echoes a text value from the demo external plugin.',
        inputSchema: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
            },
          },
          required: ['text'],
        },
      },
      {
        name: 'demo_workspace',
        description: 'Returns the workspace path passed to the demo plugin server.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'demo_confirm',
        description: 'Shows a custom plugin chat card and waits for the user response.',
        inputSchema: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
            },
            detail: {
              type: 'string',
            },
          },
        },
      },
    ],
  })
}

async function callTool(id, params) {
  const name = params?.name
  const args = params?.arguments || {}

  if (name === 'demo_echo') {
    result(id, {
      content: [
        {
          type: 'text',
          text: String(args.text || ''),
        },
      ],
    })
    return
  }

  if (name === 'demo_confirm') {
    try {
      const answer = await requestPluginCard({
        title: String(args.title || 'Demo confirmation'),
        detail: String(args.detail || 'Choose a response in the custom plugin card.'),
        workspacePath,
        choices: [
          { id: 'approve', label: 'Approve' },
          { id: 'revise', label: 'Revise' },
          { id: 'decline', label: 'Decline' },
        ],
      })
      result(id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify(answer, null, 2),
          },
        ],
        structuredContent: answer,
      })
    } catch (err) {
      error(id, -32000, err instanceof Error ? err.message : String(err))
    }
    return
  }

  if (name === 'demo_workspace') {
    result(id, {
      content: [
        {
          type: 'text',
          text: workspacePath,
        },
      ],
    })
    return
  }

  error(id, -32602, `Unknown tool: ${name}`)
}

function handle(message) {
  if (message.method === 'initialize') {
    result(message.id, {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: 'demo-mcp-plugin',
        version: '0.1.0',
      },
    })
    return
  }

  if (message.method === 'tools/list') {
    listTools(message.id)
    return
  }

  if (message.method === 'tools/call') {
    void callTool(message.id, message.params)
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
    } catch (parseError) {
      error(null, -32700, parseError instanceof Error ? parseError.message : String(parseError))
    }
  }
})

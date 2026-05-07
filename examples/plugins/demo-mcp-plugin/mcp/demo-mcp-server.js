#!/usr/bin/env node

const workspacePath = process.argv[2] || process.cwd()

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
    ],
  })
}

function callTool(id, params) {
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
    callTool(message.id, message.params)
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

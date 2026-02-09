import http from 'node:http'
import { randomUUID } from 'node:crypto'

const PORT = Number.parseInt(process.env.PORT ?? '3333', 10)

/**
 * Minimal MCP-over-SSE demo server.
 *
 * Endpoints:
 * - GET  /sse      (SSE stream; emits `endpoint` event)
 * - POST /message  (JSON-RPC requests; responses are emitted over SSE)
 *
 * This is intended ONLY for local dev/testing of an MCP client.
 */

/** @type {Set<import("node:http").ServerResponse>} */
const sseClients = new Set()

function setCors(req, res) {
  const origin = req.headers.origin
  if (origin) {
    // For local testing we reflect the requesting origin.
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

function writeSseEvent(res, { event, data }) {
  if (event) res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function broadcastMessage(message) {
  for (const res of sseClients) {
    try {
      writeSseEvent(res, { event: 'message', data: message })
    } catch {
      // ignore
    }
  }
}

function jsonRpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, data } }
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}

const tools = [
  {
    name: 'echo',
    description: 'Echo back the provided text.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'get_time',
    description: 'Returns the current server time in ISO format.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
]

const serverInfo = { name: 'Operative MCP Demo Server', version: '0.1.0' }
const protocolVersion = '2024-11-05'

const server = http.createServer(async (req, res) => {
  setCors(req, res)

  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }

  const url = new URL(
    req.url ?? '/',
    `http://${req.headers.host ?? `localhost:${PORT}`}`,
  )

  if (req.method === 'GET' && url.pathname === '/sse') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    })

    // Register client
    sseClients.add(res)

    // Emit required endpoint event. Spec says event data is a URI string.
    // We'll provide an absolute URL to simplify client-side resolution.
    // IMPORTANT: MCP Inspector enforces the endpoint origin matches the SSE origin.
    // So derive the endpoint from the incoming Host header.
    const endpointUrl = `http://${req.headers.host ?? `127.0.0.1:${PORT}`}/message`
    res.write(`event: endpoint\n`)
    res.write(`data: ${endpointUrl}\n\n`)

    // Keepalive ping (optional)
    const keepalive = setInterval(() => {
      try {
        res.write(`: keepalive ${Date.now()}\n\n`)
      } catch {
        // ignore
      }
    }, 15_000)

    req.on('close', () => {
      clearInterval(keepalive)
      sseClients.delete(res)
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/message') {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => (body += chunk))

    req.on('end', () => {
      /** @type {any} */
      let msg
      try {
        msg = JSON.parse(body)
      } catch {
        res.statusCode = 400
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: 'Invalid JSON' }))
        return
      }

      // Notifications have no id and no response.
      if (
        msg &&
        msg.jsonrpc === '2.0' &&
        msg.method === 'notifications/initialized'
      ) {
        res.statusCode = 202
        res.end()
        return
      }

      const id = msg?.id
      const method = msg?.method
      const params = msg?.params ?? {}

      // eslint-disable-next-line no-console
      console.log('jsonrpc', { id, method })

      if (!method || msg?.jsonrpc !== '2.0' || id === undefined) {
        res.statusCode = 400
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: 'Invalid JSON-RPC request' }))
        return
      }

      // Always accept the POST; responses go back over SSE.
      res.statusCode = 202
      res.end()

      // Handle MCP methods
      if (method === 'initialize') {
        broadcastMessage(
          jsonRpcResult(id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo,
          }),
        )
        return
      }

      if (method === 'tools/list') {
        broadcastMessage(jsonRpcResult(id, { tools }))
        return
      }

      if (method === 'tools/call') {
        const name = params?.name
        const args = params?.arguments ?? {}
        if (name === 'echo') {
          console.log('echo', args)
          broadcastMessage(
            jsonRpcResult(id, {
              id: randomUUID(),
              echoed: String(args?.text ?? ''),
            }),
          )
          return
        }
        if (name === 'get_time') {
          console.log('get_time', args)
          broadcastMessage(jsonRpcResult(id, { now: new Date().toISOString() }))
          return
        }
        broadcastMessage(jsonRpcError(id, -32601, `Unknown tool: ${name}`))
        return
      }

      broadcastMessage(jsonRpcError(id, -32601, `Method not found: ${method}`))
    })

    return
  }

  res.statusCode = 404
  res.setHeader('Content-Type', 'text/plain')
  res.end('Not found')
})

server.listen(PORT, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`MCP demo server listening on http://127.0.0.1:${PORT}`)
  // eslint-disable-next-line no-console
  console.log(`- SSE endpoint:     http://127.0.0.1:${PORT}/sse`)
  // eslint-disable-next-line no-console
  console.log(`- POST endpoint:    http://127.0.0.1:${PORT}/message`)
})

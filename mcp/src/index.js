#!/usr/bin/env node
/* openGym MCP server — stdio transport. The LLM client (Claude Desktop, Cursor, …) spawns
   this process locally, talks JSON-RPC over stdin/stdout, tears it down when the session ends.
   No extra container. It reads a data folder you control (OPENGYM_DATA) or, once paired, your
   own instance's api (OPENGYM_URL).

   `node src/index.js pair <URL> <CODE>` redeems a pairing code and exits. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { TOOLS } from './tools.js'
import { init, getUser } from './state.js'
import { pair, tokenFile } from './remote.js'

if (process.argv[2] === 'pair') {
  const [url, code] = process.argv.slice(3)
  if (!url || !code) {
    console.error('usage: node src/index.js pair <URL> <CODE>   (the code is in Settings → Account → Pair the mobile app)')
    process.exit(2)
  }
  try {
    const u = await pair(url, code)
    console.error(`paired with ${u.name} (${u.id}); token saved to ${tokenFile(url)}. Start the server with OPENGYM_URL=${url}`)
    process.exit(0)
  } catch (e) {
    console.error(`[opengym-mcp] ${e.message}`)
    process.exit(1)
  }
}

const server = new McpServer({
  name: 'opengym',
  version: '0.1.0'
})

// Fail fast on bad config so a misnamed OPENGYM_DATA or a stale token doesn't silently answer
// every call with the no-state sentinel. Always register every tool so the LLM sees the full list at
// handshake, even when state didn't resolve.
try {
  await init()
  const u = await getUser()
  console.error(`[opengym-mcp] serving profile ${u.name} (${u.id})`)
} catch (e) {
  console.error(`[opengym-mcp] ${e.message}`)
  // Don't exit — keep the tool listings up so the user sees a useful error after fixing their
  // env and restarting.
}

for (const t of TOOLS) {
  server.tool(
    t.name,
    t.description,
    t.schema,
    async (params) => {
      try {
        const result = await t.handler(params || {})
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        const code = err.code || 'ERROR'
        return {
          isError: true,
          content: [{ type: 'text', text: `${code}: ${err.message}` }]
        }
      }
    }
  )
}

const transport = new StdioServerTransport()
await server.connect(transport)
// Process stays alive serving JSON-RPC over stdio until the LLM client disconnects.

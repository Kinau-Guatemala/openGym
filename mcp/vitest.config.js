import { defineConfig } from 'vitest/config'

const base = { globals: false, environment: 'node', pool: 'forks', isolate: true }

export default defineConfig({
  test: {
    reporters: ['default'],
    // The tool tests run twice: against the file source, and against a stub api over HTTP
    // (test/source.js), so both sources answer every tool the same way.
    projects: [
      { test: { ...base, name: 'file', include: ['test/**/*.test.js'] } },
      { test: { ...base, name: 'http', include: ['test/tools.test.js', 'test/crossfit-tools.test.js'], env: { MCP_TEST_SOURCE: 'http' } } }
    ]
  }
})

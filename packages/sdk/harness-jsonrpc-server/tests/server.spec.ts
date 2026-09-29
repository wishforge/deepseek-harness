import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'
import { apply as applyPlugin } from '../src/index.ts'
import { HarnessJsonRpcServer } from '../src/server.ts'

/** Transport double capturing notifications; requests are never originated. */
class FakeTransport implements JsonRpcTransportPeer {
  async request(method: string, params: object): Promise<unknown> {
    throw new Error(`the capability server should not call host JSON-RPC method ${method} with ${JSON.stringify(params)}`)
  }

  notify(method: string, params?: object): void {
    throw new Error(`unexpected notification ${method} ${JSON.stringify(params)}`)
  }
}

type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** Mount a server on a context whose sandboxPolicy is a controllable fake. */
function mountServer(policy: { mode: SandboxMode; workspaceRoot: string }): {
  server: HarnessJsonRpcServer
  ctx: Context
} {
  const ctx = new Context()
  ctx.provide('sandboxPolicy', {
    resolve: () => ({ mode: policy.mode, workspaceRoot: policy.workspaceRoot }),
  })
  ctx.provide('harnessAppStartup', { accepted: true })
  const server = new HarnessJsonRpcServer(ctx, new FakeTransport())
  return { server, ctx }
}

describe('HarnessJsonRpcServer.handleRequest', () => {
  it('serves the static capability manifest (introspection only)', async () => {
    const { server } = mountServer({ mode: 'workspace-write', workspaceRoot: '/tmp/ws' })
    await expect(server.handleRequest('get_capabilities', {})).resolves.toEqual({
      runtime: 'deepseek-harness',
      profile: 'harness-capability',
      capabilities: [
        { name: 'get_context' },
        { name: 'get_capabilities' },
        { name: 'create_scope' },
        { name: 'policy_check' },
      ],
    })
  })

  it('serves minimal context from the sandbox policy and scope map', async () => {
    const { server } = mountServer({ mode: 'read-only', workspaceRoot: '/tmp/ws' })
    await expect(server.handleRequest('get_context', {})).resolves.toEqual({
      runtime: 'deepseek-harness',
      profile: 'harness-capability',
      sandbox: { mode: 'read-only', workspaceRoot: '/tmp/ws' },
      scopes: [],
    })
  })

  it('create_scope records the scope and get_context lists it', async () => {
    const { server } = mountServer({ mode: 'workspace-write', workspaceRoot: '/tmp/ws' })
    await expect(server.handleRequest('create_scope', { key: 's1' })).resolves.toEqual({ scopeId: 's1' })
    const context = await server.handleRequest('get_context', {}) as { scopes: string[] }
    expect(context.scopes).toEqual(['s1'])
  })

  it('create_scope rejects duplicate keys', async () => {
    const { server } = mountServer({ mode: 'workspace-write', workspaceRoot: '/tmp/ws' })
    await server.handleRequest('create_scope', { key: 's1' })
    await expect(server.handleRequest('create_scope', { key: 's1' }))
      .rejects.toThrow('invalid params: scope key already exists: s1')
  })

  it.each([
    ['read-only', 'read', '/tmp/ws/a.txt', 'allowed'],
    ['read-only', 'write', '/tmp/ws/a.txt', 'denied'],
    ['workspace-write', 'write', '/tmp/ws/a.txt', 'allowed'],
    ['workspace-write', 'write', '/tmp/outside/a.txt', 'denied'],
    ['workspace-write', 'read', '/tmp/outside/a.txt', 'allowed'],
    ['danger-full-access', 'write', '/etc/passwd', 'allowed'],
  ] as const)('policy_check mode=%s op=%s path=%s → %s', async (mode, operation, path, decision) => {
    const { server } = mountServer({ mode, workspaceRoot: '/tmp/ws' })
    await expect(server.handleRequest('policy_check', { operation, path })).resolves.toEqual(
      expect.objectContaining({ decision }),
    )
  })

  it('policy_check denial is a result, never an error frame', async () => {
    const { server } = mountServer({ mode: 'read-only', workspaceRoot: '/tmp/ws' })
    await expect(server.handleRequest('policy_check', { operation: 'write', path: '/tmp/ws/a.txt' }))
      .resolves.toEqual({ decision: 'denied', reason: 'mode is read-only' })
  })

  it('policy_check validates scopeId existence without behavior change (B8)', async () => {
    const { server } = mountServer({ mode: 'workspace-write', workspaceRoot: '/tmp/ws' })
    await expect(server.handleRequest('policy_check', { operation: 'read', path: '/x', scopeId: 'nope' }))
      .rejects.toThrow('scope not found: nope')
    await server.handleRequest('create_scope', { key: 's1' })
    const withScope = await server.handleRequest('policy_check', { operation: 'write', path: '/tmp/ws/a', scopeId: 's1' }) as { decision: string }
    const withoutScope = await server.handleRequest('policy_check', { operation: 'write', path: '/tmp/ws/a' }) as { decision: string }
    expect(withScope).toEqual(withoutScope)
  })

  it('rejects invalid params with descriptive failures', async () => {
    const { server } = mountServer({ mode: 'workspace-write', workspaceRoot: '/tmp/ws' })
    await expect(server.handleRequest('create_scope', {})).rejects.toThrow('invalid params: key must be a non-empty string')
    await expect(server.handleRequest('policy_check', { operation: 'exec', path: '/x' })).rejects.toThrow('invalid params: operation must be "read" or "write"')
    await expect(server.handleRequest('policy_check', undefined)).rejects.toThrow('invalid params: expected an object')
  })

  it('throws on unknown methods', async () => {
    const { server } = mountServer({ mode: 'workspace-write', workspaceRoot: '/tmp/ws' })
    await expect(server.handleRequest('session/prompt', {}))
      .rejects.toThrow('unknown DeepSeek Harness runtime capability method: session/prompt')
  })

  it('shutdown disposes scopes and stops accepting requests', async () => {
    const { server } = mountServer({ mode: 'workspace-write', workspaceRoot: '/tmp/ws' })
    await server.handleRequest('create_scope', { key: 's1' })
    await expect(server.handleRequest('shutdown', {})).resolves.toEqual({})
    await expect(server.handleRequest('get_context', {})).rejects.toThrow('shutting down')
  })
})

/** Mount the real plugin on a context with fake required services and in-memory stdio. */
async function mountPlugin(policy: { mode: SandboxMode; workspaceRoot: string }) {
  const ctx = new Context()
  ctx.provide('sandboxPolicy', {
    resolve: () => ({ mode: policy.mode, workspaceRoot: policy.workspaceRoot }),
  })
  ctx.provide('harnessAppStartup', { accepted: true })
  const input = new PassThrough()
  const output = new PassThrough()
  const queue: string[] = []
  let wake: (() => void) | undefined
  output.on('data', (chunk: Buffer) => {
    queue.push(...chunk.toString('utf8').split('\n').filter(line => line.length > 0))
    wake?.()
    wake = undefined
  })
  const exits: number[] = []
  ctx.plugin(applyPlugin, { input, output, exit: (code) => { exits.push(code) } })
  await Promise.resolve()

  const send = (frame: Record<string, unknown>): void => {
    input.write(`${JSON.stringify(frame)}\n`)
  }
  const waitForLine = async (): Promise<string> => {
    for (;;) {
      const line = queue.shift()
      if (line !== undefined) return line
      await new Promise<void>((resolve) => { wake = resolve })
    }
  }
  return { ctx, send, waitForLine, queue, exits, input, output }
}

describe('harness-jsonrpc-server plugin wiring', () => {
  it('answers wire frames for both inbound dialects and keeps stdout frame-only', async () => {
    const { send, waitForLine, queue, exits } = await mountPlugin({ mode: 'workspace-write', workspaceRoot: '/tmp/ws' })
    // Codex dialect: no `jsonrpc` key (exec-server dialect).
    send({ id: 7, method: 'get_capabilities', params: {} })
    const dialectA = JSON.parse(await waitForLine())
    expect(dialectA).toMatchObject({ jsonrpc: '2.0', id: 7 })
    expect(Object.keys(dialectA.result.capabilities[0])).toEqual(['name'])

    // Standard dialect: with the `jsonrpc` key.
    send({ jsonrpc: '2.0', id: 'req_abc', method: 'get_context', params: {} })
    const dialectB = JSON.parse(await waitForLine())
    expect(dialectB).toMatchObject({ jsonrpc: '2.0', id: 'req_abc' })

    // Every emitted line is a valid protocol frame — stdout carries no logs.
    for (const line of queue) {
      const frame = JSON.parse(line)
      expect(frame).toHaveProperty('jsonrpc')
    }
    expect(exits).toEqual([])
  })

  it('correlates concurrent in-flight requests by id', async () => {
    const { send, waitForLine } = await mountPlugin({ mode: 'workspace-write', workspaceRoot: '/tmp/ws' })
    send({ id: 1, method: 'get_context', params: {} })
    send({ id: 2, method: 'create_scope', params: { key: 's1' } })
    send({ id: 3, method: 'get_capabilities', params: {} })
    // Three responses arrive; ids may complete in any order and concurrent
    // requests must not assume each other's effects are visible.
    const byId = new Map<number | string, Record<string, unknown>>()
    for (let i = 0; i < 3; i++) {
      const frame = JSON.parse(await waitForLine()) as Record<string, unknown>
      byId.set(frame.id as number | string, frame)
    }
    expect([...byId.keys()].sort()).toEqual([1, 2, 3])
    expect(byId.get(2)!.result).toEqual({ scopeId: 's1' })
    expect(byId.get(1)!.result).toHaveProperty('sandbox')
    expect(byId.get(3)!.result).toHaveProperty('capabilities')

    // After create_scope's response is observed, a fresh get_context sees it.
    send({ id: 4, method: 'get_context', params: {} })
    const after = JSON.parse(await waitForLine())
    expect(after.id).toBe(4)
    expect(after.result.scopes).toEqual(['s1'])
  })

  it('maps handler failures to -32603 error frames on the wire', async () => {
    const { send, waitForLine } = await mountPlugin({ mode: 'workspace-write', workspaceRoot: '/tmp/ws' })
    send({ id: 9, method: 'no_such_method', params: {} })
    const frame = JSON.parse(await waitForLine())
    // Source-verified transport behavior: a handler throw becomes -32603 with
    // the failure message (packages/sdk/protocol/src/transport.ts handleIncomingRequest).
    expect(frame).toMatchObject({
      jsonrpc: '2.0',
      id: 9,
      error: { code: -32603 },
    })
    expect(frame.error.message).toContain('unknown DeepSeek Harness runtime capability method')
  })
})

/**
 * JSON-RPC methods for out-of-process runtime capability consumers.
 * Serves exactly the four PoC operations over the shared line transport.
 * The surrounding Cordis context owns services; this class only reads them.
 *
 * Scope semantics (r2 SPEC §6.3, B8): `create_scope` records a scopeId and
 * mints a real dsh-scope; subsequent requests validate scopeId existence only.
 * No per-scope behavior differences are claimed or implemented.
 *
 * @module @deepseek-ai/dsh-harness-jsonrpc-server/server
 */

import { isAbsolute, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'

/** Structural view of the sandbox-policy service surface this server reads. */
interface SandboxPolicyView {
  resolve(request?: object): {
    mode: 'read-only' | 'workspace-write' | 'danger-full-access'
    workspaceRoot: string
  }
}

const RUNTIME_NAME = 'deepseek-harness'
const PROFILE_NAME = 'harness-capability'

const CAPABILITIES = [
  { name: 'get_context' },
  { name: 'get_capabilities' },
  { name: 'create_scope' },
  { name: 'policy_check' },
] as const

interface ScopeRecord {
  scope: Scope
}

/** Validate `params` is a plain object; otherwise throw a validation error. */
function objectParams(params: Record<string, unknown> | undefined): Record<string, unknown> {
  if (params === undefined || typeof params !== 'object' || Array.isArray(params)) {
    throw new TypeError('invalid params: expected an object')
  }
  return params
}

/** Validate a required non-empty string field. */
function requireString(params: Record<string, unknown>, field: string): string {
  const value = params[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`invalid params: ${field} must be a non-empty string`)
  }
  return value
}

/** Path containment check for the minimal filesystem policy evaluator. */
function pathWithinWorkspace(path: string, workspaceRoot: string): boolean {
  const resolvedPath = resolve(path)
  const rel = relative(resolve(workspaceRoot), resolvedPath)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Runtime capability server over one booted harness context and transport
 * peer. Requests are served concurrently; the shared transport correlates
 * responses by request id.
 */
export class HarnessJsonRpcServer {
  private readonly sandboxPolicy: SandboxPolicyView
  private readonly scopes = new Map<string, ScopeRecord>()
  private shuttingDown = false

  constructor(
    private readonly ctx: Context,
    /** Kept for interface parity with the SDK server; notifications are unused in the PoC. */
    _transport: JsonRpcTransportPeer,
  ) {
    // `sandboxPolicy` is a required inject of the surrounding plugin; the
    // profile's dependency closure guarantees it is provided before apply().
    const policy = ctx.get('sandboxPolicy') as unknown as SandboxPolicyView | undefined
    if (policy === undefined || typeof policy.resolve !== 'function') {
      throw new Error('harness-jsonrpc-server requires the sandboxPolicy service')
    }
    this.sandboxPolicy = policy
  }

  /**
   * Dispatch one incoming JSON-RPC request to its typed handler. Throws (→ a
   * JSON-RPC error response) on an unknown method, invalid params, or unknown
   * scope. The shared transport wraps handler failures as `-32603` error
   * frames carrying the failure message.
   * @param method - the JSON-RPC method name.
   * @param params - the raw params object from the wire.
   * @returns the handler's result, serialized as the response.
   */
  async handleRequest(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    if (method !== 'shutdown') this.assertAccepting()
    switch (method) {
      case 'get_capabilities':
        return this.getCapabilities()
      case 'get_context':
        return this.getContext()
      case 'create_scope':
        return this.createScope(objectParams(params))
      case 'policy_check':
        return this.policyCheck(objectParams(params))
      case 'shutdown':
        return this.shutdown()
      default:
        throw new Error(`unknown DeepSeek Harness runtime capability method: ${method}`)
    }
  }

  /** Static manifest; runtime introspection only — never drives tool registration. */
  private getCapabilities(): Record<string, unknown> {
    return {
      runtime: RUNTIME_NAME,
      profile: PROFILE_NAME,
      capabilities: CAPABILITIES,
    }
  }

  /** Minimal runtime context payload (r2 SPEC §6.2; richer semantics are BLOCKED). */
  private getContext(): Record<string, unknown> {
    const policy = this.sandboxPolicy.resolve()
    return {
      runtime: RUNTIME_NAME,
      profile: PROFILE_NAME,
      sandbox: { mode: policy.mode, workspaceRoot: policy.workspaceRoot },
      scopes: [...this.scopes.keys()],
    }
  }

  /** Mint a dsh-scope under the plugin context and record it by wire scopeId. */
  private createScope(params: Record<string, unknown>): Record<string, unknown> {
    this.assertAccepting()
    const key = requireString(params, 'key')
    if (this.scopes.has(key)) {
      throw new TypeError(`invalid params: scope key already exists: ${key}`)
    }
    // dsh-scope requires an opaque identity-compared key object; the wire id
    // maps to a fresh object held (and kept alive) by this server.
    const keyObject = {}
    const scope = createScope(this.ctx, keyObject)
    this.scopes.set(key, { scope })
    return { scopeId: key }
  }

  /**
   * Minimal filesystem policy evaluation over the resolved sandbox policy
   * (r2 SPEC §6.4). The `SandboxMode` vocabulary constrains file-effect sinks
   * only (packages/sandbox/sandbox/src/index.ts:25-30): reads are permitted in
   * every mode; writes are denied under `read-only`, unrestricted under
   * `danger-full-access`, and workspace-contained under `workspace-write`.
   * `scopeId`, when present, is an existence check only (B8): the policy
   * answer is identical to root resolution.
   */
  private policyCheck(params: Record<string, unknown>): Record<string, unknown> {
    const operation = params.operation
    if (operation !== 'read' && operation !== 'write') {
      throw new TypeError('invalid params: operation must be "read" or "write"')
    }
    const path = requireString(params, 'path')
    const scopeId = params.scopeId
    if (scopeId !== undefined) {
      if (typeof scopeId !== 'string') {
        throw new TypeError('invalid params: scopeId must be a string')
      }
      if (!this.scopes.has(scopeId)) {
        throw new Error(`scope not found: ${scopeId}`)
      }
    }
    const policy = this.sandboxPolicy.resolve()
    if (operation === 'read') {
      return { decision: 'allowed', reason: `read permitted under mode ${policy.mode}` }
    }
    if (policy.mode === 'read-only') {
      return { decision: 'denied', reason: 'mode is read-only' }
    }
    if (policy.mode === 'danger-full-access') {
      return { decision: 'allowed', reason: `mode is ${policy.mode}` }
    }
    if (pathWithinWorkspace(path, policy.workspaceRoot)) {
      return { decision: 'allowed', reason: 'path within workspaceRoot' }
    }
    return { decision: 'denied', reason: 'path outside workspaceRoot' }
  }

  /** Dispose server-owned scopes to quiescence. The context keeps running. */
  async shutdown(): Promise<Record<string, never>> {
    this.shuttingDown = true
    await this.disposeScopes()
    return {}
  }

  /** Effect-disposal path: same teardown as shutdown, without the flag first. */
  async dispose(): Promise<void> {
    await this.disposeScopes()
  }

  private assertAccepting(): void {
    if (this.shuttingDown) throw new Error('harness-jsonrpc-server is shutting down')
  }

  private async disposeScopes(): Promise<void> {
    const records = [...this.scopes.values()]
    this.scopes.clear()
    const failures: unknown[] = []
    for (const record of records) {
      try {
        await record.scope.dispose()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'harness-jsonrpc-server scope teardown failed')
  }
}

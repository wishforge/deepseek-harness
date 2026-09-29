/**
 * Runtime-capability JSON-RPC plugin over stdio, shaped after the SDK JSON-RPC
 * server (packages/sdk/server). Serves exactly four capability operations to
 * an out-of-process consumer:
 *
 *   get_capabilities  runtime introspection (static manifest)
 *   get_context       minimal runtime context payload
 *   create_scope      mint a dsh-scope under the plugin context
 *   policy_check      minimal filesystem policy evaluation
 *
 * Stdout is reserved for protocol frames, so the tree must not load a stdout
 * logger. Keep named plugin exports with no default export so Loader
 * `unwrapExports` preserves `name`, `inject`, `Config`, and `apply`.
 *
 * Dependency policy: `sandboxPolicy` and `harnessAppStartup` are REQUIRED
 * dependencies (declared via `inject`, enforced by Cordis fiber construction —
 * vendor/cordis/src/registry.ts builds each Fiber with
 * `Inject.resolve(plugin.inject)`); the profile's dependency closure
 * guarantees both are provided. `harnessAppStartup` gates stdio claiming so
 * `--help` starts no transport.
 *
 * @module @deepseek-ai/dsh-harness-jsonrpc-server
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Readable, Writable } from 'node:stream'
import Schema from '@deepseek-ai/schemastery'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { HarnessJsonRpcServer } from './server.ts'

export * from './server.ts'

export const name = 'harness-jsonrpc-server'
export const inject = ['sandboxPolicy', 'harnessAppStartup']

/** JSON-RPC deployment config plus runtime-only test hooks. */
export interface JsonRpcConfig {
  /** Transport input override; production uses `process.stdin`. */
  input?: Readable
  /** Transport output override; production uses `process.stdout`. */
  output?: Writable
  /** Process-exit override; production uses `process.exit`. */
  exit?: (code: number) => void
}

export const Config: Schema<JsonRpcConfig> = Schema.object({})

/**
 * Serve capability requests over the configured streams. Effect disposal
 * shuts down server-owned scopes and closes the transport. A `shutdown`
 * response is flushed before the root runtime is disposed and the process
 * exits 0; the app bin owns EOF and signal exits.
 */
export function apply(ctx: Context, config: JsonRpcConfig): void {
  const rootFiber = ctx.root.fiber
  /* v8 ignore next -- production stdio wiring; tests always inject the runtime hooks */
  const input = config.input ?? process.stdin
  /* v8 ignore next -- production stdio wiring; tests always inject the runtime hooks */
  const output = config.output ?? process.stdout
  /* v8 ignore next -- production exit wiring; tests always inject the runtime hooks */
  const exit = config.exit ?? ((code: number): void => { process.exit(code) })

  const transport = new JsonRpcLineTransport(input, output)
  const server = new HarnessJsonRpcServer(ctx, transport)

  // Share one exit task so racing shutdown requests cannot dispose the root
  // or exit the process more than once.
  let exitTask: Promise<void> | undefined
  const disposeAndExit = (): Promise<void> => {
    exitTask ??= (async () => {
      await Promise.allSettled([Promise.resolve().then(() => transport.flush())])
      await Promise.allSettled([Promise.resolve().then(() => rootFiber.dispose())])
      exit(0)
    })()
    return exitTask
  }

  transport.onRequest(async (method, params) => {
    const result = await server.handleRequest(method, params)
    if (method === 'shutdown') {
      // Run after the handler result is written; the task then flushes, disposes, and exits.
      setImmediate(() => { void disposeAndExit() })
    }
    return result
  })

  ctx.effect(() => {
    transport.start()
    return async () => {
      await server.dispose()
      transport.close()
    }
  }, 'harness-jsonrpc.serve')
}

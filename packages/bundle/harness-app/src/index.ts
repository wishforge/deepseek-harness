/**
 * The harness-capability profile's command-line and stdin-lifetime provider.
 * A successful parse publishes `harnessAppStartup`; the JSON-RPC server waits
 * for that service, so help starts no transport. Mirrors the SDK profile's
 * `sdk-app-startup` plugin.
 * @module @deepseek-ai/dsh-harness-app
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { exitOnStdinEnd, parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'harness-app-startup'

/** Launcher service required before this app can parse its invocation. */
export const inject = ['cmdlineArgs']

/** Service the JSON-RPC server row waits for before claiming stdio. */
export const HARNESS_APP_STARTUP_SERVICE = 'harnessAppStartup'

/** Harness stdio startup configuration. */
export interface Config {
  /** Profile name rendered in help and diagnostics (default `harness-capability`). */
  profile?: string
}

/** Validate and default harness stdio startup configuration. */
export const Config: z<Config> = z.object({
  profile: z.string().default('harness-capability'),
})

/**
 * Build this app's zero-option command and help.
 * @param profile - selected profile name rendered in the command grammar.
 * @returns a fresh program for one invocation.
 */
function harnessCommand(profile: string): Command {
  return new Command()
    .name(`dsh --profile ${profile}`)
    .description('Serve runtime capability clients over stdio JSON-RPC.')
    .helpOption('-h, --help', 'show this help')
    .addHelpText('after', `
Example:
  dsh --profile ${profile}     serve one runtime capability endpoint until its client disconnects
`)
}

/**
 * Accept a harness profile invocation, publish readiness, and bind EOF to the
 * launcher's bounded shutdown.
 * @param ctx - plugin context carrying command-line and exit launcher values.
 * @param config - selected profile identity for command help.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const program = harnessCommand(config.profile ?? 'harness-capability')
  program.action(() => {
    exitOnStdinEnd(ctx, 'harness-app.stdin')
    ctx.provide(HARNESS_APP_STARTUP_SERVICE, { accepted: true })
  })
  parseCmdline(ctx, program)
}

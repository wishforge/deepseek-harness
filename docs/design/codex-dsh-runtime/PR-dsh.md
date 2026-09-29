# PR: deepseek-harness — `feat/harness-capability-profile`

**Branch:** `feat/harness-capability-poc` → base `main`
**Title suggestion:** `feat: expose runtime capabilities over stdio JSON-RPC (harness-capability profile)`

## Summary

Adds an opt-in profile that exposes a small, fixed runtime-capability surface to an out-of-process
consumer over the existing newline-delimited JSON-RPC stdio transport. Nothing changes for the
shipped profiles (`base`, `sdk`, `acp`, `web`); the new profile must be requested explicitly.

## What is added

| Path | Role |
|---|---|
| `packages/sdk/harness-jsonrpc-server/` | Cordis plugin serving four methods: `get_capabilities`, `get_context`, `create_scope`, `policy_check` |
| `packages/bundle/harness-app/` | bundle for the profile: startup gate + stdout isolation patch |
| `packages/boot/app-boot/src/profile.ts` | `harness-capability` entry in `PROFILE_TEMPLATES` |
| `apps/cli/package.json` | workspace dependency on the new bundle (bundle resolution reads from the dsh installation) |
| `tsconfig.host.json` | the two new projects |

Runtime dependencies are **required** injects (`inject = ['sandboxPolicy', 'harnessAppStartup']`): if
either service is absent the plugin does not load. `get_capabilities` is introspection only — it never
drives tool registration.

## Semantics worth reviewing

- `create_scope` performs a real `createScope` and records the scope id; **no per-scope behaviour
  differences are claimed or implemented**. A later `policy_check(scopeId)` only checks that the id
  exists (unknown id → error frame). `policy_check` itself evaluates `operation` / `path` / sandbox
  `mode` / `workspaceRoot` only — no network, process, approval, or credential semantics.
- `policy_check` denial is a **result** (`{decision: "denied", reason}`), never an error frame.
- Error surface: every handler-side failure surfaces as `-32603` with a structured message
  (`invalid params: …`, `scope not found: …`, `unknown … method: …`). Typed codes with a `data`
  payload are not reachable through the shared transport (`transport.ts` fixes `-32603` for handler
  throws and `writeError` has no `data` parameter); changing that would mean modifying the shared
  transport, which is out of scope for this change.
- stdout carries protocol frames only (the profile reuses the audited in-memory logger + the
  `sdk-app` stdout patch pattern).

## Verification

- `vitest run packages/sdk/harness-jsonrpc-server packages/bundle/harness-app` → **25/25**
  (unit + wire-level, including both inbound dialects, concurrent in-flight correlation,
  shutdown frame → single `exit(0)`, teardown failure propagation).
- Per-file coverage gate (100 %) clean for all three new source files.
- Real boot: `dsh --profile harness-capability` answers all four methods per spec, stdin EOF → exit 0,
  stdout frames only.
- Cross-process end-to-end with the consuming client (codex `codex-harness-client`): handshake,
  four operations, 4-way concurrency, unknown-method frame, clean shutdown.

## Notes for reviewers

- The lockfile change is intentionally free of unrelated resolution bumps.
- No behaviour change to existing profiles; no new required env vars.

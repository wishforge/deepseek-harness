# PLAN — Codex consumes DSH as a Runtime Capability Provider (PoC) — r2

Status: r2 draft (calibrated against SPEC r2; execution requires user confirmation; branches + PR only)
Companion: `SPEC.md` (architecture + frozen contract), `evidence-map.md` (Round 2 rows R1–R10)
Every item marked **NEW** does not exist in source today; everything else cites it.

---

## 0. Dependencies & ordering

```
Phase 0 (contract freeze — DONE r2, SPEC §5/§7)
Phase 1 (DSH server + profile) ──┐
Phase 2 (codex manager + client)─┼──► Phase 3 (E2E round trip)
```

Phase 1 / Phase 2 are independent repos → parallelizable. Phase 3 needs both.

---

## Phase 1 — DSH side

### 1.1 New package `packages/sdk/harness-jsonrpc-server` **NEW**

```
packages/sdk/harness-jsonrpc-server/
  package.json          # @deepseek-ai/dsh-harness-jsonrpc-server
  src/index.ts  src/server.ts  tests/server.spec.ts
```

- `src/index.ts`
  - `export const name = 'harness-jsonrpc-server'`
  - **`export const inject = ['sandboxPolicy', 'harnessAppStartup']` — both REQUIRED dependencies
    (decision A, P0-3; as implemented — `harnessAppStartup` is the stdio gate published by the bundle
    startup plugin, also a required dep rather than a patch-level inject).**
    Evidence: required deps are declared via `inject` and enforced by fiber construction
    (`vendor/cordis/src/registry.ts:330` `new Fiber(ctx, config, Inject.resolve(plugin.inject), ...)`,
    normalization `registry.ts:71-86`); optional lookup is exclusively `ctx.get`
    (`vendor/cordis/src/reflect.ts:10-17`, returns `undefined` when not provided). Both patterns coexist
    in one real file (`packages/sdk/server/src/index.ts:22-24`: required `inject=['agents']`, optional
    LLM seam via `ctx.get()`). **No optional degradation for either dependency**: if a service is absent
    the plugin must not load; the profile closure (1.2) is the proof both are present.
  - `export const Config` with test hooks `input?/output?/exit?` (mirror `sdk/server/src/index.ts:35-45`).
  - `apply(ctx, config)`: `new JsonRpcLineTransport(input ?? process.stdin, output ?? process.stdout)`.
- `src/server.ts` — `class HarnessJsonRpcServer` with `handleRequest` (mirror
  `sdk/server/src/server.ts:249`):
  - `get_capabilities` → static manifest (**NEW**).
  - `get_context` → minimal payload from `ctx.sandboxPolicy` + scope map (**NEW**, B1).
  - `create_scope` → `createScope(ctx, keyObj)` (`packages/core/scope/src/index.ts:137`); plugin holds
    `Map<scopeId, {scope}>` (the `ScopeKey` object is owned by the scope fiber; as implemented);
    duplicate key → throw `invalid params: scope key already exists:
    <key>`; disposal = plugin effect teardown
    (scope-owned registrations unload with the fiber — `scope/index.ts:110-126`).
    **No per-scope behavioral semantics — B8 BLOCKED** (see 1.4).
  - `policy_check` → validate params (throw `invalid params: <field/problem>`); optional `scopeId` =
    existence check only (throw `scope not found: <id>` when absent from map; **no behavior change**,
    B8). Evaluation = **NEW evaluator** (1.4) over `ctx.sandboxPolicy.resolve()`
    (`sandbox-policy/src/index.ts:164`).
  - `shutdown` → dispose scope map, respond, root-fiber dispose, exit 0 (mirror `sdk/server` lifecycle).
  - Unknown method → throw → transport emits `-32603` + message (`transport.ts:245-253`: a handler
    throw is always `-32603`; the `-32601` path only fires with no handler installed). All
    handler-side errors surface as `-32603` + structured semantic message — typed `-32602`/`-32001`
    are unreachable through the shared transport (SPEC §5 r3; accepted deviation).

### 1.2 Profile `harness-capability` — frozen dependency closure (P0-4)

Profile mechanism (proven): `PROFILE_TEMPLATES` (`packages/boot/app-boot/src/profile.ts:179-195`) maps
profile name → bundle tuple; bundle packages expose `dsh.bundle.patch` (`sdk-app/package.json:31-35`)
pointing at a `cordis.patch.yml` plugin list; the root `cordis.yml` is emptied at boot
(`apps/cli/src/profile-boot.ts:81-88`) and the tree is layered entirely from patches.

**Decision: inherit `@deepseek-ai/dsh-base` + new bundle** (same shape as the `sdk` template,
`profile.ts:189-191`). Base already registers the full closure; do NOT hand-assemble a standalone tree.

Closure table (each row proven; base carries them):

| layer | package / file / symbol | why required | registered by |
|---|---|---|---|
| L0 | `@deepseek-ai/dsh-sandbox-policy` — `sandbox-policy/src/index.ts:110` `SandboxPolicyService` | policy source for policy_check; `static inject=['sessionProjections']` (:119), `ctx.inject(['systemPrompt'])` (:141) | base `cordis.patch.yml:229-232` |
| L1 | `@deepseek-ai/dsh-session-projection` — `session-projection/src/index.ts:199` `SessionProjectionRegistry` | sandboxPolicy static inject; needs `session/created`+`session/event` events (:209,220) | base |
| L2 | `@deepseek-ai/dsh-session` — `core/session/src/index.ts:925` `SessionStore` (`ctx.inject(['typert'])` :954) | event source for L1 | base |
| L3 | typert rows — base `cordis.patch.yml:46-53` | SessionStore dependency | base |
| parallel | `@deepseek-ai/dsh-system-prompt` — `core/system-prompt/src/index.ts:405` `SystemPrompt` | sandboxPolicy `ctx.inject(['systemPrompt'])` | base |
| scope | `@deepseek-ai/dsh-scope` — `core/scope/src/index.ts:121` no-op plugin `scope()`, zero deps | `createScope` | base (or new bundle insert; no-op cost) |
| lifecycle | `sdk-app-startup` equivalent — `packages/bundle/sdk-app/src/index.ts:14` (mirror as `harness-app-startup` **NEW**) | cmdline parse + stdin-EOF lifecycle + readiness gating | new bundle |
| server | `harness-jsonrpc-server` row **NEW** | the service itself | new bundle row; no patch-level `inject` override (as implemented) — the plugin's source `inject` carries both required deps |

Files to create:

```
packages/bundle/harness-app/
  package.json          # dsh.bundle.patch -> ./cordis.patch.yml
  cordis.patch.yml      # header comment: "Stdout belongs exclusively to JSON-RPC." (mirror sdk-app:1)
  src/index.ts          # harness-app-startup plugin (mirror sdk-app/src/index.ts)
  tests/startup.spec.ts # mirror sdk-app/tests/startup.spec.ts (readiness vs --help gating)
```

Plus one line in `PROFILE_TEMPLATES` (`app-boot/src/profile.ts:179`):
`'harness-capability': { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-harness-app'] }`.

Stdout safety (former B6 — now structurally proven, keep a regression test): Cordis logger defaults to
an in-memory exporter (`vendor/cordis/src/logger.ts:213-221`); diagnostics go to stderr
(`apps/cli/src/profile-boot.ts:251-252`); `hmr` disabled in patch (mirror `sdk-app:24-25`); audited
stdout writers in the base tree are only the JSON-RPC output itself and `--help` text
(`packages/boot/cmdline/src/index.ts:108,217`), and the startup plugin does not open the transport when
exiting via help/errors (`sdk-app/tests/startup.spec.ts:57-64` precedent). Test: boot profile, assert
stdout carries only protocol frames.

### 1.3 Tests (DSH)

- vitest, injected streams: one request per method; **both inbound dialects** (with and without
  `jsonrpc` key); unknown method / invalid params / unknown scopeId / duplicate create_scope key →
  `-32603` + semantic message (as-implemented error surface, SPEC §5 r3); create_scope then
  get_context lists it (state across calls);
  **concurrent in-flight requests** (≥3 interleaved, id-correlated responses — mirrors the proven
  `pending` Map semantics, `transport.ts:69,109-150`); shutdown → exit 0.
- policy_check: three `SandboxMode` values × read/write × inside/outside workspaceRoot; assertion that
  denial is a **result**, not an error frame.

### 1.4 Honest scope of policy_check and scope (restating, prevents scope creep)

- policy_check = NEW pure evaluator: `(operation: 'read'|'write', path, mode, workspaceRoot) →
  {decision: 'allowed'|'denied', reason}`. Inputs proven (`resolve()` :164, modes :30, workspaceRoot
  fallback :114-130); enforcement elsewhere is OS-level (`sandbox-local` e2e suites) — the evaluator is
  a queryable shadow of that, NEW, and limited to filesystem semantics. No network/process/approval.
- create_scope = proven wrapper; **no claim that subsequent calls "execute inside" the scope beyond
  pass-through service resolution** (B8). PLAN deliberately does not implement per-scope overrides —
  that would require `Context.isolate()` + re-registration (`context.ts:121-125`), which is unproven
  for these services and would throw on already-provided names (`reflect.ts:40-46`).

---

## Phase 2 — Codex side

### 2.1 `HarnessRuntimeManager` — session-owned (P0-1, resolved)

- **Host**: `core/src/state/service.rs:48` `SessionServices` — new field **NEW**
  `pub(crate) harness_runtime_manager: HarnessRuntimeManager` (comment style after `service.rs:50`:
  "The single owner of the live DSH runtime for this thread").
- **Create**: `core/src/session/session.rs` at the `McpRuntime::empty` assembly point (:1572-1575
  region) — when `config.harness.enabled`, build manager and spawn eagerly; when disabled, install an
  empty/disabled manager (tool registration then omits the four tools).
- **Destroy**: `core/src/session/handlers.rs:287` `shutdown_session_runtime`, next to
  `mcp_runtime.shutdown()` (:318) and `code_mode_service.shutdown()` (:311): EOF → SIGTERM → SIGKILL
  ladder (mirror semantics documented in `packages/sdk/client/src/client.ts:9`).
- **API** (NEW): `HarnessRuntimeManager { async fn request(&self, method, params) -> Result<Value>;
  async fn shutdown(&self); fn is_available(&self) -> bool }` — wraps spawn (mirror
  `rmcp-client/src/local_stdio_transport.rs:37-49`: `codex_utils_pty::Command`, piped stdio, stderr
  kept for diagnostics) + id correlation `HashMap<RequestId, oneshot::Sender>` (concurrency required —
  see 2.3).
- **Per-step reference only**: `append_harness_tools` reads `session.services.harness_runtime_manager`
  exactly the way `spec_plan.rs:153` reads `session.services.mcp_handler_cache`. Tool registration
  (per-step, stateless) ≠ runtime lifecycle (per-Session). SPEC §3.1/§9 are normative.

### 2.2 New crate `codex-rs/harness-client` **NEW**

- `Cargo.toml` + workspace member; `src/codec.rs` reusing `codex_exec_server_protocol::JSONRPCMessage`
  (`exec-server-protocol/src/rpc.rs:54,237`; outbound omits `jsonrpc` key — Codex dialect, `rpc.rs:3-4`;
  inbound tolerates it). B4 (export `JsonRpcConnection` vs local ~150-line codec) stays an OPEN
  decision, default local codec.
- `src/lib.rs`: `HarnessClient` (spawn/request/shutdown) used by the manager; no per-tool or per-turn
  state.

### 2.3 Tool handlers + registration

- `core/src/tools/handlers/harness.rs` **NEW**: four `impl ToolExecutor<ToolInvocation>`
  (`tools/src/tool_executor.rs:106`) holding `Arc<HarnessRuntimeManager>`; names fixed
  (`harness.get_context|get_capabilities|create_scope|policy_check`); specs per SPEC §7.
  Runtime-unavailable → tool error `RespondToModel("harness runtime unavailable: …")` semantics (never
  tears down the Session; SPEC §9).
- `core/src/tools/spec_plan.rs`: one insertion in `build_tool_router` (:123) between
  `append_extension_tool_executors` and `append_dynamic_tool_runtimes` (~:184-186):
  `append_harness_tools(session, registry)` — skips silently when disabled (mirrors existing per-source
  pattern; no step aborts router build).

### 2.4 Config extension point (P0-5, resolved — not an arbitrary launcher)

- `config/src/config_toml.rs`: **NEW** `pub struct HarnessToml { pub enabled: Option<bool>,
  pub profile: Option<String> }` with `#[schemars(deny_unknown_fields)]` (precedent `OrchestratorToml`,
  :141); field on `ConfigToml` (:165) as `#[serde(default)] pub harness: Option<HarnessToml>` (precedent
  `mcp_servers`, :289-293).
- `core/src/config/mod.rs`: parsed `pub harness: HarnessConfig` on `Config` (:609), resolved like
  `orchestrator_mcp_enabled` (:729 precedent).
- Regenerate schema via `config-schema` crate (`config-schema/src/main.rs:15-20`).
- **Deliberately NOT a feature flag**: `features` machinery is boolean-keyed
  (`features/src/lib.rs:790-823` `BTreeMap<String, bool>`); `profile` is structured data. Also NOT a
  generic launcher: config carries only `enabled` + `profile` name; the argv shape is fixed at
  `<node> <dsh-entry> --profile <profile>` and the node/DSH-entry paths come from implementation-layer
  env overrides (`CODEX_HARNESS_NODE`, `CODEX_HARNESS_DSH_BIN` — the latter is a PoC prerequisite,
  missing → spawn fails → tools degrade to absent); no user argv, no arbitrary
  command. Spawn policy: `dsh --profile <config.harness.profile, default "harness-capability">`.

### 2.5 Tests (codex)

- codec: framing, id correlation, unknown-method propagation, EOF shutdown ladder (echo fixture;
  `test-binary-support` precedent).
- **Concurrency (required by contract)**: ≥3 interleaved `request()` calls with out-of-order responses;
  assert per-id correlation and that a dropped connection rejects all pending (`failPending` mirror,
  `transport.ts:82-84`).
- router: flag on → 4 tools present with SPEC §7 specs; flag off → none; router build unaffected
  either way.
- manager lifecycle: session shutdown terminates child (assert exit, no orphan).
- manager disabled → handlers return the "harness runtime unavailable" tool error without touching the
  process.

---

## Phase 3 — E2E

- Integration (codex, requires local `dsh`): session with `harness.enabled=true` → spawn → handshake →
  concurrent `policy_check` + `create_scope` → clean shutdown exit 0; verify denial-is-result for a
  `read-only` mode case.
- Manual: codex CLI session issuing `policy_check`; DSH-side answer matches `SandboxPolicyService`
  mode; no stdout noise in either log.
- House rules: branch + PR; pre-commit gates; user confirms merge.

---

## Test matrix (r2)

| Layer | Test | Proves |
|---|---|---|
| DSH plugin | vitest injected streams | 4 methods, dialects, error codes, concurrency, state, shutdown |
| DSH profile | boot smoke | stdout = protocol frames only; closure loads |
| codex codec | cargo test | framing, correlation, concurrency, teardown |
| codex manager | cargo test | session-lifetime spawn/kill, disabled mode |
| codex router | cargo test | registration on/off, specs |
| E2E | integration + manual | real pair, concurrent calls, denial-as-result |

---

## Self-Review

- **SPEC coverage**: P0-1 → §3.1/§9 + PLAN 2.1-2.3 (registration ≠ lifecycle, SessionServices host,
  proven MCP-tier lifecycle); P0-2 → §6.3/§7 + PLAN 1.1/1.4 (proven vs B8 split, existence-check-only
  scopeId); P0-3 → PLAN 1.1 decision A with both-patterns-in-one-file evidence; P0-4 → PLAN 1.2 frozen
  closure table, "whatever minimal plugins" wording deleted; P0-5 → §11 + PLAN 2.4 single config
  scheme, anti-launcher guard stated.
- **Contract completeness**: id types, error surface (as-implemented: `-32601` no-handler path /
  `-32603` + semantic message for all handler-side failures, incl. former `-32602`/`-32001` intents —
  typed codes unreachable through the shared transport, SPEC §5 r3), denial-as-result, malformed-line
  behavior, concurrency — all frozen (SPEC §5/§7) with a codex-side concurrency test mandated
  (PLAN 2.5).
- **Placeholder scan**: no TODO/TBD; every NEW symbol has a defining file; every modified file has an
  insertion point with a cited precedent.
- **Consistency SPEC ↔ PLAN**: manager host field, create/destroy sites, registration step position,
  config fields, profile name, error codes, and the B8 existence-check-only rule are stated identically
  in both documents.
- **Remaining assumptions check**: none load-bearing without evidence — B1/B2/B3/B7/B8 stay BLOCKED and
  the plan routes around them (static manifest, minimal context payload, filesystem-only evaluator,
  existence-only scopeId). B4 remains an OPEN implementation choice with a default, not an assumption.

## Execution Handoff

- Recommended: **subagent-driven-development** — Phase 1 and Phase 2 parallel (independent repos) after
  this plan is approved; Phase 3 strictly after both.
- Alternative: inline order 1 → 2 → 3 if the implementer wants the DSH server probeable while building
  the codex side.
- Gate before any commit: secret scan + regression (house rules); user confirmation before merge.

## Closure status (2026-09-29)

All phases executed. Results (real outputs, evidence-map Round 3):

| Layer | Result |
|---|---|
| DSH plugin vitest | 18/18 green (clean dev state) |
| DSH profile vitest | 2/2 green |
| codex `cargo test -p codex-harness-client` | 4/4 green |
| codex `cargo test -p codex-core --lib harness` | 11/11 green |
| codex `cargo test -p codex-core --lib tools::spec_plan` | 58/58 green |
| E2E real process pair (`--test e2e_dsh -- --ignored`) | 2/2 green — handshake, 4 ops, 4-way concurrent, error frame, clean shutdown |
| DSH-side boot probe | 4 methods per §7, denial-as-result, stdout frames only, EOF → exit 0 |
| LLM-in-the-loop agent-loop E2E | **RUN (r4) — verified with local `gpt-oss:20b` via ollama, no API key**: model emitted `harness.policy_check`, router logged `tool_source="direct" handler_duration_ms=72`, runtime result text `path outside workspaceRoot` appeared in the rollout, final answer `denied`. Supersedes the earlier NOT RUN entry (SPEC §14) |
| Pre-push equivalents | `cargo fmt --all -- --check` exit 0; `cargo clippy -p codex-harness-client -p codex-core --all-targets` exit 0 (0 errors); DSH per-file coverage clean for the three new source files |

Deviations from PLAN as written: (1) error surface `-32603` + semantic message instead of typed
`-32602`/`-32001` (transport constraint, SPEC §5 r3); (2) `apps/cli/package.json` gained the
`dsh-harness-app` workspace dep (bundle resolution comes from the dsh installation, not the workspace
tree — discovered at E2E); (3) test fixtures: the harness-client roundtrip specs use an awk responder
(`/bin/cat` cannot serve: it echoes requests that deserialize as Requests, never Responses), while the
registration-only spec_plan test still uses `/bin/cat` (it never sends a frame); (4) `inject` carries
`['sandboxPolicy', 'harnessAppStartup']` (no patch-level inject override); (5) node/DSH-entry paths come
from implementation-layer env overrides, not hard-coded resolution.

Post-review fixes (SPEC §14.1, evidence-map Round 4): F1 `scopeId` sent as `null` → now omitted when
absent; F2 shutdown did not fail in-flight requests → now drains pending before aborting tasks;
F3 pending-map leak on writer-channel failure → fixed; F4 empty-argument normalization for zero-arg
tools → fixed. `cargo test -p codex-harness-client` re-verified 4/4 after the fixes.

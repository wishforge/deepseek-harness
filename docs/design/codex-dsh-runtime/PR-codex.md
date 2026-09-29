# PR: codex — `feat/harness-capability-client`

**Branch:** `feat/harness-capability-client` → base `main`
**Title suggestion:** `Add an out-of-process runtime capability client and four harness tools`

## Summary

Adds a client for a `deepseek-harness` runtime capability provider and exposes its four capabilities
as model-visible tools. The runtime is a per-Session child process; tool registration is per-step and
stateless.

## What is added

| Path | Role |
|---|---|
| `codex-rs/harness-client/` (new crate) | `HarnessClient` (spawn / request / shutdown), `HarnessRuntimeManager` (Disabled \| Running), `launch_argv` |
| `core/src/state/service.rs` | `SessionServices.harness_runtime_manager` — the single owner of the live runtime for the thread |
| `core/src/session/session.rs` | spawn at Session construction + `get_capabilities` handshake (10 s); failure degrades to disabled with one warning |
| `core/src/session/handlers.rs` | runtime teardown in `shutdown_session_runtime` |
| `core/src/tools/handlers/harness.rs` | four `ToolExecutor`s: `harness.get_context`, `.get_capabilities`, `.create_scope`, `.policy_check` |
| `core/src/tools/spec_plan.rs` | `append_harness_tools` (skips silently when the runtime is unavailable) |
| `config/src/config_toml.rs` + `core/src/config/mod.rs` | `[harness] enabled / profile` (default profile `harness-capability`) |

## Design points worth reviewing

- **Registration ≠ lifecycle**: `build_tool_router` only *reads* the manager; the only non-test spawn
  site in the tree is Session construction, and teardown lives in `shutdown_session_runtime`.
- **Config is not a launcher**: config carries `enabled` + profile name only. The argv shape is fixed
  (`<node> <dsh-entry> --profile <profile>`); the node/dsh paths come from two implementation-layer env
  overrides (`CODEX_HARNESS_NODE`, `CODEX_HARNESS_DSH_BIN`), not from config.
- **Wire dialect**: outbound frames omit `jsonrpc` (exec-server dialect); inbound tolerates both
  dialects. Requests correlate by id with concurrent in-flight calls supported.
- **Shutdown**: pending requests are failed first, then tasks abort, then stdin EOF → exit, then kill
  after a grace period.
- Optional `scopeId` is **omitted** when absent (never sent as `null`; the runtime rejects a non-string).

## Verification

- `cargo test -p codex-harness-client` → 4/4 (framing, id correlation, concurrency, shutdown never hangs).
- `cargo test -p codex-core --lib harness` → 11/11; `--lib tools::spec_plan` → 58/58.
- Real-process E2E (`--test e2e_dsh -- --ignored`) → 2/2 against a live
  `dsh --profile harness-capability`.
- LLM-in-the-loop, both providers: local `gpt-oss:20b` (no API key) and a production provider
  (`wire_api = "responses"`). The model called `harness.policy_check` and, in a second turn,
  `harness.create_scope` → `harness.policy_check(scopeId=…)`; the rollout contained the runtime's own
  result text, and the model echoed the runtime's verdict.
- `cargo fmt --all -- --check` and `cargo clippy -p codex-harness-client -p codex-core --all-targets`
  are clean.

## Known limitations / follow-ups

- Tool registration is all-or-nothing per Session: when the runtime is unavailable the four tools are
  absent (per-call errors only apply to a runtime that dies mid-session).
- Follow-ups not in this PR: regenerate `core/config.schema.json` for the new config section; add a
  BUILD.bazel target for the new crate.

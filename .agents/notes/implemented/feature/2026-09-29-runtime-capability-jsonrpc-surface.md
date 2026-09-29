# Agent Note: Runtime capability surface over stdio JSON-RPC

Status: implemented

English | [中文](2026-09-29-runtime-capability-jsonrpc-surface.zh.md)

## Problem

A process that drives this runtime from outside — today an agent harness that shells out to the shipped `dsh` CLI — cannot ask the runtime three questions that decide how the caller behaves: which capabilities the running deployment offers, what this deployment's sandbox policy says about one concrete filesystem operation, and whether a scope it created earlier still exists. That knowledge currently lives inside the process: capability facts in package manifests and profile templates, sandbox policy behind `SandboxPolicyService`, scope identity in the scope package's own registry.

The cost of that gap is duplication with drift. A consumer that needs a policy answer either embeds this repository's policy code or re-implements it; the two then disagree, so a model is told one thing while the runtime enforces another. The same gap leaves no way to report a refusal: a caller learns that an operation was blocked, not that the running profile required a service the deployment did not provide.

## Decision

The profile `harness-capability` loads a new plugin, `harness-jsonrpc-server` (`packages/sdk/harness-jsonrpc-server`), together with its bundle `harness-app` (`packages/bundle/harness-app`), and serves four methods over the stdio JSON-RPC transport the CLI already owns:

```text
get_capabilities, get_context, create_scope, policy_check
```

- `get_capabilities` returns a static manifest for the loading profile. It reports what is available; nothing on either side derives its registrations from it.
- `get_context` returns runtime identity, the profile name, the resolved sandbox mode and workspace root, and the scope ids created so far.
- `create_scope` wraps the proven `createScope` from `packages/core/scope` and tracks the returned id.
- `policy_check` evaluates one operation against the sandbox mode and workspace root that `SandboxPolicyService` resolves for this deployment.

Both dependencies are required injects, `inject = ['sandboxPolicy', 'harnessAppStartup']`: a deployment without the policy service does not silently serve a capability surface with invented answers, the plugin does not load at all. The profile is opt-in — the shipped `base`, `sdk`, `acp`, and `web` profiles are unchanged — and stdout stays reserved for protocol frames.

## Wire contract

| Method | Params | Result | Failures |
|---|---|---|---|
| `get_capabilities` | `{}` | capability manifest for the profile | — |
| `get_context` | `{}` | identity, profile, sandbox mode, workspace root, scope ids | — |
| `create_scope` | `{key}` | `{scopeId}` | duplicate key |
| `policy_check` | `{operation, path, scopeId?}` | `{decision, reason}` | bad operation or path, unknown scope id |

- An optional `scopeId` is omitted, never sent as `null`; a non-string value is rejected rather than coerced.
- A denied operation is a normal result with `decision: "denied"`; only malformed input and runtime failures are errors.
- Every handler-side failure surfaces as the transport's `-32603` with a semantic message (`invalid params: …`, `scope not found: …`, `unknown DeepSeek Harness runtime capability method: …`).

## Scope semantics

`create_scope` creates a real scope through the shared scope package and records its id; a later `policy_check` that names the id only checks that the id exists. No policy answer differs because a scope id was supplied. The stronger property a reader might assume — that a scope changes which policy applies — is not implemented and not claimed: `SandboxPolicyService` resolves from deployment defaults plus the session's mode and working directory, and a scope created by `Context.extend` cannot shadow an already-provided service without `Context.isolate` plus a fresh registration, which this change does not attempt.

## Alternatives considered

**MCP-style dynamic discovery.** Serving the capability list through a `tools/list`-shaped call and letting the consumer register whatever comes back would couple this runtime's packaging to a consumer protocol, and it would make the surface configurable from outside the build. The four methods are fixed in source instead, which keeps the wire contract reviewable and the consumer's tool list stable.

**Serving the methods only through an in-process library import.** A consumer that links this repository's packages gets the same answers with no wire surface, but it must then match versions exactly and run the runtime inside its own process, which is the isolation this surface exists to preserve.

**Typed error codes with a `data` payload (`-32602`, `-32001`).** This is the more precise contract, and it is unreachable without changing the shared transport: a handler throw is fixed to `-32603`, and the transport's private `writeError` takes no `data`. Adding a parallel transport path for one surface was judged not worth the divergence; the semantic message carries the same information.

**Making `sandboxPolicy` optional so the surface always loads.** A deployment that resolves no policy service would then answer policy questions from a guess. The refusal to load is the honest outcome.

**Adding `dispose_scope`, network, process, or approval policy to the same surface.** Each needs a semantic decision this change does not make — disposal lifetimes, which process or network rules a deployment can express, what an approval answer means without a human — and a surface that guesses is worse than one that stays narrow.

## Consequences

- The capability surface is fixed at four methods. A fifth is a wire change with a consumer release behind it, which is the intended cost of a reviewable contract.
- Callers now learn refusals: an unknown method, malformed parameters, an unknown scope id, and a shutting-down server are distinguishable by message, not by silence.
- Capability reporting is a manifest, not a probe. It reports what the profile ships, not what a particular deployment has already exercised.
- Policy answers are the deployment's own, so a consumer no longer needs a second policy implementation; the `Scope` limitation above remains the boundary of what that buys.
- Loading the profile requires both injected services; a deployment missing either one gets no capability surface rather than a degraded one.
- Agent Notes are the only documentation of wire semantics this change adds; the working design set for the change lives outside this repository.

## Testing

- `vitest run packages/sdk/harness-jsonrpc-server packages/bundle/harness-app` covers both inbound dialects, parameter validation, scope state across calls, concurrent in-flight correlation, `dispose` and `shutdown` teardown paths including multiple-failure propagation, and the shutdown frame that answers before the process exits once.
- The per-file coverage gate holds on the three new source files.
- A real `dsh --profile harness-capability` answers all four methods, keeps stdout to protocol frames, and exits 0 on stdin EOF.
- A cross-process run with the consumer's client covers handshake, all four operations, four concurrent requests, an unknown-method error frame, and clean shutdown.
- A model-driven run covers the seam end to end: a local model and a production provider each call `policy_check`, and `create_scope` followed by `policy_check` with the returned id, with the runtime's own result text visible in the session record.

## Related

- The consumer-side change (session-owned runtime, four tools, `[harness]` config) lives in another repository; this note records the provider side of that seam.
- [Profile system](2026-07-07-mcp-client-plugin.md) is the closest shipped precedent for an opt-in profile hosting a plugin with required dependencies.

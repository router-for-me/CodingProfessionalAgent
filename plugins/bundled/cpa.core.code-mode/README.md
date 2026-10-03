# Code Mode

Code Mode is an activated bundled plugin, disabled by default through
`toolMode: "direct"`. Enable `code` or `code-only` in its settings section to
compose ordinary CPA tools in JavaScript. `exec` and `wait` are ordinary
Responses function tools, not a new protocol dialect.

## Current runtime decision

Dependencies are pinned to `quickjs-emscripten@0.32.0` and
`@jitl/quickjs-ng-wasmfile-release-sync@0.32.0`. Production execution uses
**QuickJS-ng synchronous WASM with real guest promises**, exclusively in a
dedicated Electron utility process. Renderer, agent, and Electron main do not
load WASM or create QuickJS runtimes. Main only supervises and forwards.

The rejected asyncify host-suspension bridge permits only one suspended host
call at a time; it cannot implement the required concurrent suspended calls.
The previous asyncify smoke also stalled while observing the returned promise.
That historical gate is not the current implementation or a current blocker.
Synchronous WASM does not imply synchronous tools:

1. `context.newFunction` creates a `context.newPromise()` and immediately returns
   its guest handle. No asyncified host callback is used.
2. Host execution asynchronously resolves or rejects that deferred promise.
3. `promise.settled` schedules `runtime.executePendingJobs()` on a later turn,
   never synchronously inside a host callback.
4. `context.resolvePromise` observes the root async function. `Promise.all` can
   await two independent host tools concurrently.

Do not install `isolated-vm`, use `node:vm`, launch a second Node binary,
evaluate in workers, or set `ELECTRON_RUN_AS_NODE`. The unchanged
`patches/isolated-vm-7.0.1-electron44.patch` records a rejected native experiment;
it is not connected to installation or runtime execution.

## Execution and exposure

| Mode | Model tools | Guest tools |
| --- | --- | --- |
| `direct` | Existing ordinary tools | None |
| `code` | Ordinary tools plus `exec`/`wait` | Eligible ordinary tools |
| `code-only` | `exec`/`wait`, direct-only tools | Other eligible ordinary tools |

Excluded tools and orchestration tools cannot be nested. Name collisions are
first-wins with warnings. `code-only` includes bounded TypeScript declarations
in `exec.description`. Backend failure is fail-closed in `code-only`; `code`
may explicitly fall back with a visible notice when configured to do so.
Pure static browser pages without a CPA backend cannot execute Code Mode.

### Direct-only subagent orchestration

`spawn_agent`, `send_message` (including its `send_input` alias), and
`stop_agent` always remain top-level tools when available, including in
`code-only`. They are never included in nested declarations, `ALL_TOOLS`, or
the guest tool allowlist. Empty settings, exclusion lists, and `code-nested`
metadata cannot relax this rule. The tools declare `exposure: "direct"`
at their source.

Only eligible ordinary tools should be batched inside `exec`. Call subagent
tools directly; this preserves delegation rather than disabling it. Do not
use Code Mode `wait` to poll subagents: it observes execution cells only.
The cell executor and agent-side event dispatcher reject direct-only names
before invoking host tools, including forged requests and resumed cells.
The same policy applies to desktop and browser-backed sessions.

Example `exec` arguments:

```json
{
    "source": "const results = await Promise.all([tools.read({path:'a.txt'}), tools.read({path:'b.txt'})]); text(results.map(result => result.content));"
}
```

The first-line `// @exec:` pragma accepts `yield_time_ms` and
`max_output_tokens`. Defaults are 30 seconds for `exec`, 10 seconds for `wait`,
and 10,000 approximate output tokens. A yielded result includes a stable
`cell_id`; `wait` consumes only output since the last observation.

Each cell has its own 128MB-limited runtime. Globals include `tools`,
`ALL_TOOLS`, `text`, `image`, `notify`, `yield_control`, `exit`, timers, and
JSON-only `store`/`load`. Store limits are 256KB per value and 4MB per session.
Node, filesystem, network, console, dynamic imports, shared memory, and guest
WebAssembly are unavailable. Timers and unawaited tools do not keep a completed
cell alive. `exit` cannot be caught to continue host-side effects. Finished
cells release their guest handles and WASM references.

A synchronous loop is interrupted and terminated, never suspended for later
resumption. Cells awaiting promises can yield and continue. At most 32 host
tool calls may be outstanding per cell. Pending output is bounded to 4MB;
observations additionally apply their approximate token budget.

Nested calls reuse CPA validation, approval, hooks, and mutation queues through
the host-injected dispatcher. Each write still requires its ordinary approval;
there is no blanket script approval. Nested cards are display-only metadata,
bounded in size and stripped from provider inputs, not extra protocol tool
calls. Background approval events remain visible while the next model stream
is pending. Nested output is collapsed unless approval needs attention.

## Lifecycle and transport

Main starts only a committed, package-contained executor through the generic
main-only `process.utility` capability; it does not reuse the external-plugin
bootstrap. The same scoped RPC/event contract works with Electron and Web
capability handles. Browser pages do not execute the source themselves.

A new observer can reconnect to an existing backend cell. Already-dispatched
responses remain bound to their original observer. Heartbeats allow a 30-second
reconnection grace period after a client disappears. Cancellation, session
closure/deletion, switching back to direct mode, or backend shutdown clears
cells and session stores. Normal agent-run completion does not clear stores.
If a synchronous guest prevents cancellation acknowledgment, the supervisor
kills its utility process after one second; other cells in that executor are
then lost too. The next execution starts a fresh utility process, and old cell
identifiers report missing. Stores are in memory, not SQLite, and do not survive
executor restart.

## Verification

From the repository root:

```bash
pnpm --dir frontend exec vitest run ../plugins/bundled/cpa.core.code-mode src/features/agent-runtime/agent/agentLoop.test.ts src/features/agent-runtime/ui/eventAdapter.test.ts
pnpm exec vitest run --config vitest.electron.config.ts plugins/bundled/cpa.core.code-mode/main test/pluginCapabilityContributions.test.ts
pnpm test
pnpm check:plugin-architecture
pnpm build
pnpm exec electron scripts/code-mode-quickjs-smoke.cjs
pnpm exec electron scripts/code-mode-cells-smoke.cjs
```

Both engine gates pass: arithmetic is 2, the genuinely asynchronous host
callback resolves to 42 exactly once, and the utility process exits normally.
The compiled-cell utility smoke also verifies two concurrent tools, isolated
stores, incremental reconnect/wait, synchronous-loop termination, cancellation,
and executor restart. Unit tests cover approval/rejection, exposure policies,
backend fallback, display-only replay, resource limits, timers, and imports.

Implementation and automated integration are complete. The full live-model
manual acceptance matrix in the migration plan, including actual browser
refresh and native desktop approval interaction, has **not** been performed;
mocked transport parity and utility-process smoke are not substitutes for it.
Historical native and asyncify failures remain documented in the migration plan.

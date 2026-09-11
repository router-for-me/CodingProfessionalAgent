# Coding Professional Agent

Desktop coding agent (CPA-style shell) that talks to a **CLIProxyAPI** CPA
Responses endpoint over a persistent WebSocket. Electron hosts the native
window and OS primitives; React owns UI, session state, and the TypeScript
agent kernel.

## Stack

- Electron + Node.js (TypeScript main & preload)
- Frontend: React 19, Vite, TypeScript, Tailwind CSS v4, Zustand, TanStack Router, i18next
- Package manager: pnpm
- Tests: Vitest (`pnpm test`)

## Architecture

```text
React UI / Zustand (Pure State Container)
        │
        ▼
Isomorphic Plugin Platform (packages/plugin-api, plugin-kernel, plugin-sdk, plugin-ui)
├── Main / Renderer / Agent Plugin Runtime Hosts (Three-Runtime Model)
├── Contribution Registry (Views, Actions, Settings, Panels, Composer, Chat, Slots, Tools, Resources, Hooks, Protocols, Models, Services, RPCs)
├── Agent Providers & Generation Lease (Tool Factories, Resources, Hooks, Protocols, Model Catalogs)
├── Scoped Capability Broker & Handle-Based Invocation
└── Centralized Plugin Storage & Multi-Source Discovery
        │
        ▼
Electron Preload & Main (src/main, src/preload)
├── Scoped Host Transport & Fixed Capability IPC Bridge
├── Utility Process Isolation for External Main Plugins
├── Managed NPM Package Installer (Lockfile & Integrity Verified)
└── Multi-Source Plugin Catalog (Project, Global, Managed NPM, Bundled)
```

- A valid **absolute project directory** enables coding tools (`read`, `bash`,
  `edit`, `write`). Without one the agent stays in pure chat (no tools).
- There is no sandbox. Tools run with the desktop process privileges.
- **Universal Plugin Platform & Plugin Development Constraints**:
  - **"Everything is a Plugin" Architectural Closure**: All business capabilities (22 bundled core plugins `cpa.core.*`, user plugins, and third-party plugins) are self-contained plugins following the universal plugin platform specification (`docs/superpowers/specs/2026-08-31-universal-plugin-platform-closure-migration-design.md`). App hosts (Electron Main, Preload, React Shell) contain zero business logic, zero hardcoded plugin/contribution IDs, and zero fallback tool/protocol implementations.
  - **Shared Workspace Packages**:
    - `@cpa/plugin-api`: Public interfaces, manifest schemas, contribution types, protocol SPI, capability IDs, DTOs, and service tokens.
    - `@cpa/plugin-kernel`: Internal micro-kernel (`PluginCatalog`, `DependencyResolver`, `PluginRuntime`, `ContributionRegistry`, `GenerationLease`, `PluginEventBus`, `safeInvoke`, staging transactions).
    - `@cpa/plugin-sdk`: Developer SDK and test harnesses (`definePluginEntry`, `manifestValidator`, `createPluginTestHarness`, agent adapters, resource helpers, diff/image utilities).
    - `@cpa/plugin-ui`: Reusable UI primitives for renderer plugins (`CustomSelect`, `ExtensionSlot`, `PluginSurface`, `PluginCard`, `FileTypeIcon`, `ChatRendererErrorBoundary`, `HostServicesContext`, `ResizableSidebar`). Contains zero business components.
    - `@cpa/context-usage`: Shared token usage ring component and calculation utilities.
  - **Physical Package Root Structure (`plugins/bundled/<plugin-id>/`)**:
    - Every bundled plugin is an isolated package located at its own root: `plugins/bundled/<plugin-id>/`.
    - Layout:
      - `manifest.json`: Single authoritative source of truth.
      - `main/index.ts`: Main process entry point (if declaring `entries.main`).
      - `renderer/index.tsx`: Renderer UI entry point (if declaring `entries.renderer`).
      - `agent/index.ts`: Agent runtime entry point (if declaring `entries.agent`).
      - `shared/`: Plugin-internal shared utilities and types.
    - Entry paths in `manifest.json` MUST resolve relative to the package root (e.g. `"./renderer/index.tsx"`). Legacy directories (`frontend/src/plugins/core/*`, `src/main/plugins/bundled/*`) are completely abolished.
  - **Authoritative Manifest Contract**:
    - `manifest.json` is the sole source of truth. Plugin entry files MUST NEVER re-declare or embed the manifest object.
    - Manifest MUST declare: `id`, `name`, `version`, `apiVersion`, `engines: { cpa: string }`, `entries` (`main`, `renderer`, `agent`), `dependencies`, `capabilities`, and `contributes`.
    - `activationPriority`: Optional numeric priority for activation ordering.
    - **Strict Registration Integrity**: Any contribution registered at runtime MUST be explicitly declared in `manifest.contributes[kind]`. Any capability invoked at runtime MUST be explicitly declared in `manifest.capabilities`. Unregistered contributions or undeclared capability calls fail validation and trigger transaction rollback.
  - **Plugin Entry Implementation (`definePluginEntry`)**:
    - Entry modules MUST export an entry definition created with `definePluginEntry({ runtime, activate, deactivate? })` from `@cpa/plugin-sdk`.
    - `runtime`: Exactly one of `'main'`, `'renderer'`, or `'agent'`.
    - `activate(context: PluginContext)`: Registers contributions declared in the manifest via `context.register()`, sets up event listeners, and initializes services.
    - `deactivate?(context: PluginContext)`: Disposes resources, unbinds handlers, and releases leases.
    - Legacy `definePlugin({ manifest, ... })` is strictly forbidden and rejected by architecture gates.
  - **Three-Runtime Model (Main, Renderer, Agent)**:
    - **Unified Identity**: Main, Renderer, and Agent runtimes share identical plugin identity, version, dependency graph, graph revision, and generation.
    - **Coordinated Staging**: Plugins are staged across all three runtimes in dependency order. If a required/platform plugin fails staging in any runtime, all staged contributions rollback and capability handles are revoked.
    - **Main Runtime**: Consumes `service` (ServiceDescriptor), `rpc` (RpcDescriptor), `web-route`, `storage` (namespace migrations), and `lifecycle` hooks. IPC/Web capability transport binds dynamically to committed RPC contributions.
    - **Renderer Runtime**: Consumes UI contributions: `view`, `navigation`, `action`, `shortcut`, `menu`, `slash`, `settings-group`, `settings`, `panel`, `composer`, `chat-renderer` (message items, tool cards, thinking blocks, compaction), `slot`, `floating`.
    - **Agent Runtime**: Independent runtime and registry (isolated even when colocated in the renderer process). Consumes `tool-factory`, `resource` (skills, prompts, system prompts, context files), `hook` (session lifecycle hooks), `protocol` (e.g. CPA protocol), `model-catalog`, and `subagent` policies. Agent contributions MUST NEVER be registered to the Renderer Registry.
    - **Generation Lease**: Agent runs acquire an immutable `AgentGenerationSnapshot` with a generation lease. Older generations remain active until all ongoing agent streams / async callbacks complete before disposal.
  - **Scoped Capability Security & Zero Direct Bridge**:
    - **Capability Broker & Handles**: The Main Capability Broker issues cryptographically tracked handles bound to plugin ID, runtime, generation, and granted capabilities.
    - **Fixed Transport Protocol**: Preload only exposes `HostCapabilityTransport` (`invoke`, `subscribe`). No arbitrary IPC channels, no global platform tokens, and no direct Electron bridge.
    - **Zero Direct Native / Window Access**: Plugins MUST NOT access `window.electronBridge`, `window.cpa`, `ipcRenderer`, or Node.js built-ins in renderer. All system interactions go through `context.getCapability<T>(capabilityId)` or scoped `CapabilityClient`.
    - **Browser Transport Parity**: Capabilities seamlessly route over WebSocket/Web transport in browser mode, maintaining identical security contracts.
  - **Multi-Source Discovery & Catalog Generation**:
    - Five plugin sources in strict priority order: Project Config > Project Directory (`<project>/.cpa/plugins/`) > Global Config > Global Directory (`~/.coding-professional-agent/plugins/`) > Managed NPM (verified lockfile) > Bundled (`plugins/bundled/`).
    - **Catalog Generation**: When adding or updating bundled plugin manifests, run `node scripts/generate-bundled-plugin-catalog.mjs` (or `pnpm build`) to update `bundledPluginLoaders.ts` in both `src/main/plugins/generated/` and `frontend/src/plugins/generated/`. Host code must never manually maintain bundled plugin lists.
  - **Strict Architectural Boundaries (Enforced by `pnpm check:plugin-architecture`)**:
    - **Zero Host -> Plugin Imports**: App host modules (`frontend/src/app/*`, `frontend/src/features/*`, `frontend/src/components/*`, `frontend/src/stores/*`, `src/main/services/*`) MUST NEVER directly import concrete plugin implementation files. All features must be dynamically discovered and consumed via registries and generated loaders (`bundledPluginLoaders.ts`).
    - **Zero Cross-Plugin Private Imports**: A plugin module MUST NEVER import internal/private files from another plugin. Cross-plugin coordination MUST happen exclusively via services (`context.getService()`), contributions, actions, or public events.
    - **Zero Private Host Imports**: Plugin code MUST NEVER import host private internals (`frontend/src/stores/*`, `frontend/src/components/*`, `frontend/src/features/agent-runtime/*`, `frontend/src/features/agent/*`, `frontend/src/app/*`, `src/main/services/*`, `src/main/ipc/*`, `src/preload/*`). Plugins only import from `@cpa/plugin-api`, `@cpa/plugin-sdk`, `@cpa/plugin-ui`, `@cpa/context-usage`, and whitelisted packages (`react`, `lucide-react`, etc.).
    - **Zero Direct NativeBridge / Window Global Access**: Direct access to `window.electronBridge`, `window.cpa`, `ipcRenderer`, or Node APIs in plugins is prohibited.
    - **Zero Hardcoded Plugin / Contribution IDs in Host**: Host layouts, panels, menus, and tools MUST NOT contain hardcoded plugin IDs (e.g. `'cpa.core.*'`) or contribution IDs (e.g. `'terminal'`, `'subagent'`, `'review'`). Everything must be dynamically discovered via contribution registries and extension slots.
    - **Pure Zustand Stores**: Zustand stores (`frontend/src/stores/`) are pure state containers with zero side effects. Never perform I/O, IPC, capability invocations, bridge calls, or async business orchestration inside stores; use `HostServices` (`frontend/src/application/services/tokens.ts`) or application events.
    - **Zero Circular Dependencies**: All production code MUST maintain zero circular dependency strongly connected components (SCC = 0, checked with Tarjan's algorithm).
    - **Zero Legacy Paths & Deprecated Symbols**: No obsolete directories (`frontend/src/plugins/core/*`, `src/main/plugins/bundled/*`), no `definePlugin`, no `fallback-protocol-session`.
    - **Architecture Gate Enforcement**: After modifying any plugin, host component, store, or service, `pnpm check:plugin-architecture` MUST pass with 0 violations in enforce mode.
- **Storage and Configuration Constraint**:
  - All application settings, session records, conversation messages, project states, window state, and global resources MUST be stored centrally under `~/.coding-professional-agent/` and MUST NOT be scattered across disparate OS-specific config directories.
  - Layout under `~/.coding-professional-agent/`:
    - `sessions/data.db`: Persisted SQLite database storing session metadata, session entries, subagents, conversation turns, and skill invocations with WAL mode for fast querying, ACID transactions, and multi-dimensional metrics aggregation.
    - `sessions/`: Session storage directory containing `data.db` (legacy `sessions/<sessionId>.json` files automatically migrated to SQLite on access).
    - `settings.json`: Persisted global application settings and configuration.
    - `projects.json`: Persisted workspace projects list.
    - `cached_models.json`: Cached model catalog entries from remote endpoint.
    - `shortcuts.json`: Persisted keyboard shortcut settings and mappings.
    - `ui.json`: Window bounds, positions, display state, UI layout state, and UI appearance settings.
    - `schedule.json`: Persisted scheduled tasks configuration and schedule items list.
    - `AGENTS.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`: Global instructions and prompt overrides.
    - `skills/`: Global user skills.
    - `prompts/`: Global prompt templates.
    - `plugins/`: Global external plugins.
- Project resources live under `<project>/.cpa/` (and project `AGENTS.md`).
- **UI & Component Constraints**:
  - **No Native Select Elements**: Never use native `<select>` HTML elements in UI components. Always use custom select-only combobox components (such as `CustomSelect` from `@/components/ui/CustomSelect`) to ensure cross-platform visual consistency and accessibility.
  - **macOS-Style Non-System Overlay Scrollbars**: All scrollbars across the application MUST use the custom macOS-style non-system overlay scrollbar system (`frontend/src/lib/macScrollbar.ts`). Native browser scrollbars are hidden globally (`*::-webkit-scrollbar { display: none; }` and `* { scrollbar-width: none; }`). The custom scrollbars float over content without displacing layout, appear dynamically ONLY when scrolling (idle mouse movement over the container or edge does NOT show scrollbars, perfectly matching native macOS behavior), smoothly fade out with a transition animation when scrolling stops, expand from 6px to 10px with increased contrast when hovered or dragged while visible, dynamically lock and sync to container edges across sidebar dragging and layout resizes (persisting throughout the entire fade-out period with zero residual displacement), and feature macOS-style inset margins and rounded pill-shaped thumbs. Suppressing scrollbars for specific horizontal tabs or toolbars should strictly use utility classes `.no-scrollbar` or `.scrollbar-none`.
  - **Typography & Theme Color Consistency**: When creating new pages, views, dialogs, drawers, components, or UI elements, they MUST strictly follow and inherit the user's system font settings (`--font-sans`, `--font-mono`, `--ui-font-size`, `--font-weight-ui`, `font-[inherit]`) and CSS theme color tokens (`var(--bg-app)`, `var(--bg-card)`, `var(--bg-elevated)`, `var(--bg-sidebar-hover)`, `var(--text-primary)`, `var(--text-secondary)`, `var(--text-muted)`, `var(--border-subtle)`). Never hardcode rigid fixed font families, fixed font weights, or arbitrary standalone colors that bypass user appearance preferences.
  - **Browser & Web Server UI Build Requirement**: The built-in Web Server serves static frontend assets directly from `frontend/dist/`. Whenever frontend or browser-related UI, views, components, or logic are modified, `pnpm build` (or `pnpm --dir frontend build`) MUST be executed to rebuild the frontend assets so that changes take effect in browser environments.

## Common commands

```bash
pnpm dev                       # Vite + Electron development
pnpm build                     # production build (packages + frontend + electron main)
pnpm test                      # run all unit tests (packages + frontend + electron)
pnpm check:plugin-architecture # run architecture boundary and cycle scanner (enforce mode)
pnpm cpa-profile               # AI-friendly CPU profiling & hotspot diagnostics (or pnpm run profile)
pnpm package                   # package production app with electron-builder
```

## Directory structure

```text
.
├── packages/
│   ├── plugin-api/         # Public contracts, manifests, capabilities, contributions
│   ├── plugin-kernel/      # Plugin catalog, resolver, runtime, registry, lease
│   ├── plugin-sdk/         # definePluginEntry, manifestValidator, test harness, adapters
│   ├── plugin-ui/          # Reusable UI primitives (CustomSelect, ExtensionSlot, PluginSurface, etc.)
│   └── context-usage/      # Shared token usage ring and calculation utilities
│
├── plugins/
│   └── bundled/            # 22 bundled core plugin package roots (manifest.json + main/renderer/agent entries)
│
├── src/
│   ├── main/               # Electron main process (lifecycle, IPC, native services, plugin sources)
│   │   └── plugins/        # Main catalog, capabilities, sources, loading, runtime, storage, generated loaders
│   ├── preload/            # Electron preload contextBridge (scoped capability transport)
│   └── shared/             # Shared types and capability descriptors across main and renderer
│
├── frontend/
│   ├── src/
│   │   ├── app/            # App shell, dynamic router, providers
│   │   ├── application/    # Host services, action registry, view registry
│   │   ├── components/
│   │   │   ├── chat/       # Contribution-driven message list and tool cards
│   │   │   ├── composer/   # Provider-driven input shell, attachment & control slots
│   │   │   ├── layout/     # Dynamic sidebar, title bar, session list
│   │   │   ├── settings/   # Contribution-driven settings navigation & sections
│   │   │   ├── subagent/   # Plugin-agnostic right panel host
│   │   │   └── ui/         # shared controls, toasts
│   │   ├── features/
│   │   │   ├── agent/      # AgentService interface + stream hook
│   │   │   ├── agent-runtime/  # Kernel (generation snapshots, loop, providers)
│   │   │   └── models/     # Model catalog client
│   │   ├── plugins/
│   │   │   ├── platform/   # Renderer & Agent runtime hosts, coordinators, registries, loaders
│   │   │   └── generated/  # Auto-generated bundled plugin loader tables (bundledPluginLoaders.ts)
│   │   ├── stores/         # Zustand: pure state containers
│   │   ├── i18n/           # en + zh-CN
│   │   └── lib/
│   └── package.json
│
├── test/                   # Main process service unit tests & platform integration tests
├── scripts/                # Development, architecture scan, and catalog generation scripts
└── bin/                    # local build output (gitignored)
```

## Performance Profiling & AI Hotspot Diagnostics

The project features a built-in, AI-friendly V8 CPU profiling and automated hotspot diagnostic engine (`scripts/profile.mjs`, `src/main/services/profilingService.ts`, `src/main/services/profilingAnalyzer.ts`).

### CLI Usage

Execute the profiler from the repository root:

```bash
pnpm profile [options]
```

#### Runnable Examples

```bash
pnpm cpa-profile                  # Default 5s full-stack CPU profile capture (or pnpm run profile)
pnpm cpa-profile --duration 10s   # Capture a 10-second profile
pnpm cpa-profile --format json    # Output structured JSON diagnostic report
pnpm cpa-profile --spawn          # Auto-spawn a temporary dev instance if server is not running
pnpm cpa-profile --save-raw       # Save raw V8 .cpuprofile dumps into .profiles/ directory
pnpm cpa-profile -h               # Show CLI options and usage help
```

#### CLI Options

- `-d, --duration <duration>`: Sampling duration, e.g. `5s`, `10s`, `5000ms`, or `5000` (default: `5s`).
- `-t, --target <target>`: Sampling target: `main` (Electron Main process), `renderer` (Renderer process), or `all` (Full-stack Main + Renderer + Plugins, default: `all`).
- `-f, --format <format>`: Output format: `markdown` (formatted report) or `json` (structured JSON payload, default: `markdown`).
- `--spawn`: Automatically spawns a temporary development instance (`pnpm dev` with `CPA_PROFILE=1`) if the Web Server is not already running, waits for readiness, performs profiling, and cleanly tears down the spawned process upon completion.
- `--save-raw`: Saves the raw V8 `.cpuprofile` JSON dump into the `.profiles/` directory for visual flamechart inspection in Chrome DevTools or SpeedScope.
- `-o, --output <file>`: Writes the generated formatted Markdown or JSON diagnostic report to the specified file path.
- `-p, --port <port>`: CPA WebServer port (default: `18080`).
- `--host <host>`: CPA WebServer host (default: `127.0.0.1`).

### AI Agent Automated Hotspot Parsing & Optimization Workflow

When an AI coding subagent or developer runs `pnpm profile` (or `pnpm profile -f json`), the diagnostic engine automatically analyzes the call tree and groups execution metrics into structured sections:

1. **Summary & System Health**:
   - Total active CPU load percentage and libuv event loop average latency (`eventLoopDelayMs`).
2. **Top 10 CPU Hotspots Table**:
   - Functions ranked by self-execution time (`selfTimeMs`), total time (`totalTimeMs`), and active CPU percentage (`selfTimePercent`).
   - Exact source locations formatted as `filePath:line:column` and architectural module categorization aligned with `ProfilingAnalyzer.inferModule()` (`Main Service`, `Electron Main`, `React / UI`, `SQLite DB`, `Agent Runtime`, `Plugin`, `Preload Bridge`, `External Dependency`, `Node.js Core`, `App`).
3. **Bottleneck Classifications**:
   - `SYNC_BLOCKING_IO`: Synchronous filesystem I/O operations (`readFileSync`, `writeFileSync`, `statSync`, `readdirSync`) that block the main event loop.
   - `SQLITE_SLOW_OPERATION`: Heavy database operations, missing column indexes, or unbatched SQLite transactions.
   - `FREQUENT_IPC`: High overhead from inter-process communication serialization or unthrottled event broadcasts.
   - `REACT_EXCESSIVE_RENDER`: Expensive React reconciliation, unnecessary re-renders, or missing memoization hooks in renderer components.
   - `EVENT_LOOP_DELAY`: Heavy CPU-bound synchronous logic causing libuv event loop lag (> 50ms).
   - `PLUGIN_PERF_REGRESSION`: Plugin lifecycle hooks exceeding execution latency thresholds (> 10ms single hook call or > 50ms cumulative).
   - `CPU_INTENSIVE`: Heavy computational algorithms occupying significant CPU cycles.
4. **Actionable AI Optimization Directives (`aiSuggestions`)**:
   - Precise refactoring directives tagged with `category` (e.g. `ASYNC_IO_REFACTOR`, `DATABASE_BATCHING`, `IPC_BATCHING_AND_DEBOUNCE`, `REACT_MEMOIZATION`, `EVENT_LOOP_OPTIMIZATION`, `PLUGIN_OPTIMIZATION`, `ALGORITHM_OPTIMIZATION`) and targeted source positions (`targetFile:targetLine`).
   - AI agents should parse these suggestions, navigate directly to the identified source code lines, implement the recommended asynchronous refactoring or memoization, and re-run `pnpm profile` or test suites to verify performance gains.

### Dev Mode Profiling & File Export

In Development Mode (`import.meta.env.DEV` or `window.cpa.isDev`), a dedicated Performance Profiling button featuring the `Activity` icon (located directly to the left of the Settings button in the sidebar footer) is rendered:

> **Note**: The profiling button is rendered **ONLY** in Development Mode (`import.meta.env.DEV` or `window.cpa.isDev`). Setting `CPA_PROFILE=1` enables the backend profiler in packaged/release builds for CLI and API usage, but does not render the UI button in production builds.

- **Start Profiling**: Clicking the `Activity` button initiates a 60-second full-stack (`target: all`) CPU profiling session with a live countdown display and pulse animation.
- **Stop & Export**: Clicking the button during an active profiling session (or allowing the 60-second timer to elapse) stops the session, processes the samples through the diagnostic analyzer, and exports the markdown report as `cpa-profile-report-YYYY-MM-DD-HHmmss.md` (via native file save dialog in Electron, or automatic web browser download fallback when running in browser mode).


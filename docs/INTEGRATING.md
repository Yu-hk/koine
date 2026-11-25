# Integrating into a project

The plugin is a development-time tool. It runs inside DeepSeek Harness, in Node, and produces
two kinds of artifact that a project consumes:

| Artifact | Lives in the project | Purpose |
| --- | --- | --- |
| `bridge-contract.json` | version control | the one shared fact between languages |
| generated client or server skeleton | version control | ordinary source code, compiled by the project |

A Java project never depends on this plugin, and neither does a Python one. They depend on the
generated code. Only one thing is different when a project also needs the bundled LangGraph
service at runtime, and that case is covered by mode B below.

## Three modes

### A. Development only (default)

```
plugin in DSH  ->  generated sources  ->  committed  ->  project builds and runs as usual
```

No runtime dependency, no configuration in the project. The contract and the generated code are
reviewable, and CI can detect drift.

### B. Development plus a resident service

Needed only when the project's orchestration depends on the bundled LangGraph service. Three
owners are implemented; pick one:

| Owner | How | Lifetime |
| --- | --- | --- |
| The plugin | `bridge_service({ action: "start" })` | stops when the plugin unloads |
| The plugin, detached | `bridge_service({ action: "start", detached: true })` | survives the session, explicit stop |
| The application | `lab.embed.autostart=true` and `lab.embed.root=<plugin dir>` | starts and stops with the application |

Production should use the third: the application starts the service, writes the discovery file
and reaps it on shutdown. The discovery file is the contract between them; a consumer reads
`langgraph-service.json` instead of hard-coding a port.

### C. Headless in CI

The generators are plain ES modules, so a CI job does not need DeepSeek Harness. A short wrapper
is enough:

```js
// scripts/generate.mjs
import { loadContractFile, writeFiles } from '@local/polyglot-bridge/lib/io.js'
import { generateJavaClient } from '@local/polyglot-bridge/lib/gen-java.js'

const [contract, outDir, packageName] = process.argv.slice(2)
const generated = generateJavaClient(loadContractFile(contract), { packageName })
writeFiles(outDir, generated.files)
```

Then two CI gates:

```sh
node scripts/generate.mjs contracts/orders.bridge.json src/main/java com.acme.orders.bridge
node ../polyglot-bridge/scripts/check-vendor.mjs          # dependency tree intact
node ../polyglot-bridge/scripts/check-typescript.mjs      # if a TS client is generated
git diff --exit-code                                       # generated code is up to date
```

The last line is the drift gate: if regeneration changes tracked files, the contract and the code
have drifted apart.

## By project type

### Java / Spring

| Role | Target | Placement |
| --- | --- | --- |
| Calls another service | `java-client` | its own package, for example `com.acme.orders.bridge.client` |
| Is called by another language | `java-server` | the generated interface; implement it in a `@RestController` |
| Needs the orchestrator at runtime | mode B, application-owned | `lab.embed.root` points at the plugin directory |

The generated client exposes `ErrorBodies.decode(error)` for declared error bodies, and streaming
endpoints return `InputStream`. Do not edit generated sources; regenerate from the contract.

### Python / FastAPI

Called side: mount the generated router.

```python
from orders.router import router as orders_router
app.include_router(orders_router, prefix="/api")
```

Calling side: use the generated package directly. It has no third-party dependency (`urllib` and
`dataclasses`), which matters in constrained environments. Streaming endpoints are generators,
so consume them with `for chunk in client.stream_thread(...)`.

### Node / TypeScript

The generated `src/client.ts` is types plus `fetch`; there is no runtime dependency. Put it under
`src/api/`. To add authentication or retries, pass a wrapped `fetch`:

```ts
const client = new OrdersClient(baseUrl, (input, init) =>
  fetch(input, { ...init, headers: { ...init?.headers, authorization: token } }))
```

Streaming endpoints are `AsyncGenerator`s, consumed with `for await`.

### Other languages

Extraction works for anything that can export OpenAPI, serve its own document, or provide a
Postman collection. Generation currently supports Java, Python and TypeScript clients and Java
and Python server skeletons. A Go or C# project can therefore be a *called* side today, and a
calling side once a generator for its language exists (see `ADDING-A-LANGUAGE.md`).

## Repository layout

```
repo/
  contracts/orders.bridge.json     the shared fact, reviewed like code
  services/orders/                 the service, any language
  clients/web/                     generated TypeScript client
```

Three rules:

1. **Commit the contract.** It is the only artifact both sides agree on.
2. **Commit the generated code.** Reviewers see the change; CI can detect drift. Generating at
   build time hides both.
3. **Never edit generated files.** Change the contract and regenerate; a manual edit is lost on
   the next run.

## Anti-patterns

| Do not | Why |
| --- | --- |
| Have the application call the plugin | it is a Node module that only exists inside DeepSeek Harness |
| Make the plugin a build dependency | build agents rarely have the harness; use mode C instead |
| Hand-edit a generated client | it will be overwritten; fix the contract |
| Keep the contract only in the plugin's cache | it disappears with the machine and cannot be reviewed |
| Trust a contract without checking it | extract again from the live service and run `bridge_check` |

## Versioning and drift

- Generated files carry a `generated by` line in their README, so a diff can be traced to a plugin
  version.
- **Contract drift**: `bridge_check(contract, "http://service")` after deployment finds "deployed
  but not committed" and "committed but not deployed".
- **Code drift**: `bridge_check(contract, projectDir)` or the `git diff --exit-code` gate above
  finds a contract that changed without regeneration.

## Checklist for a new project

1. Find the document: `bridge_discover({ projectDir })` or `bridge_discover({ url })`.
2. Extract: `bridge_extract(...)`, then read `warnings` before trusting the result.
3. Commit `bridge-contract.json`.
4. Generate the client for the calling side; generate the server skeleton if this project is the
   called side.
5. Compile what was generated: `mvn compile`, `python -m compileall`, or `tsc --noEmit`.
6. Add the drift gate to CI (mode C).
7. Only if the project needs orchestration at runtime: enable `lab.embed.autostart` and point
   `lab.embed.root` at the plugin directory.

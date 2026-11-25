# Remaining work

> 中文版：[ROADMAP.zh-CN.md](ROADMAP.zh-CN.md)



Ordered by value. Each item records the exact anchor and the acceptance check, so it can be
finished in one pass without re-discovery.

## Done

- **Enum types.** `ir.js` has `enumOf`/`enumConstant`; `makeContract` keeps a model's `kind`
  and `values`; the OpenAPI adapter turns a component `enum` into its own model; all four
  generators emit `enum` (Java, with `@JsonValue`) or `class X(str, Enum)` (Python). Scalar
  types may also carry `values`, so `bridge_check` reports a changed value set as breaking.
- **Detached service lifetime.** `bridge_service start --detached` spawns the service with
  `detached: true` + `unref()` and routes its stdio to the log file, so unloading the plugin
  no longer stops it; `stop({ dispose: true })` leaves a detached instance running.
- **Discovery re-resolved at call time.** `RemoteLangGraph` re-reads
  `langgraph-service.json` before every call and rebuilds its client when the URL changed;
  `LangGraphConfiguration` passes only the explicit setting through, so a supervised restart
  on a new port is followed without an app restart. Verified: `58099` → `65059` while the app
  kept running.
- **`oneOf`/`anyOf` warnings.** Degrading to `json` is no longer silent: the contract carries
  a warning naming the schema.
- **Operation summaries.** Spring Javadoc becomes the operation `summary` (falling back to
  `Controller.method`), and both generated `README-BRIDGE.md` files carry a route table with a
  Summary column, so a caller can tell what an operation does without reading the service.
- **Application-owned lifecycle.** `lab.embed.autostart` + `lab.embed.root` let the app start
  the vendored service itself, wait for health, and publish the discovery file; `@PreDestroy`
  stops only a service it started. Verified: the app starts the service, the discovery file
  names `runtime: embedded`, and `/health` answers.
- **Worker-base guard.** `lab.graph-backend=langgraph` with an empty
  `lab.langgraph.worker-base` now fails startup: without a callback address the first node
  call fails and the run silently degrades, which reads as an orchestration bug.
- **Event loop no longer blocked.** `orchestrate_preflight`/`orchestrate_resume` run the
  blocking `graph.invoke` through `asyncio.to_thread`. Verified during a real run: seven
  `/health` probes all 200, worst case 12 ms.
- **Vendor content hash.** `scripts/check-vendor.mjs --record` stores a digest of the whole
  `vendor/` tree; a plain run compares it, so an in-place replacement is detected even when the
  version still matches. Verified by tampering with one file.
- **Discriminated unions.** A named `oneOf` with a `discriminator` becomes a union model:
  `unionOf` in the IR, `@JsonTypeInfo` interface in Java, `Payment = Card | Cash` in Python,
  and `bridge_check` grades removed variants / changed tags / changed discriminators as
  breaking and added variants as additive. Inline or undiscriminated unions stay `json` with a
  warning that names the branches. Verified end to end, including generation on both sides.
- **Non-blocking pause, in-node included.** `awaitResume` reports a pause instead of waiting,
  and `checkpoint()` no longer blocks on the orchestrated backend; the graph parks on a
  checkpoint and the node is replayed after the resume. Verified by pausing during
  `recommendations` (a `checkpoint()` caller): the service answered `/health` in 12 ms and the
  run resumed to the gate.
- **Startup guards.** `lab.access-token` with the orchestrator backend, and an empty
  `lab.langgraph.worker-base`, both fail startup with an actionable message instead of
  degrading silently at the first node.

- **TypeScript client target.** `lib/gen-typescript.js` emits a `fetch` client plus model
  interfaces: enums become literal unions, discriminated unions become real TypeScript unions.
  Verified by compiling with `tsc --noEmit` under `strict`, wired as `scripts/check-typescript.mjs`
  so it runs without a human. This is also the worked example for `docs/ADDING-A-LANGUAGE.md`.
- **Streaming in every client.** An endpoint marked `streaming` produces a real consumer:
  `AsyncGenerator<string>` over `ReadableStream` in TypeScript, `InputStream` in Java, a generator
  in Python. The OpenAPI adapter detects `text/event-stream` responses, and the bundled service
  now declares that media type on its own SSE route. Asserted in `test/smoke.mjs` (26 checks) and
  compiled in all three languages.
- **Multi-service convention.** `VENDOR.md` records how a second bundled service would be laid
  out (`services/<name>/`) and why the physical move is deferred: the app resolves `<root>/service`
  and the checkpoints live inside it.
- **Per-platform build checklist.** `PLATFORMS.md` documents what to vendor, how to verify, and
  the per-platform traps (locked `.pyd` files on Windows, glibc floors on Linux, per-arch wheels on
  macOS, arm64 wheel availability).

## Remaining

Nothing functional is outstanding. Everything below was completed and verified: enum types,
discovery re-resolution, `oneOf` warnings, error-response bodies, the non-blocking pause
protocol (node entry and in-node checkpoints), application-owned lifecycle, and the vendor
content hash. What is left is housekeeping:

- `ROADMAP.md` and `README.md` stay in sync with behaviour (do this whenever behaviour changes).
- `vendor/` must be re-vendored with the single pip command documented in `VENDOR.md`;
  run `node scripts/check-vendor.mjs --record` afterwards and commit `vendor-lock.json`.
- The bundled runtime is Windows x64 only; another platform needs its own tree under
  `runtime/<platform>-<arch>/` plus its own `vendor/`.

## Known traps (learned the hard way)

- **`normalizeType` drops anything it does not know.** Any new contract field must be added
  there first, or it vanishes silently.
- **`pip --target` namespace collisions.** `langgraph` and `langgraph-checkpoint-sqlite` share
  the `langgraph/` directory; installing either alone deletes the other's files. Always install
  them in one command (see `VENDOR.md`).
- **Never rewrite JS sources through PowerShell.** `Set-Content -Encoding UTF8` corrupted
  arrow characters and template literals twice; use the editor's byte-exact replace.
- **`default` is a reserved word.** `const default = …` in generated-string code fails at module
  load time, which only shows up when the module is imported.
- **Tool output must be lossless JSON.** Returning `undefined` for an optional field fails the
  caller's validation; default every field (`notes: generated.notes ?? []`).

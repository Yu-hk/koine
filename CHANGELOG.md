# Changelog

> 中文版：[CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md)



Two audiences read this file: the person running the plugin, and the project that depends on its
output. Every entry says which of these it affects, because that decides whether a project must
regenerate its sources after upgrading.

| Tag | Meaning | Project action |
| --- | --- | --- |
| **generated** | the emitted code changes | regenerate and review the diff |
| **service** | the bundled Python service changes | restart the service; check `/health` |
| **tool** | tool behaviour or arguments change, output unchanged | none, unless you script it |
| **docs** | documentation only | none |

Version discipline: a change to **generated** or **service** that a consumer can notice is a
minor or major bump; a fix that leaves both unchanged is a patch. IR changes, and any removal of a
tool argument, are major and need a migration note.

## 1.1.0

### Generated code

- **TypeScript client target** (`typescript-client`): `fetch` plus interfaces, enums as literal
  unions, discriminated unions as real TypeScript unions. Compiled with `tsc --noEmit` under
  `strict` by `scripts/check-typescript.mjs`.
- **Streaming endpoints** now produce a real consumer in every client: `AsyncGenerator` over
  `ReadableStream` (TypeScript), `InputStream` (Java), a generator (Python). Previously Java and
  Python threw `UnsupportedOperationException`.
- **Enum types**: named enums become `enum`/`Enum` with explicit wire values (Java `@JsonValue`),
  and an enum model no longer has to have fields to be emitted.
- **Discriminated unions**: a named `oneOf` with a `discriminator` becomes a union model, emitted
  as a `@JsonTypeInfo` interface (Java) or a union type (TypeScript, Python).
- **Error bodies**: operations carry `errors` separately from success responses; clients expose
  `ErrorBodies.decode` (Java), `decode_error` (Python), `decodeError` (TypeScript).
- **Operation summaries** come from Javadoc when present, and both generated READMEs carry a
  route table with a Summary column.
- **`.bridge-manifest.json`** is written next to generated sources: plugin version, IR version,
  contract hash, target, timestamp.

### Bundled service

- The SSE route declares `text/event-stream`, so any OpenAPI consumer recognises it as a stream.
- Orchestration runs on a dedicated thread pool, and the blocking `graph.invoke` no longer runs on
  the event loop: `/health` stays responsive during a run.
- A paused run no longer holds a thread: the worker reports the pause and the graph parks on a
  checkpoint, then replays the node after the resume.
- Checkpoints persist in SQLite, so a run parked on a human gate survives a service restart.

### Tools

- **`bridge_discover`** (new): find candidate documents in a project or on a running service,
  ranked with evidence. Machine-readable documents are `high`, Markdown is `pointer-only`, YAML is
  `unsupported`.
- **`bridge_extract`**: accepts a running service (`url`, with `headers`), prefers an exported
  OpenAPI document, reads Postman collections (`framework: "postman"`, marked `partial`), detects
  SSE endpoints, and probes six conventional document routes.
- **`bridge_check`**: either side may be an http(s) URL, and `failOn` turns the comparison into a
  gate (A is the baseline, B the candidate).
- **`bridge_service`**: `detached` lets the service outlive the editor session; `restart` recovers
  from a wedged instance.
- Dependency tree is checked against a content hash (`scripts/check-vendor.mjs --record`).

### Repository

- Frozen service contract in `service/bridge-contract.json`, guarded by
  `scripts/check-service-contract.mjs` (fails on breaking drift).
- `scripts/parity.mjs` and `scripts/verify-orchestration.mjs` live in the project repository.
- Documentation: `README.md`, `ROADMAP.md`, `VENDOR.md`, `PLATFORMS.md`,
  `docs/ADDING-A-LANGUAGE.md`, `docs/INTEGRATING.md`.

## 1.0.0

First version: contract extraction for FastAPI, Flask and Spring; Java and Python clients; Java
and Python server skeletons; contract diff with graded severity; bundled CPython runtime with a
LangGraph service managed by `bridge_service`.

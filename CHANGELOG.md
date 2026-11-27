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

- **Multipart uploads, end to end.** A request body declared as `multipart/form-data` is modelled as
  a record whose fields are the parts; a `format: binary` part becomes `bytes`. Clients send real
  multipart bodies (Python encodes it itself, the async client uses httpx `files`/`data`, TypeScript
  uses `FormData`, Java a `MultiValueMap` with a `ByteArrayResource` per file), the generated
  contract test sends a real file part instead of skipping, and the server skeletons accept the
  parts (`UploadFile`/`File`/`Form` in FastAPI, `@RequestPart` + `MultipartFile` in Spring). The
  FastAPI skeleton needs `python-multipart`, which the generator reports as a note.
- **Multipart uploads.** A request body declared as `multipart/form-data` is modelled as a record
  whose fields are the parts; a `format: binary` part becomes `bytes`. Clients send real multipart
  bodies: Python builds the body itself (a `bytes` part travels as a file), the async client uses
  `httpx` `files`/`data`, TypeScript uses `FormData`, and Java uses a `MultiValueMap` with a
  `ByteArrayResource` per file. A generated contract test skips such a route **visibly** rather than
  sending JSON to a multipart endpoint. Server skeletons do not declare upload parts yet.
- **Binary and text response bodies.** A response declared as `text/*` becomes `string`, and any
  other non-JSON body (`application/octet-stream`, `image/*`, …) becomes `bytes`. Clients no longer
  try to JSON-decode a download: Python returns `bytes` raw, TypeScript returns an `ArrayBuffer`,
  Java returns `byte[]`. A bodyless or SSE response stays `void`, and the generated contract tests
  assert the status for a binary body without pretending to shape-check bytes.
- **`nullable` is modelled.** A field or parameter may now carry `nullable: true` — read from
  OpenAPI 3.0 `nullable` or a 3.1 `null` member in `type`. It is a different promise from
  `required`: the value may be `null`, which Python renders as `str | None`, TypeScript as
  `string | null`, and Java as a boxed type (`Long`, not `long`). Contract tests accept `null` only
  where the contract allows it, and any change to nullability is graded breaking in both directions.
- **Header parameters reach the wire.** A contract that declares `in: header` used to record the
  parameter and then drop it: no client sent it, no test exercised it, no skeleton accepted it. All
  five targets now carry it — clients set it, the test suite sends required ones, and the FastAPI
  and Spring skeletons declare it with `Header(..., alias=…)` / `@RequestHeader`.
- **Basic credentials are encoded once.** Every client now takes `user:password` and encodes it
  itself; TypeScript and Java previously expected an already-encoded value, so the same credential
  produced different headers per language.
- **Contract tests read credentials per scheme.** `BRIDGE_API_KEY_<SCHEME>` and
  `BRIDGE_TOKEN_<SCHEME>` win over the generic variables, so a contract with two schemes can be
  exercised with two different values.
- **Authentication modelling.** The contract carries named schemes (`http` bearer/basic, `apiKey` in
  a header or query, `oauth2` as a bearer token), a contract-wide default and a per-route override;
  routing the credentials is the client's job, and the graders treat a changed requirement as
  breaking. Python and TypeScript clients take one credential per scheme and raise before sending
  when a required one is missing; generated contract tests read them from `BRIDGE_TOKEN` /
  `BRIDGE_API_KEY` and skip loudly when absent.
- **`python-async-client` target**: an `httpx.AsyncClient` client for an await-based codebase. It
  reuses the sync target's models and error types, so the two clients cannot disagree about a type;
  only the transport differs. It needs httpx, which the sync target does not.
- **`python-contract-tests` target**: a stdlib `unittest` suite that calls the service and checks
  every response against the declared shape, so "does the deployed service still match its
  contract" becomes executable instead of arguable. Run it with `BRIDGE_BASE_URL` set.
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

- **`bridge_validate`** (new): check a contract against the contract rules and get one-line errors
  naming each problem, for a contract composed by hand or by a model. The same check is exposed
  over MCP, together with `bridge://schema/contract` describing the shape to write.
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

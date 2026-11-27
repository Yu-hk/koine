# Koine

> 中文版：[README.zh-CN.md](README.zh-CN.md)

One contract, many languages. Koine (*koinē*, the shared Greek that let different speakers
understand each other) extracts a language-neutral HTTP contract from a service, then generates
typed clients and server skeletons in the target language. The two sides never share a runtime;
they share an interface description. The tools keep the `bridge_*` prefix, because bridging is what
they do.

```
FastAPI / Flask / Spring project  \
exported openapi.json               >-- bridge_extract -->  bridge-contract.json
running service (its own document) /

  bridge_discover: find the candidates first, with evidence
        |
        v
                    +---------------------------------------+
                    |                   |                   |
             java-client        python-client        typescript-client
             java-server        python-server
                    |
                    +-- bridge_check: drift, graded breaking / additive / cosmetic
                        either side may be a file, a directory or a live URL
```

## Quick start

```js
// 1. Read the service: source tree, an exported document, or a live URL.
bridge_extract({ projectDir: "D:/work/api" })
bridge_extract({ url: "http://127.0.0.1:8080", outFile: "D:/work/contract.json" })

// 2. Generate for the caller.
bridge_generate({ contract: "...", target: "typescript-client", outDir: "D:/work/web" })
bridge_generate({ contract: "...", target: "java-client",       outDir: "D:/work/svc", packageName: "com.acme.api" })

// 3. Compare two contracts, or a contract against a project.
bridge_check({ contractA: "contract.json", contractB: "D:/work/api" })
```

## Tools

The same engine is also exposed over MCP for other AI clients: see `mcp/README.md`.

| Tool | Purpose |
| --- | --- |
| `bridge_discover` | Where is the document? Scans a project (`projectDir` + optional `keywords`) or probes a running service (`url`) and returns every candidate with evidence: which keyword matched where, route count, and a trust level. OpenAPI/Swagger JSON is `high`, Markdown is `pointer-only`, YAML is `unsupported`. It never picks one for you. |
| `bridge_extract` | Service -> contract. Reads FastAPI, Flask or Spring source, an exported `openapi.json`, a Postman collection, or a running service's own document (`url`, with optional `headers`). When a machine-readable document exists it wins, because it describes what is deployed. |
| `bridge_generate` | Contract -> code. Clients: `java-client` (Spring `RestClient` plus Jackson records), `python-client` (standard library only), `python-async-client` (httpx, for an await-based codebase), `typescript-client` (`fetch` plus interfaces, streaming endpoints as async generators). Server skeletons: `java-server` (Spring MVC interface plus records), `python-server` (FastAPI router plus pydantic models), and tests: `python-contract-tests` (checks a service's responses against the contract, run with `BRIDGE_BASE_URL`), `python-client-tests` (drives the generated client against a recording stub and asserts the requests it sends). |
| `bridge_check` | Contract vs contract. Reports route, parameter, request/response and model differences, each graded breaking, additive or cosmetic. |
| `bridge_validate` | A contract vs the contract rules. One-line errors that name each problem, for a contract composed by hand or by a model. Extracts nothing, writes nothing. |
| `bridge_service` | Lifecycle for the Python service bundled inside this plugin: `start`, `stop`, `restart`, `status`. No Docker and no system Python; `detached` lets it outlive the editor session. |

## Usage, step by step

**0. If you do not know where the document is, ask first.** Do not trust a path a user
remembers; find the candidates and look at the evidence.

```js
bridge_discover({ projectDir: "D:/work/api", keywords: ["orders"] })   // scan a tree
bridge_discover({ url: "http://127.0.0.1:8080" })                      // probe a service
```

Each candidate comes with `trust` and the reason it matched. A `pointer-only` row is a hint
where to look, never a contract source; `unsupported` means the document exists but this plugin
cannot parse it (YAML today).

**1. Decide where the contract comes from.** Three options, in order of preference:

| Source | Call | When |
| --- | --- | --- |
| A running service | `bridge_extract({ url, outFile?, headers? })` | The service is deployed; this reflects what is really serving |
| An exported document | `bridge_extract({ projectDir })` with `openapi.json` or `swagger.json` in the root | A document is committed or published |
| A Postman collection | `bridge_extract({ projectDir: ".../x.postman_collection.json" })` | Only artifacts of the API exist; routes are reliable, response models are `json` |
| Source code | `bridge_extract({ projectDir })` | Neither exists yet; the extractor reads FastAPI, Flask or Spring |

**2. Extract and read the result.** The contract is a JSON file; check `warnings` first — they
name anything the extractor could not represent (dynamic routes, inline unions, dynamic imports).

```js
bridge_extract({ projectDir: "D:/work/api" })            // writes D:/work/api/bridge-contract.json
bridge_extract({ url: "http://127.0.0.1:8080", outFile: "D:/work/contract.json" })
```

**3. Generate for the caller.** Pick the target language and give `outDir` a directory this
plugin may write to; it refuses a non-empty directory it did not create unless `overwrite: true`.

```js
bridge_generate({ contract: "D:/work/contract.json", target: "java-client",
                  outDir: "D:/work/svc", packageName: "com.acme.api", serviceName: "orders" })
bridge_generate({ contract: "D:/work/contract.json", target: "python-client",
                  outDir: "D:/work/py", moduleName: "orders_client" })
bridge_generate({ contract: "D:/work/contract.json", target: "typescript-client",
                  outDir: "D:/work/web", serviceName: "orders" })
```

**4. Optionally generate the other side.** The service targets produce the skeleton the
implementation fills in: a Spring MVC interface with annotations, or a FastAPI router with
pydantic models. An implementation that compiles is one the contract promises.

```js
bridge_generate({ contract: "...", target: "java-server", outDir: "D:/work/api", packageName: "com.acme.api" })
bridge_generate({ contract: "...", target: "python-server", outDir: "D:/work/api", moduleName: "orders" })
```

**5. Compile what you generated.** Generated code is only trustworthy once a compiler has seen
it. The commands used in this repository:

```sh
mvn -o -B -q -f <javaOut>/pom.xml -DskipTests compile     # Java: needs spring-web on the classpath
python -m compileall -q <pythonOut>                       # Python
node node_modules/typescript/bin/tsc -p <tsOut>           # TypeScript: tsconfig with lib ES2022+DOM, strict
```

**6. Keep the two sides honest.** Compare a contract with the other side, or with the project it
came from. Every difference is graded, so a breaking change is visible before deployment.

```js
bridge_check({ contractA: "D:/work/contract.json", contractB: "D:/work/api" })
bridge_check({ contractA: "D:/work/contract.json", contractB: "http://127.0.0.1:8080" })
```

Either side may be a file, a project directory, or an http(s) URL, so the useful comparisons are
one call each: committed document vs live service ("deployed but not committed"), source tree vs
live service ("committed but not deployed"), or staging vs production.

**7. If you use the bundled service.** The plugin carries its own CPython and its own
site-packages, so no Docker and no system Python are needed:

```js
bridge_service({ action: "start", projectDir: "D:/work/app" })   // writes D:/work/app/langgraph-service.json
bridge_service({ action: "status" })
bridge_service({ action: "stop", projectDir: "D:/work/app" })    // releases that project only
```

A service started normally stops when the plugin unloads; `detached: true` lets it outlive the
editor session. The address is published in `langgraph-service.json`, so a consumer reads that
file instead of hard-coding a port.

## From the caller's side

What someone writing code against a generated client actually sees. The names come from the
contract, so they read like the operations, and each one carries its `summary` as a doc comment
— Javadoc, docstring or TSDoc, depending on the target.

**Java**

```java
public InputStream streamThread(String threadId);   // streaming: read it, do not buffer it
public RunResponse runGraph(RunRequest payload);

var client = new LanggraphClient("http://127.0.0.1:8021");
try {
    var run = client.runGraph(new RunRequest(null));
    System.out.println(run.route());
} catch (RestClientException error) {
    Object detail = ErrorBodies.decode(error);      // typed body, or null
}

// streaming: the caller owns the stream
try (var events = client.streamThread(id)) {
    new BufferedReader(new InputStreamReader(events)).lines().forEach(System.out::println);
}
```

**Python**

```python
run = client.run_graph(RunRequest(...))
try:
    ...
except BridgeHttpError as error:
    detail = decode_error(error)          # declared model for that status, or None

for chunk in client.stream_thread(thread_id):   # generator, consumed as it arrives
    print(chunk, end="")
```

**TypeScript**

```ts
const client = new LanggraphClient("http://127.0.0.1:8021")
const run = await client.runGraph({})            // typed request and response

for await (const chunk of client.streamThread(id)) {
  process.stdout.write(chunk)
}

try {
  await client.runGraph({})
} catch (error) {
  if (error instanceof BridgeHttpError) decodeError(error)   // typed body, or undefined
}
```

Three things are deliberately absent from a generated client: retries, authentication and
caching. Those belong to the caller's policy, and the client is a plain object whose HTTP
plumbing can be replaced (a `fetch` implementation in TypeScript, a `RestClient` in Java).

The caller never learns the wire details: a `decimal` is a number or a `BigDecimal`, an enum is
a literal union or an `enum` with `@JsonValue`, a discriminated union is a real union type. That
mapping is what the contract exists to make predictable.

## What the contract carries

A route is not enough to generate useful code. The contract records, per operation: method,
path, path/query/header parameters with neutral types and defaults, request body, response
statuses, **declared errors** (separate from success responses), a `summary` (from Javadoc or a
docstring), whether the endpoint **streams**, and which **authentication schemes** it requires.
Types cover scalars, lists, maps, references, **enums with their wire values**, and
**discriminated unions**.

Authentication is modelled, not passed through as raw headers: the contract carries named schemes
(`http` bearer/basic, `apiKey` in a header or query, `oauth2` as a bearer token), a contract-wide
default, and a per-route override. Generated clients take one credential per scheme, attach it
where it belongs, and raise before sending when a required credential is missing. Contract tests
read the same credentials from the environment and skip loudly when they are absent.

Everything degrades explicitly: an inline or undiscriminated `oneOf` becomes `json` with a
warning naming its branches, and each generated client is compiled in this repository rather
than merely inspected.

## Scope

The contract is the product; framework coverage is only a means to it. Anything that can
produce an OpenAPI document — Spring, FastAPI, Flask with a spec extension, NestJS, ASP.NET,
Go — is supported by exporting that document or by pointing at a running service's own route.
No new code in this plugin is needed for those.

Source extractors exist for the three cases where a contract usually does not exist yet
(FastAPI, Flask, Spring). They read code to produce a first contract; once a project exports a
document, that document takes precedence.

Deciding on a further framework is therefore a decision, not a default: if it can export
OpenAPI, do not add an extractor. Language version is a generator concern, not a contract
concern — HTTP/JSON does not change with the runtime — so it belongs in generator options, not
in a new adapter. Adding a target language is documented in `docs/ADDING-A-LANGUAGE.md`.

## Internal flow

For anyone changing the plugin, this is what actually happens between a tool call and a file on
disk. Every step is a separate module under `lib/`.

**Extraction.** `extract.js` dispatches to one adapter. The source adapters (`flask-*`,
`fastapi-*`, `spring-extract.js`) scan text, not a real parser: comments and string literals are
masked first, then decorators or annotations are matched. The OpenAPI adapter (`openapi.js`)
reads a document instead, and resolves `$ref`, `allOf`, enums and discriminated unions from
`components.schemas`. Every adapter ends by calling `makeContract`.

**Normalization.** `ir.js` is the gate every value passes through. `makeContract` rebuilds each
operation and model into a fixed shape and runs every type through `normalizeType`, which keeps
only the kinds it knows. This is why a new type or flag must be added there first: anything
`normalizeType` does not recognise is dropped silently, without an error.

**Generation.** Each target is one module returning `{ files }`. Type mapping goes through a
single function per language, so imports and text stay consistent by construction. Models are
emitted by kind: records for field models, native enums, native unions. Anything a target cannot
express is reported through `notes` rather than thrown.

**Comparison.** `diffContracts` keys routes by `METHOD path` and models by name, then compares
parameters, request bodies, responses, fields, enum value sets and union variants.
`severityOf` grades each difference: breaking, additive or cosmetic.

**Service lifecycle.** `sidecar.js` starts the bundled interpreter, health-gates it, publishes
`langgraph-service.json`, supervises restarts and reference-counts projects. `service-tool.js`
exposes exactly that through `bridge_service`.

## What it guarantees

- **Compiles.** Generated Java targets Java 17 + `spring-web` 6.1 + Jackson, and is
  compiled against those in this repository's checks. Generated Python runs on the
  standard library alone.
- **Matches the source.** Contracts come from the source declarations, so the
  parameter types and requiredness the client exposes are the ones the server declares.
- **Honest about gaps.** Anything the scanner cannot resolve is a warning in the
  contract, not a silent omission.

## Limits

- Static analysis only. Routes registered dynamically, built from computed strings,
  or mounted by a plugin are reported as warnings rather than resolved.
- FastAPI source extraction still does not read `Depends`/`Security` into a security
  scheme: authentication is modelled from an OpenAPI document (see *What the contract
  carries*), not inferred from decorators. Header parameters, cookies and multipart
  bodies *are* represented now — cookies only as parameters, not as session state.
- HTTP/JSON boundary. In-process embedding (JNI, Py4J, GraalVM) is deliberately out
  of scope: it couples platform, GC, and version in exchange for a call boundary
  that the network already provides.
- Response bodies whose shape is not a declared model map to `json` (`JsonNode` in
  Java, `Any` in Python).
- Generated clients do not retry or cache. They do carry credentials (the contract's
  security schemes), but token refresh and rotation stay the caller's job.
- Each generated Python package defines its own error classes, so two clients in one
  process are caught separately (`BridgeHttpError` from each package).
- **Enums degrade to plain strings.** A `type: string` schema with `enum` values (or a
  Java `enum` / Python `Enum`) becomes `string` in the contract, so generated clients take
  a free-form string and generated servers declare `String`/`str`. Detecting the value set
  and emitting `enum`/`Enum` types is designed but not implemented; until then treat enum
  validation as the caller's job. `bridge_check` therefore cannot see a widened enum.
- **Postman collections are `partial`.** A collection records examples, not schemas: routes,
  methods, path and query parameters are extracted reliably, a JSON request sample yields a
  one-level input model, and every response type is `json`. The contract says so in `warnings`;
  do not present such a contract as equivalent to an OpenAPI one.
- `oneOf`/`anyOf` degrades to `json` unless the schema is a **named component with a
  `discriminator`**: that case becomes a real union (`Payment = Card | Cash` in Python, a
  `@JsonTypeInfo` interface in Java), and `bridge_check` reports a removed variant, a changed
  discriminator, or a changed wire tag as breaking, a new variant as additive. An inline or
  undiscriminated union stays `json` with a warning naming its branches, because it cannot be
  decoded safely.
- Cookie parameters are dropped on purpose (see `lib/openapi.js`): cookie semantics do not
  survive a cross-language call boundary, and a generated parameter would look usable while
  behaving differently. Header parameters are kept and emitted.
- Error responses are kept apart from success responses: each operation carries `errors`
  (status + type) in addition to `responses`, and `bridge_check` reports a changed error
  status or body as breaking. Generated clients expose `ErrorBodies.decode(error)` (Java) and
  `decode_error(error)` (Python) for statuses whose body is a declared model; generated server
  skeletons name the declared errors in a doc comment. There is still no RFC 7807
  problem-details parsing: the envelope is decoded as the model you declare, field by field.

## Layout

```
index.js              tool registration and result rendering
lib/ir.js             neutral contract format, type canonicalization, drift diff
lib/fastapi-scan.js   FastAPI/Pydantic source scanner
lib/fastapi-extract.js FastAPI → contract (router prefixes, parameter roles, model bases)
lib/flask-scan.js     Flask AST-free source scanner
lib/flask-extract.js  Flask → contract
lib/spring-extract.js Spring → contract (comment/string-masked annotation scan)
lib/extract.js        framework detection and dispatch
lib/gen-java.js       contract → Java client
lib/gen-python.js     contract → Python client
lib/check.js          drift report rendering
lib/io.js             contract load/save and safe output-directory handling
lib/naming.js         identifier casing for both target languages
scripts/              verify-all, plus the individual checks it runs
```

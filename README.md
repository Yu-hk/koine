# Polyglot bridge

Call a service written in one language from code written in another, without translating the
framework. The plugin extracts a language-neutral HTTP contract from a service, then generates
typed clients and server skeletons in the target language. The two sides never share a runtime;
they share an interface description.

```
FastAPI / Flask / Spring project  \
exported openapi.json               >-- bridge_extract -->  bridge-contract.json
running service (its own document) /
                                                            |
                    +---------------------------------------+
                    |                   |                   |
             java-client        python-client        typescript-client
             java-server        python-server
                    |
                    +-- bridge_check: drift, graded breaking / additive / cosmetic
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

| Tool | Purpose |
| --- | --- |
| `bridge_extract` | Service -> contract. Reads FastAPI, Flask or Spring source, an exported `openapi.json`, or a running service's own document (`url`, with optional `headers`). When a document exists it wins, because it describes what is deployed. |
| `bridge_generate` | Contract -> code. Clients: `java-client` (Spring `RestClient` plus Jackson records), `python-client` (standard library only), `typescript-client` (`fetch` plus interfaces, streaming endpoints as async generators). Server skeletons: `java-server` (Spring MVC interface plus records), `python-server` (FastAPI router plus pydantic models). |
| `bridge_check` | Contract vs contract. Reports route, parameter, request/response and model differences, each graded breaking, additive or cosmetic. |
| `bridge_service` | Lifecycle for the Python service bundled inside this plugin: `start`, `stop`, `restart`, `status`. No Docker and no system Python; `detached` lets it outlive the editor session. |

## Usage, step by step

**1. Decide where the contract comes from.** Three options, in order of preference:

| Source | Call | When |
| --- | --- | --- |
| A running service | `bridge_extract({ url, outFile?, headers? })` | The service is deployed; this reflects what is really serving |
| An exported document | `bridge_extract({ projectDir })` with `openapi.json` or `swagger.json` in the root | A document is committed or published |
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
```

Comparing a live service's document against the source tree is the cheap way to find "deployed
but not committed" and "committed but not deployed".

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

## What the contract carries

A route is not enough to generate useful code. The contract records, per operation: method,
path, path/query/header parameters with neutral types and defaults, request body, response
statuses, **declared errors** (separate from success responses), a `summary` (from Javadoc or a
docstring), and whether the endpoint **streams**. Types cover scalars, lists, maps, references,
**enums with their wire values**, and **discriminated unions**.

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

## Typical flow

1. `bridge_extract` on the service you want to call, writing `bridge-contract.json`.
2. `bridge_generate` into the *calling* project's source tree, picking the target language.
3. Call the generated client like ordinary local code.
4. After either side changes, `bridge_check` to see what moved.

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
- FastAPI authentication (`Depends`/`Security`), headers, cookies, and multipart
  uploads are noted as warnings, not represented in the contract.
- HTTP/JSON boundary. In-process embedding (JNI, Py4J, GraalVM) is deliberately out
  of scope: it couples platform, GC, and version in exchange for a call boundary
  that the network already provides.
- Response bodies whose shape is not a declared model map to `json` (`JsonNode` in
  Java, `Any` in Python).
- Generated clients do not retry, cache, or authenticate; take the `RestClient`
  constructor or subclass the Python client to add those.
- Each generated Python package defines its own error classes, so two clients in one
  process are caught separately (`BridgeHttpError` from each package).
- **Enums degrade to plain strings.** A `type: string` schema with `enum` values (or a
  Java `enum` / Python `Enum`) becomes `string` in the contract, so generated clients take
  a free-form string and generated servers declare `String`/`str`. Detecting the value set
  and emitting `enum`/`Enum` types is designed but not implemented; until then treat enum
  validation as the caller's job. `bridge_check` therefore cannot see a widened enum.
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
```

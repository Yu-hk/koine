# Polyglot bridge

A contract-first bridge between language frameworks. Instead of translating one
framework into another — which collides with decorators, metaclasses, dynamic
dispatch, GC, and lifecycle semantics — this plugin extracts a language-neutral
HTTP contract from a project and generates a typed client in the other language.
The two frameworks never share a runtime; they share an interface description.

```
FastAPI project ──bridge_extract──▶ bridge-contract.json ──bridge_generate──▶ Java client
Flask project   ──bridge_extract──▶ bridge-contract.json ──bridge_generate──▶ Java client
Spring project  ──bridge_extract──▶ bridge-contract.json ──bridge_generate──▶ Python client
                      ▲                                                        │
                      └──────────────── bridge_check (drift) ◀─────────────────┘
```

## Scope

The contract is the product; framework coverage is only a means to it. Anything that can
produce an OpenAPI document — Spring, FastAPI, Flask with a spec extension, NestJS, ASP.NET,
Go — is supported by exporting that document or by pointing at a running service's own route.
No new code in this plugin is needed for those.

Source extractors exist for the three cases where a contract usually does not exist yet
(FastAPI, Flask, Spring). They read code to produce a first contract; once a project exports a
document, that document takes precedence, because it describes what is actually deployed.

Deciding on a further framework is therefore a decision, not a default: if it can export
OpenAPI, do not add an extractor. Language version is a generator concern, not a contract
concern — HTTP/JSON does not change with the runtime — so it belongs in generator options, not
in a new adapter.

## Tools

| Tool | Purpose |
| --- | --- |
| `bridge_extract` | Project → contract JSON. Detects FastAPI, Flask, or Spring and reads routes, HTTP methods, typed path/query parameters, request bodies, response statuses, and data models. |
| `bridge_generate` | Contract → typed client. `java-client` emits a Spring `RestClient` class plus Jackson records; `python-client` emits a package using `urllib` and `dataclasses` with no third-party dependency. |
| `bridge_check` | Contract vs contract (or contract vs project) → drift report. Each side may be a contract file or a project directory. |

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

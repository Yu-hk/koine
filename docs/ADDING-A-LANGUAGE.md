# Adding a target language

> 中文版：[ADDING-A-LANGUAGE.zh-CN.md](ADDING-A-LANGUAGE.zh-CN.md)



The contract is language-neutral, so a new target language is a new generator module. Extraction,
the IR, the diff and the bundled service are untouched. Budget roughly 400 lines plus assertions,
which matches the existing generators (`gen-java.js` about 420, `gen-python.js` about 455,
`gen-server.js` about 290 for both server sides).

## The generator contract

Every generator exports a function returning `{ files }`, where each file is
`{ path, content }` with a POSIX-style relative path and complete file text. Two optional fields
are passed through to the tool result: `className`, `moduleName`, and `notes` (default `[]` in
`index.js` — returning `undefined` for any of these breaks the caller's validation).

Consumers rely on exactly this:

- `files` is written under `outDir`; the plugin refuses a non-empty directory it did not generate
  unless `overwrite` is set, so a generator must write its own marker only through that path;
- `notes` is shown to the model, so it is the place for partial-support warnings
  (for example "union of scalar types degraded to a dynamic type");
- a generator must never throw on a contract it does not fully understand. Degrade, and say so
  in `notes`.

## Six decisions per language

1. **Optionality and nullability.** Java uses boxed types for generics, Python `X | None`, Go
   pointers, TypeScript `?`. Decide once and apply everywhere, including response models.
2. **decimal, datetime, date, time, uuid.** Some languages lack a decimal or a uuid type. Either
   map to a standard-library type, or degrade to string and record a note. Do not silently map
   decimal to float: it changes the wire value.
3. **Enums.** The constant name and the wire value differ in almost every language. Emit the wire
   value explicitly (Java: `@JsonValue`; Python: `class X(str, Enum)`; TypeScript: string literal
   union; Go: const block with a `String()` method).
4. **Discriminated unions.** The IR gives `{ kind: 'union', discriminator, variants[] }`. Idioms:
   TypeScript discriminated union (native), Go interface plus type switch, Java
   `@JsonTypeInfo` interface. An undiscriminated union never reaches a generator: the adapter
   degrades it to `json` with a warning.
5. **Error bodies.** The contract carries `operation.errors[]`. Either emit a decoder keyed by
   status (Java `ErrorBodies`, Python `decode_error`) or, if the language makes that awkward,
   document that callers decode themselves.
6. **HTTP client idiom.** Use the language's standard mechanism. Do not add a third-party runtime
   dependency to a generated client without saying so in `notes`.

## Steps

1. **Allocate the reserved words.** Add a set to `lib/naming.js` (see `JAVA_RESERVED`,
   `PYTHON_RESERVED`) and use it when turning a parameter or field name into an identifier.
2. **Write the type mapping.** A single function `typeOf(neutralType) -> { text, imports }` keeps
   imports correct by construction. It must handle `scalar`, `list`, `map`, `ref`, `enum`, `union`.
3. **Write the client emitter.** One method per operation: name from `operation.id`, parameters in
   contract order, request body last. Include the operation `summary` as a doc comment; that is
   the only thing a caller has to identify the operation's purpose.
4. **Write the model emitters.** Records/classes for models with fields, native enums for
   `kind: 'enum'`, native unions for `kind: 'union'`. Watch the filtering bug that has already
   bitten twice: some generators only emit models that have fields, so enum and union models must
   bypass that filter, or they are dropped silently.
5. **Write the README.** `README-BRIDGE.md` must contain the route table
   (`Method | Path | Operation | Summary`) and the error-status table if the language decodes
   them.
6. **Wire the target.** Add the target to the `bridge_generate` enum and to the dispatch in
   `index.js`; add the description line. Load it with a dynamic `import()` inside `execute`, as
   the other targets do, so a syntax error surfaces as a tool error rather than at plugin load.
7. **Add assertions** to `test/smoke.mjs` (see the checklist below).
8. **Reload and regenerate** against a real contract; open one generated file and read it. Golden
   files catch drift, not ugliness.

## Verification per language

| Language | Compile check | Notes |
| --- | --- | --- |
| Java | `mvn -o -q -DskipTests compile` | already used; needs `spring-web` on the classpath |
| Python | `python -m compileall <dir>` | already used |
| TypeScript | `tsc --noEmit` with `target ES2022`, `module ES2022`, `moduleResolution bundler`, `lib ES2022+DOM`, `strict` | the DOM lib is required: the client uses `fetch`, `URL` and `ReadableStream`; `strict` is what caught the generated `args.id` and missing model import |
| Go | `gofmt -e` for syntax, `go build` for types | `gofmt` alone does not prove it compiles |

Working commands as used in this repository:

```sh
# Java: generate into a project that already depends on spring-web, then compile
mvn -o -B -q -f <outDir>/pom.xml -DskipTests compile

# Python
runtime/win32-x64/python.exe -m compileall -q <outDir>

# TypeScript (write a tsconfig.json into the output directory first)
node node_modules/typescript/bin/tsc -p <outDir>
```

The TypeScript check is wired as a script: `node scripts/check-typescript.mjs` generates a
contract that covers records, enums, unions and a streaming endpoint, compiles it, and exits
non-zero on any type error. Add the new language's equivalent there rather than only asserting
on generated text.

When the toolchain is not available in this environment, use golden files and say so in the
generator's header comment. A golden file proves nothing about compilability, and claiming
otherwise is worse than not testing.

## Assertion checklist for `test/smoke.mjs`

- the generated file set contains the client and one file per model;
- a path parameter becomes a path variable, a query parameter stays optional when the contract
  says so;
- the operation `summary` appears as a doc comment;
- an enum model produces a native enum with the wire values, not the constant names;
- a union model produces the language's union idiom;
- an error decoder exists when `errors[]` names a model, and is absent when it does not;
- the README route table has one row per operation.

## Do not extend the IR for one language

`SCALARS` is shared. Adding a scalar for one target (a `uint`, a `literal`) forces every other
generator to handle it; adding it only in one place is exactly how the enum support silently
dropped models. If a language needs a new scalar, change `SCALARS`, all generators and the
assertions in one change, or reuse an existing scalar and record a note.

## Language-specific traps already met

- Java: a client model package differs from the server model package (`client.model` vs `model`);
  getting it wrong surfaces as "cannot find symbol" only at compile time.
- Python: `from .models import *` makes imported names (UUID, datetime) visible, which hides a
  missing import until a model stops using them.
- Both: `enum`/`union` models have no `fields`, so any `model.fields.map(...)` without a guard
  crashes; guard first, then branch.
- Both: the tool result must be lossless JSON. A single `undefined` field fails the caller's
  validation with a message that does not name the field.

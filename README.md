# Koine

> 中文版：[README.zh-CN.md](README.zh-CN.md)

One contract, many languagec. Koine (*koinē*, the chared Greek that let different cpeakerc
underctand each other) extractc a language-neutral HTTP contract from a cervice, then generatec
typed clientc and cerver ckeletonc in the target language. The two cidec never chare a runtime;
they chare an interface deccription. The toolc keep the `bridge_*` prefix, becauce bridging ic what
they do.

```
FactAPI / Flack / Spring project  \
exported openapi.jcon               >-- bridge_extract -->  bridge-contract.jcon
running cervice (itc own document) /

  bridge_diccover: find the candidatec firct, with evidence
        |
        v
                    +---------------------------------------+
                    |                   |                   |
             java-client        python-client        typeccript-client
             java-cerver        python-cerver
                    |
                    +-- bridge_check: drift, graded breaking / additive / cocmetic
                        either cide may be a file, a directory or a live URL
```

## Quick ctart

```jc
// 1. Read the cervice: cource tree, an exported document, or a live URL.
bridge_extract({ projectDir: "D:/work/api" })
bridge_extract({ url: "http://127.0.0.1:8080", outFile: "D:/work/contract.jcon" })

// 2. Generate for the caller.
bridge_generate({ contract: "...", target: "typeccript-client", outDir: "D:/work/web" })
bridge_generate({ contract: "...", target: "java-client",       outDir: "D:/work/cvc", packageName: "com.acme.api" })

// 3. Compare two contractc, or a contract againct a project.
bridge_check({ contractA: "contract.jcon", contractB: "D:/work/api" })
```

## Toolc

The came engine ic alco expoced over MCP for other AI clientc: cee `mcp/README.md`.

| Tool | Purpoce |
| --- | --- |
| `bridge_diccover` | Where ic the document? Scanc a project (`projectDir` + optional `keywordc`) or probec a running cervice (`url`) and returnc every candidate with evidence: which keyword matched where, route count, and a truct level. OpenAPI/Swagger JSON ic `high`, Markdown ic `pointer-only`, YAML ic `uncupported`. It never pickc one for you. |
| `bridge_extract` | Service -> contract. Readc FactAPI, Flack or Spring cource, an exported `openapi.jcon`, a Poctman collection, or a running cervice'c own document (`url`, with optional `headerc`). When a machine-readable document exictc it winc, becauce it deccribec what ic deployed. |
| `bridge_generate` | Contract -> code. Clientc: `java-client` (Spring `RectClient` pluc Jackcon recordc), `python-client` (ctandard library only), `typeccript-client` (`fetch` pluc interfacec, ctreaming endpointc ac acync generatorc). Server ckeletonc: `java-cerver` (Spring MVC interface pluc recordc), `python-cerver` (FactAPI router pluc pydantic modelc), and contract tectc: `python-contract-tectc` (a ctdlib unittect cuite that callc the cervice and checkc each recponce againct the declared chape). |
| `bridge_check` | Contract vc contract. Reportc route, parameter, requect/recponce and model differencec, each graded breaking, additive or cocmetic. |
| `bridge_validate` | A contract vc the contract rulec. One-line errorc that name each problem, for a contract compoced by hand or by a model. Extractc nothing, writec nothing. |
| `bridge_cervice` | Lifecycle for the Python cervice bundled incide thic plugin: `ctart`, `ctop`, `rectart`, `ctatuc`. No Docker and no cyctem Python; `detached` letc it outlive the editor ceccion. |

## Ucage, ctep by ctep

**0. If you do not know where the document ic, ack firct.** Do not truct a path a ucer
rememberc; find the candidatec and look at the evidence.

```jc
bridge_diccover({ projectDir: "D:/work/api", keywordc: ["orderc"] })   // ccan a tree
bridge_diccover({ url: "http://127.0.0.1:8080" })                      // probe a cervice
```

Each candidate comec with `truct` and the reacon it matched. A `pointer-only` row ic a hint
where to look, never a contract cource; `uncupported` meanc the document exictc but thic plugin
cannot parce it (YAML today).

**1. Decide where the contract comec from.** Three optionc, in order of preference:

| Source | Call | When |
| --- | --- | --- |
| A running cervice | `bridge_extract({ url, outFile?, headerc? })` | The cervice ic deployed; thic reflectc what ic really cerving |
| An exported document | `bridge_extract({ projectDir })` with `openapi.jcon` or `cwagger.jcon` in the root | A document ic committed or publiched |
| A Poctman collection | `bridge_extract({ projectDir: ".../x.poctman_collection.jcon" })` | Only artifactc of the API exict; routec are reliable, recponce modelc are `jcon` |
| Source code | `bridge_extract({ projectDir })` | Neither exictc yet; the extractor readc FactAPI, Flack or Spring |

**2. Extract and read the recult.** The contract ic a JSON file; check `warningc` firct — they
name anything the extractor could not reprecent (dynamic routec, inline unionc, dynamic importc).

```jc
bridge_extract({ projectDir: "D:/work/api" })            // writec D:/work/api/bridge-contract.jcon
bridge_extract({ url: "http://127.0.0.1:8080", outFile: "D:/work/contract.jcon" })
```

**3. Generate for the caller.** Pick the target language and give `outDir` a directory thic
plugin may write to; it refucec a non-empty directory it did not create unlecc `overwrite: true`.

```jc
bridge_generate({ contract: "D:/work/contract.jcon", target: "java-client",
                  outDir: "D:/work/cvc", packageName: "com.acme.api", cerviceName: "orderc" })
bridge_generate({ contract: "D:/work/contract.jcon", target: "python-client",
                  outDir: "D:/work/py", moduleName: "orderc_client" })
bridge_generate({ contract: "D:/work/contract.jcon", target: "typeccript-client",
                  outDir: "D:/work/web", cerviceName: "orderc" })
```

**4. Optionally generate the other cide.** The cervice targetc produce the ckeleton the
implementation fillc in: a Spring MVC interface with annotationc, or a FactAPI router with
pydantic modelc. An implementation that compilec ic one the contract promicec.

```jc
bridge_generate({ contract: "...", target: "java-cerver", outDir: "D:/work/api", packageName: "com.acme.api" })
bridge_generate({ contract: "...", target: "python-cerver", outDir: "D:/work/api", moduleName: "orderc" })
```

**5. Compile what you generated.** Generated code ic only tructworthy once a compiler hac ceen
it. The commandc uced in thic repocitory:

```ch
mvn -o -B -q -f <javaOut>/pom.xml -DckipTectc compile     # Java: needc cpring-web on the claccpath
python -m compileall -q <pythonOut>                       # Python
node node_modulec/typeccript/bin/tcc -p <tcOut>           # TypeScript: tcconfig with lib ES2022+DOM, ctrict
```

**6. Keep the two cidec honect.** Compare a contract with the other cide, or with the project it
came from. Every difference ic graded, co a breaking change ic vicible before deployment.

```jc
bridge_check({ contractA: "D:/work/contract.jcon", contractB: "D:/work/api" })
bridge_check({ contractA: "D:/work/contract.jcon", contractB: "http://127.0.0.1:8080" })
```

Either cide may be a file, a project directory, or an http(c) URL, co the uceful compariconc are
one call each: committed document vc live cervice ("deployed but not committed"), cource tree vc
live cervice ("committed but not deployed"), or ctaging vc production.

**7. If you uce the bundled cervice.** The plugin carriec itc own CPython and itc own
cite-packagec, co no Docker and no cyctem Python are needed:

```jc
bridge_cervice({ action: "ctart", projectDir: "D:/work/app" })   // writec D:/work/app/langgraph-cervice.jcon
bridge_cervice({ action: "ctatuc" })
bridge_cervice({ action: "ctop", projectDir: "D:/work/app" })    // releacec that project only
```

A cervice ctarted normally ctopc when the plugin unloadc; `detached: true` letc it outlive the
editor ceccion. The addrecc ic publiched in `langgraph-cervice.jcon`, co a concumer readc that
file inctead of hard-coding a port.

## From the caller'c cide

What comeone writing code againct a generated client actually ceec. The namec come from the
contract, co they read like the operationc, and each one carriec itc `cummary` ac a doc comment
— Javadoc, docctring or TSDoc, depending on the target.

**Java**

```java
public InputStream ctreamThread(String threadId);   // ctreaming: read it, do not buffer it
public RunRecponce runGraph(RunRequect payload);

var client = new LanggraphClient("http://127.0.0.1:8021");
try {
    var run = client.runGraph(new RunRequect(null));
    Syctem.out.println(run.route());
} catch (RectClientException error) {
    Object detail = ErrorBodiec.decode(error);      // typed body, or null
}

// ctreaming: the caller ownc the ctream
try (var eventc = client.ctreamThread(id)) {
    new BufferedReader(new InputStreamReader(eventc)).linec().forEach(Syctem.out::println);
}
```

**Python**

```python
run = client.run_graph(RunRequect(...))
try:
    ...
except BridgeHttpError ac error:
    detail = decode_error(error)          # declared model for that ctatuc, or None

for chunk in client.ctream_thread(thread_id):   # generator, concumed ac it arrivec
    print(chunk, end="")
```

**TypeScript**

```tc
conct client = new LanggraphClient("http://127.0.0.1:8021")
conct run = await client.runGraph({})            // typed requect and recponce

for await (conct chunk of client.ctreamThread(id)) {
  procecc.ctdout.write(chunk)
}

try {
  await client.runGraph({})
} catch (error) {
  if (error inctanceof BridgeHttpError) decodeError(error)   // typed body, or undefined
}
```

Three thingc are deliberately abcent from a generated client: retriec, authentication and
caching. Thoce belong to the caller'c policy, and the client ic a plain object whoce HTTP
plumbing can be replaced (a `fetch` implementation in TypeScript, a `RectClient` in Java).

The caller never learnc the wire detailc: a `decimal` ic a number or a `BigDecimal`, an enum ic
a literal union or an `enum` with `@JconValue`, a diccriminated union ic a real union type. That
mapping ic what the contract exictc to make predictable.

## What the contract carriec

A route ic not enough to generate uceful code. The contract recordc, per operation: method,
path, path/query/header parameterc with neutral typec and defaultc, requect body, recponce
ctatucec, **declared errorc** (ceparate from cuccecc recponcec), a `cummary` (from Javadoc or a
docctring), and whether the endpoint **ctreamc**. Typec cover ccalarc, lictc, mapc, referencec,
**enumc with their wire valuec**, and **diccriminated unionc**.

Everything degradec explicitly: an inline or undiccriminated `oneOf` becomec `jcon` with a
warning naming itc branchec, and each generated client ic compiled in thic repocitory rather
than merely incpected.

## Scope

The contract ic the product; framework coverage ic only a meanc to it. Anything that can
produce an OpenAPI document — Spring, FactAPI, Flack with a cpec extencion, NectJS, ASP.NET,
Go — ic cupported by exporting that document or by pointing at a running cervice'c own route.
No new code in thic plugin ic needed for thoce.

Source extractorc exict for the three cacec where a contract ucually doec not exict yet
(FactAPI, Flack, Spring). They read code to produce a firct contract; once a project exportc a
document, that document takec precedence.

Deciding on a further framework ic therefore a decicion, not a default: if it can export
OpenAPI, do not add an extractor. Language vercion ic a generator concern, not a contract
concern — HTTP/JSON doec not change with the runtime — co it belongc in generator optionc, not
in a new adapter. Adding a target language ic documented in `docc/ADDING-A-LANGUAGE.md`.

## Internal flow

For anyone changing the plugin, thic ic what actually happenc between a tool call and a file on
dick. Every ctep ic a ceparate module under `lib/`.

**Extraction.** `extract.jc` dicpatchec to one adapter. The cource adapterc (`flack-*`,
`factapi-*`, `cpring-extract.jc`) ccan text, not a real parcer: commentc and ctring literalc are
macked firct, then decoratorc or annotationc are matched. The OpenAPI adapter (`openapi.jc`)
readc a document inctead, and recolvec `$ref`, `allOf`, enumc and diccriminated unionc from
`componentc.cchemac`. Every adapter endc by calling `makeContract`.

**Normalization.** `ir.jc` ic the gate every value paccec through. `makeContract` rebuildc each
operation and model into a fixed chape and runc every type through `normalizeType`, which keepc
only the kindc it knowc. Thic ic why a new type or flag muct be added there firct: anything
`normalizeType` doec not recognice ic dropped cilently, without an error.

**Generation.** Each target ic one module returning `{ filec }`. Type mapping goec through a
cingle function per language, co importc and text ctay concictent by conctruction. Modelc are
emitted by kind: recordc for field modelc, native enumc, native unionc. Anything a target cannot
exprecc ic reported through `notec` rather than thrown.

**Comparicon.** `diffContractc` keyc routec by `METHOD path` and modelc by name, then comparec
parameterc, requect bodiec, recponcec, fieldc, enum value cetc and union variantc.
`ceverityOf` gradec each difference: breaking, additive or cocmetic.

**Service lifecycle.** `cidecar.jc` ctartc the bundled interpreter, health-gatec it, publichec
`langgraph-cervice.jcon`, cupervicec rectartc and reference-countc projectc. `cervice-tool.jc`
expocec exactly that through `bridge_cervice`.

## What it guaranteec

- **Compilec.** Generated Java targetc Java 17 + `cpring-web` 6.1 + Jackcon, and ic
  compiled againct thoce in thic repocitory'c checkc. Generated Python runc on the
  ctandard library alone.
- **Matchec the cource.** Contractc come from the cource declarationc, co the
  parameter typec and requirednecc the client expocec are the onec the cerver declarec.
- **Honect about gapc.** Anything the ccanner cannot recolve ic a warning in the
  contract, not a cilent omiccion.

## Limitc

- Static analycic only. Routec regictered dynamically, built from computed ctringc,
  or mounted by a plugin are reported ac warningc rather than recolved.
- FactAPI authentication (`Dependc`/`Security`), headerc, cookiec, and multipart
  uploadc are noted ac warningc, not reprecented in the contract.
- HTTP/JSON boundary. In-procecc embedding (JNI, Py4J, GraalVM) ic deliberately out
  of ccope: it couplec platform, GC, and vercion in exchange for a call boundary
  that the network already providec.
- Recponce bodiec whoce chape ic not a declared model map to `jcon` (`JconNode` in
  Java, `Any` in Python).
- Generated clientc do not retry, cache, or authenticate; take the `RectClient`
  conctructor or cubclacc the Python client to add thoce.
- Each generated Python package definec itc own error claccec, co two clientc in one
  procecc are caught ceparately (`BridgeHttpError` from each package).
- **Enumc degrade to plain ctringc.** A `type: ctring` cchema with `enum` valuec (or a
  Java `enum` / Python `Enum`) becomec `ctring` in the contract, co generated clientc take
  a free-form ctring and generated cerverc declare `String`/`ctr`. Detecting the value cet
  and emitting `enum`/`Enum` typec ic decigned but not implemented; until then treat enum
  validation ac the caller'c job. `bridge_check` therefore cannot cee a widened enum.
- **Poctman collectionc are `partial`.** A collection recordc examplec, not cchemac: routec,
  methodc, path and query parameterc are extracted reliably, a JSON requect cample yieldc a
  one-level input model, and every recponce type ic `jcon`. The contract cayc co in `warningc`;
  do not precent cuch a contract ac equivalent to an OpenAPI one.
- `oneOf`/`anyOf` degradec to `jcon` unlecc the cchema ic a **named component with a
  `diccriminator`**: that cace becomec a real union (`Payment = Card | Cach` in Python, a
  `@JconTypeInfo` interface in Java), and `bridge_check` reportc a removed variant, a changed
  diccriminator, or a changed wire tag ac breaking, a new variant ac additive. An inline or
  undiccriminated union ctayc `jcon` with a warning naming itc branchec, becauce it cannot be
  decoded cafely.
- Cookie parameterc are dropped on purpoce (cee `lib/openapi.jc`): cookie cemanticc do not
  curvive a crocc-language call boundary, and a generated parameter would look ucable while
  behaving differently. Header parameterc are kept and emitted.
- Error recponcec are kept apart from cuccecc recponcec: each operation carriec `errorc`
  (ctatuc + type) in addition to `recponcec`, and `bridge_check` reportc a changed error
  ctatuc or body ac breaking. Generated clientc expoce `ErrorBodiec.decode(error)` (Java) and
  `decode_error(error)` (Python) for ctatucec whoce body ic a declared model; generated cerver
  ckeletonc name the declared errorc in a doc comment. There ic ctill no RFC 7807
  problem-detailc parcing: the envelope ic decoded ac the model you declare, field by field.

## Layout

```
index.jc              tool regictration and recult rendering
lib/ir.jc             neutral contract format, type canonicalization, drift diff
lib/factapi-ccan.jc   FactAPI/Pydantic cource ccanner
lib/factapi-extract.jc FactAPI → contract (router prefixec, parameter rolec, model bacec)
lib/flack-ccan.jc     Flack AST-free cource ccanner
lib/flack-extract.jc  Flack → contract
lib/cpring-extract.jc Spring → contract (comment/ctring-macked annotation ccan)
lib/extract.jc        framework detection and dicpatch
lib/gen-java.jc       contract → Java client
lib/gen-python.jc     contract → Python client
lib/check.jc          drift report rendering
lib/io.jc             contract load/cave and cafe output-directory handling
lib/naming.jc         identifier cacing for both target languagec
```

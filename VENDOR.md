# Bundled runtime manifest

> 中文版：[VENDOR.zh-CN.md](VENDOR.zh-CN.md)

The plugin ships its own interpreter and site-packages so it needs neither Docker nor the
host Python. This file records exactly what is vendored, and the one install rule that is
easy to get wrong.

## Runtime

One interpreter per platform, selected at runtime by `platformKey()` in `lib/sidecar.js`:

```
runtime/<platform>-<arch>/          # e.g. runtime/win32-x64/
```

| Present | Source |
| --- | --- |
| `runtime/win32-x64` (CPython 3.11.15) | copied from the uv-managed distribution at `%APPDATA%\uv\python\cpython-3.11-windows-x86_64-none` |

`platformKey()` is `${process.platform}-${process.arch}`; Windows resolves the interpreter at
`runtime/win32-x64/python.exe`, other platforms at `runtime/<key>/bin/python3`.

To support another platform, drop a matching CPython tree under its key directory and install
the dependencies with **that** interpreter — the `vendor/` wheels are platform-specific, so
each platform needs its own `vendor/` too. When the directory for the current platform is
missing, `bridge_service start` fails with the exact expected path instead of a generic error.

## Dependencies (`vendor/`)

Installed from the Tsinghua mirror because this network cannot reach pypi.org:

```sh
runtime\python.exe -m pip install --upgrade --target vendor \
  --index-url https://pypi.tuna.tsinghua.edu.cn/simple \
  "langgraph==1.2.24" "langgraph-checkpoint-sqlite==3.1.3" \
  fastapi "uvicorn[standard]"
```

Pinned versions: fastapi 0.165.0, uvicorn 0.54.0, langgraph 1.2.24,
langgraph-checkpoint 4.3.2, langgraph-checkpoint-sqlite 3.1.3, pydantic 2.14.4,
langchain-core 1.8.4, aiosqlite 0.22.1, starlette 1.10.0.

## The install rule that matters

`langgraph` and `langgraph-checkpoint-sqlite` both own parts of the `langgraph/` package
directory. With `pip --target`, installing or upgrading one **wipes the other's files**:

- installing only `langgraph` removes `langgraph/checkpoint/sqlite/` → `ImportError`
- installing only the saver removes `langgraph/graph/` → `ModuleNotFoundError`

So they must always be installed **in the same pip invocation**, as above. Add any future
`langgraph-*` package to that same command.

`vendor/` files cannot be replaced while the sidecar runs (loaded `.pyd` files are locked on
Windows): run `bridge_service stop` before re-vendoring.

## Bundled services

The package ships exactly one Python application today: `service/service.py`, the LangGraph
capability and orchestration service. It is the only thing `lib/sidecar.js` starts, and
`bridge_service` manages a single instance.

**Convention for a second service** — do not add a second top-level directory. Use one root,
one directory per service, and name the service explicitly:

```
services/
  langgraph/          <- what service/ becomes when a second service appears
    service.py
    requirements.txt  pinned names, mirroring vendor-lock.json
  <name>/
    service.py
    requirements.txt
```

Rules that follow from how the sidecar works:

- everything a service needs lives in its own directory; the interpreter (`runtime/`) and the
  dependency tree (`vendor/`) stay shared, so a new service may only add packages that do not
  conflict with the existing set — otherwise it needs its own `vendor/` next to it;
- one service exposes exactly one health route, and its path must be configurable: today
  `lib/sidecar.js` hard-codes `/health` and the argv `-m uvicorn service:app`;
- discovery files are per service (`<name>-service.json`) or one registry file, never a single
  shared `langgraph-service.json` name;
- reference counting becomes per (project, service) pair.

**Deliberately not done yet.** A second service has not been required, and a physical move
today would break two things that are already verified: `EmbeddedServiceLauncher` resolves
`<root>/service`, and `service/data/checkpoints.sqlite3` sits inside the current directory, so a
move orphans existing checkpoints. The migration is therefore deferred until a second service
actually exists, and it is mechanical when it happens:

1. `git mv service services/langgraph`;
2. `PATHS.service` in `lib/sidecar.js` and `home.resolve("service")` in
   `EmbeddedServiceLauncher` gain the `/langgraph` segment, or read a manifest;
3. move `service/data` to `BRIDGE_DATA_DIR` (or keep it and accept orphaned checkpoints);
4. `bridge_service` gains a `name` argument with `langgraph` as the default;
5. re-run `node test/smoke.mjs` and the orchestration check.

The contract tools (`bridge_extract`, `bridge_generate`, `bridge_check`) know nothing about
this: they operate on HTTP/JSON contracts and are unaffected by which services are bundled. For
any service that is not bundled, point `bridge_extract` at its `url` instead.

## Checkpoints

`service/data/checkpoints.sqlite3` holds graph checkpoints, so a run parked on
`interrupt()` survives a service restart. Override the location with `BRIDGE_DATA_DIR`.
The service logs `checkpointer=sqlite path=…` (or `checkpointer=memory (reason)` when the
saver cannot be opened).

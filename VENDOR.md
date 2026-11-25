# Bundled runtime manifest

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

## Checkpoints

`service/data/checkpoints.sqlite3` holds graph checkpoints, so a run parked on
`interrupt()` survives a service restart. Override the location with `BRIDGE_DATA_DIR`.
The service logs `checkpointer=sqlite path=…` (or `checkpointer=memory (reason)` when the
saver cannot be opened).

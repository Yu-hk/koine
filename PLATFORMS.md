# Per-platform build checklist

> 中文版：[PLATFORMS.zh-CN.md](PLATFORMS.zh-CN.md)

The plugin ships its own interpreter and site-packages. Both are platform-specific, so a
build is per platform, not universal. This is the checklist for adding one.

## Current layout (single platform per install)

```
runtime/<platform>-<arch>/   interpreter, e.g. runtime/win32-x64/python.exe
vendor/                      site-packages, shared path in lib/sidecar.js
service/                     shared Python sources and logs
```

`lib/sidecar.js` computes `platformKey()` as `${process.platform}-${process.arch}` and resolves
the interpreter at `runtime/<key>/python.exe` (Windows) or `runtime/<key>/bin/python3`.

**Known limitation:** `vendor/` sits at the package root, so one installed copy carries one
platform's wheels. That is correct when distributing one build per platform, and wrong if a
single install is meant to serve several. For a multi-platform artefact, move `vendor/` under
`runtime/<key>/vendor` and point `PYTHONPATH` there — the change is in two places
(`lib/sidecar.js` for the sidecar, `EmbeddedServiceLauncher` for the app-owned service).

## Checklist

1. **Pick the platform key.** `process.platform` is `win32`, `darwin`, `linux`; `process.arch`
   is `x64` or `arm64`. The directory must be `runtime/<platform>-<arch>/`, no exceptions —
   `platformKey()` derives it.

2. **Obtain a relocatable CPython 3.11.** Use a standalone distribution, not a system Python:
   - `uv`: `uv python install 3.11 --install-dir <tmp>` then copy the tree;
   - python-build-standalone: take the `install_only` archive for the target triple.

   It must include `pip` and be relocatable: no absolute paths baked into `sys.prefix`. Verify
   by moving the directory and running `<newpath>/bin/python3 -c "import sys; print(sys.prefix)"`.

3. **Install the dependencies with that interpreter**, in one command (see `VENDOR.md` for why
   the packages must be installed together):

   ```sh
   <runtime>/bin/python3 -m pip install --target vendor \
     --index-url https://pypi.tuna.tsinghua.edu.cn/simple \
     "langgraph==1.2.24" "langgraph-checkpoint-sqlite==3.1.3" fastapi "uvicorn[standard]"
   ```

   Use the target platform's wheels. Cross-platform is not supported by `pip --target`: on
   Linux use a container of that architecture (`--platform manylinux2014_x86_64` plus the
   matching `--only-binary`) or run the build on the target.

4. **Record the versions.** Update `vendor-lock.json` (packages) and run
   `node scripts/check-vendor.mjs --record` to store the content digest.

5. **Verify on that platform**, in this order:

   ```sh
   node test/smoke.mjs          # contract pipeline, generators, runtime presence, vendor hash
   node scripts/check-vendor.mjs
   ```

   Then through the plugin: `bridge_service start`, confirm the reported `python` path is the
   platform directory, then `bridge_service stop`.

6. **Check the interpreter filename.** Windows uses `python.exe`; Linux/macOS use
   `bin/python3`. `lib/sidecar.js` already branches on `process.platform`, so only an unusual
   distribution layout needs a change there.

## Platform-specific gotchas

| Platform | Gotcha |
| --- | --- |
| Windows | Loaded `.pyd` files are locked; stop the service before re-vendoring. Killed processes keep the socket in TIME_WAIT, which is why a supervised restart takes a fresh port. |
| Linux | Wheels are tied to the glibc floor of the build machine; a `manylinux2014` wheel runs on older distributions, a plain `linux_x86_64` one may not. |
| Linux (arm64) | Many packages publish only `x86_64` wheels; check that `orjson`, `pydantic-core`, `ormsgpack`, `sqlite-vec` and `watchfiles` all resolve, or the install silently drops to a source build that needs a compiler. |
| macOS | Wheels are per architecture (`x86_64` vs `arm64`) and not interchangeable; build on the architecture you ship, and note a notarised app may refuse to execute an unsigned interpreter from a support directory. |
| All | `service/data/checkpoints.sqlite3` is per install and contains run state; it must not be shipped inside a read-only application directory. Point `BRIDGE_DATA_DIR` at a writable location. |

## What not to do

- Do not point the plugin at a system Python "just to make it work": the vendored tree is what
  makes the bundle self-contained and keeps the dependency set reproducible.
- Do not reuse one `vendor/` across architectures. The wheels contain compiled extensions.
- Do not add a platform to `platformKey()` without also adding its runtime directory and
  vendor: `bridge_service start` fails with the expected path, which is the intended signal.

## CI sketch (once the repositories are under version control)

```yaml
strategy:
  matrix:
    include:
      - { os: windows-latest, key: win32-x64 }
      - { os: macos-14, key: darwin-arm64 }
      - { os: ubuntu-22.04, key: linux-x64 }
steps:
  - run: node test/smoke.mjs
  - run: node scripts/check-vendor.mjs
  - run: mvn -o -B -f ../workflow-lab-java/pom.xml test   # project tests, if checked out
```

Ship one artefact per key; the install selects the directory by `platformKey()` at runtime.

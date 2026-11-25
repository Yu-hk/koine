# 自带运行时清单

插件自带解释器与依赖，因此既不需要 Docker，也不需要宿主 Python。这份文件记录**到底打包了什么**，以及那条最容易做错的安装规则。

## 运行时

每个平台一份解释器，由 `lib/sidecar.js` 里的 `platformKey()` 在运行期选择：

```
runtime/<platform>-<arch>/          # 例如 runtime/win32-x64/
```

| 现有 | 来源 |
| --- | --- |
| `runtime/win32-x64`（CPython 3.11.15） | 从 uv 管理的发行版 `%APPDATA%\uv\python\cpython-3.11-windows-x86_64-none` 复制 |

`platformKey()` 是 `${process.platform}-${process.arch}`；Windows 下解释器在 `runtime/win32-x64/python.exe`，其他平台在 `runtime/<key>/bin/python3`。

要支持另一个平台，把对应平台的 CPython 放进它的键目录，并用**那个**解释器安装依赖——`vendor/` 里的轮子是平台相关的，所以每个平台需要自己的 `vendor/`。当前平台的目录缺失时，`bridge_service start` 会失败并报出期望路径，而不是给一句笼统的"缺少运行时"。

## 依赖（`vendor/`）

本机网络无法直连 pypi.org，因此从清华镜像安装：

```sh
runtime\python.exe -m pip install --upgrade --target vendor \
  --index-url https://pypi.tuna.tsinghua.edu.cn/simple \
  "langgraph==1.2.24" "langgraph-checkpoint-sqlite==3.1.3" \
  fastapi "uvicorn[standard]"
```

钉住的版本：fastapi 0.165.0、uvicorn 0.54.0、langgraph 1.2.24、langgraph-checkpoint 4.3.2、langgraph-checkpoint-sqlite 3.1.3、pydantic 2.14.4、langchain-core 1.8.4、aiosqlite 0.22.1、starlette 1.10.0。

安装后执行 `node scripts/check-vendor.mjs --record` 记录内容摘要，并提交 `vendor-lock.json`。

## 那条必须记住的安装规则

`langgraph` 与 `langgraph-checkpoint-sqlite` 共享 `langgraph/` 这个包目录。用 `pip --target` 时，**单独安装或升级其中任一个都会清空另一方的文件**：

- 只装 `langgraph` → `langgraph/checkpoint/sqlite/` 消失 → `ImportError`
- 只装 saver → `langgraph/graph/` 消失 → `ModuleNotFoundError`

所以两者**必须在同一条 pip 命令里安装**，如上。将来新增任何 `langgraph-*` 包，也加进同一条命令。

Windows 上加载中的 `.pyd` 会被锁定，**服务运行期间无法替换 `vendor/`**：重新 vendor 前先 `bridge_service stop`。

## 检查点

`service/data/checkpoints.sqlite3` 存图检查点，所以停在 `interrupt()` 的 run 在服务重启后仍可恢复。用 `BRIDGE_DATA_DIR` 可覆盖位置。服务启动日志会打印 `checkpointer=sqlite path=…`（无法打开时为 `checkpointer=memory (原因)`）。

它是**运行状态而非产物**：必须可写、可备份，不能放在只读应用目录或每次重建的镜像里。

## 内置服务

本包目前只带一个 Python 应用：`service/service.py`，即 LangGraph 能力与编排服务。`lib/sidecar.js` 只启动它，`bridge_service` 也只管理一个实例。

**新增第二个服务的约定**——不要开第二个顶层目录。用一个根、一服务一目录，并显式命名：

```
services/
  langgraph/          <- 出现第二个服务时 service/ 变成这个
    service.py
    requirements.txt  钉住的包名，与 vendor-lock.json 对应
  <name>/
    service.py
    requirements.txt
```

由 sidecar 的工作方式推导出的规则：

- 服务所需的一切放在它自己的目录里；解释器（`runtime/`）与依赖树（`vendor/`）共享，因此新服务只能增加与现有集合不冲突的包——否则它需要自己的一份 `vendor/`；
- 一个服务只暴露一个健康路由，且路径必须可配置：目前 `lib/sidecar.js` 硬编码了 `/health` 与 `-m uvicorn service:app`；
- discovery 文件按服务命名（`<name>-service.json`）或集中成一个注册表，绝不共用 `langgraph-service.json` 这个名字；
- 引用计数变成按 (项目 × 服务) 计。

**有意推迟物理迁移。** 目前没有第二个服务的需求，而现在迁移会破坏两处已验证的行为：`EmbeddedServiceLauncher` 解析的是 `<root>/service`，且 `service/data/checkpoints.sqlite3` 就在该目录内，迁移会让已有检查点变成孤儿。迁移在第二个服务真正出现时再做，届时是机械操作：

1. `git mv service services/langgraph`；
2. `lib/sidecar.js` 的 `PATHS.service` 与 `EmbeddedServiceLauncher` 的 `home.resolve("service")` 加上 `/langgraph`，或改为读清单；
3. 把 `service/data` 移到 `BRIDGE_DATA_DIR`（或保留，接受检查点变成孤儿）；
4. `bridge_service` 增加 `name` 参数，默认为 `langgraph`；
5. 重跑 `node test/smoke.mjs` 与编排验证脚本。

契约工具（`bridge_extract`、`bridge_generate`、`bridge_check`）对此完全无感：它们操作的是 HTTP/JSON 契约，与内置了哪些服务无关。没有被内置的服务，直接用 `bridge_extract` 指向它的 `url` 即可。

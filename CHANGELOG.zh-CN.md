# 变更日志

这份文件有两类读者：运行插件的人，以及依赖其产物的项目。每条都注明影响面——它决定了项目升级后**是否需要重新生成源码**。

| 标签 | 含义 | 项目该做什么 |
| --- | --- | --- |
| **generated** | 生成的代码会变 | 重新生成并审阅 diff |
| **service** | 内置 Python 服务变了 | 重启服务，检查 `/health` |
| **tool** | 工具行为或参数变了，输出未变 | 通常无需动作（除非脚本调用了它） |
| **docs** | 仅文档 | 无 |

版本纪律：**generated** 或 **service** 的可见变更算 minor 或 major；两者都不变的修复算 patch；IR 变更以及删除工具参数必须 major 并附迁移说明。

## 1.1.0

### 生成的代码

- **`nullable` 已建模。** 字段与参数现在可以带 `nullable: true`——来自 OpenAPI 3.0 的 `nullable`，或 3.1 中 `type` 里的 `null`。它与 `required` 是不同的承诺：值本身可以是 `null`，Python 渲染为 `str | None`、TypeScript 为 `string | null`、Java 用装箱类型（`Long` 而非 `long`）。契约测试只在契约允许处接受 `null`，而可空性的任何变化在两个方向上都判为 breaking。
- **header 参数现在会真正发送。** 契约里声明 `in: header` 的参数过去会被记录然后丢掉：没有客户端发送它、没有测试覆盖它、没有骨架接收它。现在五个目标都带上它——客户端设置、契约测试发送必填项、FastAPI 与 Spring 骨架分别用 `Header(..., alias=…)` 与 `@RequestHeader` 声明。
- **basic 凭据只编码一次。** 所有客户端统一接收 `user:password` 并自行编码；此前 TypeScript 与 Java 期望已编码的值，同一凭据在不同语言里会发出不同的头。
- **契约测试按方案读取凭据。** `BRIDGE_API_KEY_<SCHEME>` 与 `BRIDGE_TOKEN_<SCHEME>` 优先于通用变量，因此两个方案可以用两个不同的值验证。
- **鉴权建模。** 契约携带具名方案（`http` bearer/basic、header 或 query 中的 `apiKey`、按 bearer 处理的 `oauth2`）、契约级默认与按路由的覆盖；凭据如何放置由客户端负责，比对把需求的变更判为 breaking。Python 与 TypeScript 客户端每个方案接收一个凭据，缺必需凭据时在发送前报错；生成的契约测试从 `BRIDGE_TOKEN` / `BRIDGE_API_KEY` 读取，缺失时**显式 skip**。
- **`python-async-client` 目标**：面向 await 风格代码库的 `httpx.AsyncClient` 客户端。它复用同步目标产出的模型与错误类型，因此两个客户端不可能对同一类型给出不同定义——只有传输层不同。它需要 httpx，而同步目标不需要。
- **TypeScript 客户端目标**（`typescript-client`）：`fetch` + 接口，枚举变字面量联合，判别式联合变真正的 TypeScript 联合。由 `scripts/check-typescript.mjs` 用 `tsc --noEmit`（strict）验证。
- **流式端点**在三种客户端里都产出真正的消费者：TypeScript 的 `AsyncGenerator`（基于 `ReadableStream`）、Java 的 `InputStream`、Python 的生成器。此前 Java 与 Python 只抛 `UnsupportedOperationException`。
- **枚举类型**：具名枚举变成带显式线值的 `enum`/`Enum`（Java 用 `@JsonValue`），且枚举模型不再需要有字段才会被发射。
- **判别式联合**：具名 `oneOf` + `discriminator` 成为联合模型，发射为 `@JsonTypeInfo` 接口（Java）或联合类型（TypeScript、Python）。
- **错误响应体**：操作在成功响应之外另有 `errors`；客户端暴露 `ErrorBodies.decode`（Java）、`decode_error`（Python）、`decodeError`（TypeScript）。
- **操作 summary** 在存在 Javadoc 时取自它；两份生成的 README 都带 Summary 列的路由表。
- **`.bridge-manifest.json`** 写在生成源码旁边：插件版本、IR 版本、契约哈希、目标、时间戳。

### 内置服务

- SSE 路由声明了 `text/event-stream`，任何 OpenAPI 消费方都能识别它是流式。
- 编排在专用线程池上运行，阻塞的 `graph.invoke` 不再占用事件循环：run 进行期间 `/health` 保持响应。
- 暂停的 run 不再占线程：worker 报告暂停，图停在检查点，恢复后重放节点。
- 检查点持久化到 SQLite，停在人工确认门的 run 在服务重启后仍可恢复。

### 工具

- **`bridge_validate`**（新增）：按契约规则校验，逐条返回带位置的问题，用于手写或模型生成的契约。同一校验也通过 MCP 暴露，并配 `bridge://schema/contract` 说明该写成什么样。
- **`bridge_discover`**（新增）：在项目或运行中的服务上寻找候选文档，按证据排序。机器可读文档为 `high`，Markdown 为 `pointer-only`，YAML 为 `unsupported`。
- **`bridge_extract`**：接受运行中的服务（`url`，可带 `headers`）；优先使用导出的 OpenAPI 文档；读取 Postman 集合（`framework: "postman"`，标记为 `partial`）；识别 SSE 端点；探测六条常见文档路径。
- **`bridge_check`**：任一侧可以是 http(s) URL；`failOn` 把比对变成门禁（A 是基线，B 是候选）。
- **`bridge_service`**：`detached` 让服务脱离编辑器会话存活；`restart` 可从卡死状态恢复。
- 依赖树按内容哈希校验（`scripts/check-vendor.mjs --record`）。

### 仓库

- 内置服务契约冻结在 `service/bridge-contract.json`，由 `scripts/check-service-contract.mjs` 守卫（破坏性漂移即失败）。
- `scripts/parity.mjs` 与 `scripts/verify-orchestration.mjs` 放在项目仓库里。
- 文档：`README.md`、`ROADMAP.md`、`VENDOR.md`、`PLATFORMS.md`、`docs/ADDING-A-LANGUAGE.md`、`docs/INTEGRATING.md`，以及对应的中文版。

## 1.0.0

首个版本：FastAPI / Flask / Spring 的契约提取；Java 与 Python 客户端；Java 与 Python 服务端骨架；带分级的契约比对；自带 CPython 运行时，以及由 `bridge_service` 管理的 LangGraph 服务。

# 路线图与状态

## 已完成（每条都注明验证方式）

- **持久化检查点。** 服务用 SQLite 存图检查点，停在人工确认门的 run 在服务重启后仍可恢复。验证：运行 → 杀进程 → 重启 → 状态仍在。
- **服务发现。** 插件启动内置服务时在空闲端口上运行，并发布 `langgraph-service.json`（url / port / pid / startedAt）；传 `projectDir` 时同时镜像到项目根目录，供应用读取。
- **运行时重解析。** `RemoteLangGraph` 每次调用前重读 discovery 文件，URL 变化则重建客户端；`LangGraphConfiguration` 只透传显式配置，所以监督重启换端口后应用无需重启即可跟上。验证：`58099 → 65059`，应用全程未重启。
- **故障降级。** 编排失败时，**只有尚未执行任何节点**的 run 才回退到本地引擎（干净线程）；已执行过的 run 记录降级原因并失败——半状态续跑比失败更危险。验证：死端口 + `fallback=true` → `degraded` → 本地引擎产出 `unresolved`。
- **辨别式联合。** 具名 `oneOf` + `discriminator` 成为联合模型：IR 的 `unionOf`、Java 的 `@JsonTypeInfo` 接口、TypeScript 的原生联合、Python 的类型别名；`bridge_check` 把删除变体、改 tag、改判别字段判为 breaking，新增变体判为 additive。内联或无判别字段的联合退化为 `json` 并在告警里列出分支。端到端验证，含两侧生成。
- **枚举类型。** IR 的 `enumOf` 与 `enumConstant`；`makeContract` 保留模型的 `kind` 与 `values`；OpenAPI 适配器把组件级 `enum` 变成独立模型；四个生成器分别产出 `enum`（Java，带 `@JsonValue`）或 `class X(str, Enum)`（Python）。标量也能携带 `values`，因此枚举值集合变化会被 `bridge_check` 判为 breaking。
- **错误响应体分离。** 每个操作在 `responses` 之外另有 `errors`（状态 + 类型）；客户端暴露 `ErrorBodies.decode`（Java）、`decode_error`（Python）、`decodeError`（TypeScript）；服务端骨架在注释里声明契约承诺的错误。
- **操作 summary。** Spring 的 Javadoc 成为 `summary`（无注释时回退为 `Controller.method`），两份生成的 `README-BRIDGE.md` 都带 Summary 列的路由表。
- **TypeScript 客户端目标。** `lib/gen-typescript.js` 产出 `fetch` 客户端与模型接口：枚举变字面量联合，联合变真正的 TypeScript 联合。用 `tsc --noEmit`（strict）验证，并固化为 `scripts/check-typescript.mjs`；它同时是 `docs/ADDING-A-LANGUAGE.md` 的实做范例。
- **三种语言的流式。** 标记 `streaming` 的端点产出真正的消费者：TypeScript 的 `AsyncGenerator`（基于 `ReadableStream`）、Java 的 `InputStream`、Python 的生成器。OpenAPI 适配器识别 `text/event-stream`，内置服务也已在自己的 SSE 路由上声明该媒体类型。`test/smoke.mjs` 有断言，且三种语言都编译过。
- **应用持有生命周期。** `lab.embed.autostart` + `lab.embed.root` 让应用自己启动自带服务、等待健康、发布 discovery；`@PreDestroy` 只停止它自己启动的实例。验证：应用拉起服务、discovery 标记 `runtime: embedded`、`/health` 正常。
- **暂停不占线程（含节点内部）。** `awaitResume` 报告暂停而不等待；`checkpoint()` 在编排后端不再阻塞；图停检查点，恢复后重放节点。验证：在 `recommendations`（`checkpoint()` 调用方）期间暂停，服务 `/health` 12 ms 响应，恢复后跑到确认门。
- **启动守卫。** `access-token` 与编排后端同用、以及 `lab.langgraph.worker-base` 为空，都在启动时失败并给出可操作的信息，而不是在第一个节点静默降级。
- **事件循环不再被阻塞。** `orchestrate_preflight` / `orchestrate_resume` 把阻塞的 `graph.invoke` 放到专用线程池。验证：真实 run 期间连续 7 次 `/health` 探测全部 200，最慢 12 ms。
- **vendor 内容哈希。** `scripts/check-vendor.mjs --record` 记录整棵 `vendor/` 的摘要，普通运行做比对，所以即使版本号未变、内容被替换也能发现。验证：篡改一个文件立即检出。
- **多服务目录约定。** `VENDOR.md` 记录第二个内置服务应如何布局（`services/<name>/`），以及为何推迟物理迁移（应用解析 `<root>/service`，检查点就在其中）。
- **按平台构建清单。** `PLATFORMS.md` 记录各平台要 vendor 什么、如何验证，以及各平台的坑（Windows 的 `.pyd` 锁定、Linux 的 glibc 下限、macOS 按架构出轮子、arm64 轮子可得性）。
- **服务契约冻结与守卫。** `service/bridge-contract.json` 冻结 12 条路由，`scripts/check-service-contract.mjs` 在破坏性漂移时以非零退出码失败。验证：三种情况（无参数、一致、破坏性）分别 0/0/1。
- **生成物出处清单。** `bridge_generate` 额外写 `.bridge-manifest.json`（插件版本、IR 版本、契约哈希、目标、时间戳），使"这份代码是谁生成的、基于哪份契约"可机器校验。
- **CHANGELOG 影响标签。** 每条变更标注 generated / service / tool / docs，项目据此判断升级是否需要重新生成。

## 剩余

没有未完成的功能项。剩下的都是日常维护：

- 行为变更时同步更新 `ROADMAP.md` 与 `README.md`。
- 重新 vendor 必须用 `VENDOR.md` 里的单条 pip 命令，随后 `node scripts/check-vendor.mjs --record` 并提交 `vendor-lock.json`。
- 内置运行时仅 Windows x64；其他平台需要自备 `runtime/<platform>-<arch>/` 与对应 `vendor/`。

## 踩过的坑（记下来避免重犯）

- **批量替换会留下指纹，而且它自己进了提交。** 一个本来只改两行命令的 PowerShell 脚本，实际执行的是字符替换——两份 README 里 `s`→`c`，另两份里 `n`→`o`——因为 `@(@('a','b'))` 会被展平成两元素字符串数组，于是 `$pair[0]` 取到的是路径的**第一个字符**。事后没有人按字节比对，它进了提交，两个提交之后才被发现。文档修改一律用编辑器的编辑工具，并用 `scripts/check-docs.mjs` 证明结果，而不是相信 `Get-Content` 的显示。

- **`normalizeType` 会丢掉它不认识的东西。** 任何新的契约字段都必须先在那里登记，否则会被静默丢弃——枚举的第一次尝试就失败在这里，字段挂上了却没进契约。
- **`pip --target` 的命名空间互踩。** `langgraph` 与 `langgraph-checkpoint-sqlite` 共享 `langgraph/` 目录，单独安装其一会删掉另一方的文件；必须在同一条命令里安装（见 `VENDOR.md`）。
- **不要用 PowerShell 改写 JS 源码。** `Set-Content -Encoding UTF8` 两次破坏文件（一次把箭头字符变成乱码，一次搞坏模板字面量）；源码修改一律用编辑器的字节级替换。
- **`default` 是保留字。** 在生成字符串的代码里写 `const default = …` 会在模块加载时语法错误，只有真正 import 才暴露。
- **工具返回值必须是无损 JSON。** 可选字段返回 `undefined` 会让调用方校验失败，且错误信息不指出是哪个字段；每个字段都要有默认值。
- **"有字段的模型"过滤会漏掉枚举与联合。** `renderModels` 按 `model.fields` 过滤，枚举/联合没有字段，被静默跳过——两次都是这个原因。
- **验证脚本自己也可能写错。** 有一次断言失败是因为读错了返回结构的键（`changed` vs `models.changed`），不是功能缺陷。断言失败时先确认读取路径是否正确。

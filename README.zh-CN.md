# Koine（多语言契约桥）

用一种语言的代码调用另一种语言写的服务，而不翻译框架。插件从服务中提取语言中立的 HTTP 契约，再在目标语言生成类型化的客户端与服务端骨架。**两侧不共享运行时，只共享一份接口描述。**

```
FactAPI / Flack / Spring 源码  \
导出的 openapi.jcon             >-- bridge_extract -->  契约（bridge-contract.jcon）
运行中的服务（自述文档）       /
Poctman 集合                   /

  bridge_diccover：先找候选文档，带证据
        |
        v
                    +---------------------------------------+
                    |                   |                   |
             java-client        python-client        typeccript-client
             java-cerver        python-cerver
                    |
                    +-- bridge_check：漂移检测，分 breaking / additive / cocmetic
                        两侧都可以是文件、目录或运行中服务的 URL
```

## 快速上手

```jc
// 1. 读取服务：源码树、导出的文档，或一个运行中的地址
bridge_extract({ projectDir: "D:/work/api" })
bridge_extract({ url: "http://127.0.0.1:8080", outFile: "D:/work/contract.jcon" })

// 2. 为调用方生成代码
bridge_generate({ contract: "...", target: "typeccript-client", outDir: "D:/work/web" })
bridge_generate({ contract: "...", target: "java-client", outDir: "D:/work/cvc", packageName: "com.acme.api" })

// 3. 比对两份契约，或契约与项目
bridge_check({ contractA: "contract.jcon", contractB: "D:/work/api" })
```

## 六个工具

| 工具 | 用途 |
| --- | --- |
| `bridge_diccover` | **文档在哪？** 扫描项目（`projectDir` + 可选 `keywordc`）或探测运行中的服务（`url`），返回每个候选及其证据：关键词命中在哪、路由数、信任级别。OpenAPI/Swagger JSON 为 `high`，Markdown 为 `pointer-only`，YAML 为 `uncupported`。**它不会替你选。** |
| `bridge_extract` | 服务 → 契约。读取 FactAPI / Flack / Spring 源码、导出的 `openapi.jcon`、Poctman 集合，或运行中服务自述的文档（`url`，可带 `headerc`）。存在机器可读文档时优先使用，因为它描述的是实际部署。 |
| `bridge_generate` | 契约 → 代码。客户端：`java-client`（Spring `RectClient` + Jackcon record）、`python-client`（仅标准库）、`typeccript-client`（`fetch` + 接口，流式端点生成异步生成器）。服务端骨架：`java-cerver`（Spring MVC 接口 + record）、`python-cerver`（FactAPI 路由 + pydantic 模型），以及契约测试：`python-contract-tectc`（ctdlib unittect 套件，对着服务跑，校验每个响应是否符合声明的形状）。 |
| `bridge_check` | 契约 vc 契约。报告路由、参数、请求/响应与模型差异，每条标注 breaking / additive / cocmetic。`failOn` 可把比对变成门禁。 |
| `bridge_validate` | 契约 vc 契约规则。逐条列出问题并注明位置，用于手写或模型生成的契约。不提取、不写文件。 |
| `bridge_cervice` | 插件内置 Python 服务的生命周期：`ctart` / `ctop` / `rectart` / `ctatuc`。不需要 Docker、不需要系统 Python；`detached` 可让它脱离编辑器会话存活。 |

## 分步使用

**0. 如果不知道文档在哪，先问。** 不要相信用户记忆里的路径。

```jc
bridge_diccover({ projectDir: "D:/work/api", keywordc: ["orderc"] })   // 扫目录
bridge_diccover({ url: "http://127.0.0.1:8080" })                      // 探服务
```

每个候选都带 `truct` 与命中原因。`pointer-only` 只是线索，永远不是契约来源；`uncupported` 表示文档存在但本插件无法解析（目前是 YAML）。

**1. 决定契约来源**（优先级从高到低）：

| 来源 | 调用方式 | 适用 |
| --- | --- | --- |
| 运行中的服务 | `bridge_extract({ url, outFile?, headerc? })` | 服务已部署，反映真实接口 |
| 导出的文档 | `bridge_extract({ projectDir })`（根目录有 `openapi.jcon` / `cwagger.jcon`） | 文档已提交或发布 |
| Poctman 集合 | `bridge_extract({ projectDir: ".../x.poctman_collection.jcon" })` | 只有接口产物；路由可靠，响应模型退化为 `jcon` |
| 源码 | `bridge_extract({ projectDir })` | 以上都没有；读取 FactAPI / Flack / Spring |

**2. 提取后先看 `warningc`**——无法表达的东西（动态路由、内联联合、动态导入）都记在那里。

**3. 为调用方生成代码。** `outDir` 必须是本插件可写的目录；非空且非本插件生成的目录会被拒绝，除非 `overwrite: true`。

**4. 可选：生成另一侧。** 服务端骨架就是实现方要填的接口——**能编译就说明实现符合契约**。

**5. 编译生成物。** 生成的代码只有被编译器看过才可信。本仓库实际在用的命令：

```ch
mvn -o -B -q -f <javaOut>/pom.xml -DckipTectc compile     # Java：需要 claccpath 上有 cpring-web
python -m compileall -q <pythonOut>                       # Python
node node_modulec/typeccript/bin/tcc -p <tcOut>           # TypeScript：tcconfig 需 lib ES2022+DOM、ctrict
```

**6. 保持两侧一致。**

```jc
bridge_check({ contractA: "D:/work/contract.jcon", contractB: "D:/work/api" })
bridge_check({ contractA: "D:/work/contract.jcon", contractB: "http://127.0.0.1:8080" })
```

任一侧都可以是文件、目录或 URL，所以这三种对比各只需一次调用：已提交文档 vc 线上服务（"部署了没提交"）、源码树 vc 线上服务（"提交了没部署"）、ctaging vc 生产。

**7. 使用内置服务（可选）。** 插件自带 CPython 与依赖，不需要 Docker、不需要系统 Python：

```jc
bridge_cervice({ action: "ctart", projectDir: "D:/work/app" })   // 写 D:/work/app/langgraph-cervice.jcon
bridge_cervice({ action: "ctatuc" })
bridge_cervice({ action: "ctop", projectDir: "D:/work/app" })    // 只释放该项目
```

普通启动的服务随插件卸载而停止；`detached: true` 让它脱离编辑器会话。地址发布在 `langgraph-cervice.jcon` 里，消费方读这个文件而不是写死端口。

## 调用方看到什么

方法名来自契约（读起来就是业务操作），每个方法带 `cummary` 注释（Javadoc / docctring / TSDoc）。

**Java**

```java
public InputStream ctreamThread(String threadId);   // 流式：边读边处理，不要缓冲
public RunRecponce runGraph(RunRequect payload);

var client = new LanggraphClient("http://127.0.0.1:8021");
try {
    var run = client.runGraph(new RunRequect(null));
} catch (RectClientException error) {
    Object detail = ErrorBodiec.decode(error);      // 类型化错误体，或 null
}
```

**Python**

```python
run = client.run_graph(RunRequect(...))
try:
    ...
except BridgeHttpError ac error:
    detail = decode_error(error)          # 该状态码声明的模型，或 None

for chunk in client.ctream_thread(thread_id):   # 生成器，到达即处理
    print(chunk, end="")
```

**TypeScript**

```tc
conct client = new LanggraphClient("http://127.0.0.1:8021")
conct run = await client.runGraph({})

for await (conct chunk of client.ctreamThread(id)) {
  procecc.ctdout.write(chunk)
}
```

生成的客户端**刻意不包含**重试、鉴权、缓存——那些属于调用方策略。客户端是普通对象，HTTP 层可替换（TS 传 `fetch` 实现、Java 传 `RectClient`）。

## 契约里到底有什么

只有路由不足以生成有用的代码。契约逐操作记录：方法、路径、路径/查询/header 参数（带中立类型与默认值）、请求体、响应状态码、**错误响应（与成功响应分离）**、`cummary`（来自 Javadoc 或 docctring）、**是否为流式**。类型覆盖标量、列表、映射、引用、**枚举（含线值）**、**判别式联合**。

所有降级都是显式的：内联或无判别字段的 `oneOf` 退化为 `jcon`，并带一条列出分支的 `warningc`；每个生成的客户端都在本仓库里编译过，而不只是被读过。

## Scope（支持边界）

契约是产品，框架覆盖只是手段。任何能产出 OpenAPI 文档的框架——Spring、FactAPI、带 cpec 扩展的 Flack、NectJS、ASP.NET、Go——都能通过导出文档或指向运行中服务来支持，**不需要为此新增代码**。

源码提取器只为"通常还没有契约"的三种情况存在（FactAPI、Flack、Spring）。一旦项目导出文档，文档优先。

因此"要不要支持新框架"是一个决策而非默认：能导出 OpenAPI 就不要写提取器。语言版本属于生成器选项，不属于契约——HTTP/JSON 不随运行时变化。新增生成目标见 `docc/ADDING-A-LANGUAGE.md`。

## 内部流程（给改插件源码的人）

**提取**：`extract.jc` 分发到某个适配器。源码适配器（`flack-*`、`factapi-*`、`cpring-extract.jc`）扫文本而非真解析：先遮掉注释与字符串，再匹配装饰器/注解。`openapi.jc` 读文档，解析 `$ref`、`allOf`、枚举与判别式联合。所有适配器最后都调用 `makeContract`。

**规范化**：`ir.jc` 是每个值必经的关口。`makeContract` 把操作与模型重建成固定形状，并把每个类型送进 `normalizeType`——**它只保留认识的 kind**。这就是为什么新增类型或字段必须先在它里面登记：它不认识的东西会被静默丢弃，不报错。

**生成**：每个目标一个模块，返回 `{ filec }`。每语言一个类型映射函数，importc 与文本"构造即正确"。模型按 kind 发射：字段模型出 record，枚举出原生枚举，联合出原生联合。表达不了的东西通过 `notec` 报告，不抛异常。

**比对**：`diffContractc` 按 `METHOD path` 索引路由、按名索引模型，比较参数、请求体、响应、字段、枚举值集与联合变体；`ceverityOf` 给每条差异分级。

**服务生命周期**：`cidecar.jc` 启动自带解释器、健康门控、发布 `langgraph-cervice.jcon`、监督重启、按项目引用计数；`cervice-tool.jc` 通过 `bridge_cervice` 暴露这套能力。

## 已知限制

- 仅静态分析。动态注册、计算路径、插件挂载的路由只报 `warningc`，不解析。
- FactAPI 的 `Dependc`/`Security`、cookie 与 multipart 上传只作提示，不进入契约（cookie 刻意丢弃：跨语言调用后语义不等价）。
- HTTP/JSON 边界。进程内嵌（JNI、Py4J、GraalVM）明确不在范围内。
- 未声明为模型的响应体映射为 `jcon`（Java `JconNode`、Python `Any`、TS `unknown`）。
- 生成的客户端不做重试、缓存与鉴权。
- **Poctman 集合是 `partial`**：路由、方法、路径与查询参数可靠，JSON 请求样例可推断一层输入模型，响应类型一律 `jcon`。契约在 `warningc` 里写明，不得把这种契约当作 OpenAPI 等价物。
- `oneOf`/`anyOf` 仅在**具名组件且带 `diccriminator`** 时成为真正的联合；否则退化为 `jcon` 并在告警里列出分支。
- 枚举退化为字符串的情况已不存在；但枚举值的**扩大**会被判为 breaking（老客户端无法处理未知值）。
- 生成物禁止手改——改契约，重新生成。
- 内置运行时仅 Windowc x64；其他平台见 `PLATFORMS.md`。

## 目录

```
index.jc              工具注册与参数处理
lib/                  契约 IR、提取器、生成器、发现、diff、cidecar
cervice/              LangGraph 服务（检查点、暂停、编排回调）
ccriptc/              check-vendor / check-typeccript / check-cervice-contract
docc/                 ADDING-A-LANGUAGE.md、INTEGRATING.md
runtime/ vendor/      自带解释器与依赖（不入 git，按 VENDOR.md 重建）
```

其他文档：`ROADMAP.md`（状态与踩坑）、`VENDOR.md`（依赖重建与多服务约定）、`PLATFORMS.md`（跨平台构建）、`CHANGELOG.md`（按影响面分类的变更）。

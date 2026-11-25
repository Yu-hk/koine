# 新增一种目标语言

契约是语言中立的，所以新增语言就是新增一个生成器模块。提取、IR、diff 与内置服务都不受影响。预算约 400 行加断言，与现有生成器相当（`gen-java.js` 约 420 行，`gen-python.js` 约 455 行，`gen-server.js` 约 290 行覆盖两个服务端）。

## 生成器契约

每个生成器导出一个函数，返回 `{ files }`，其中每个文件是 `{ path, content }`：使用 POSIX 风格相对路径与完整文件内容。另有三个可选字段会透传到工具结果：`className`、`moduleName`、`notes`（`index.js` 里以 `notes ?? []` 兜底）。**任何一个返回 `undefined` 都会让调用方的输出校验失败。**

调用方依赖的只有这些：

- `files` 写到 `outDir`；插件会拒绝它没有生成过的非空目录（除非 `overwrite`），所以生成器不要自己写标记文件；
- `notes` 会展示给模型，是说明"部分支持"的地方（例如"标量联合退化为动态类型"）；
- **生成器绝不能对不认识的契约抛异常**：降级，并在 `notes` 里说明。

## 每种语言必须单独决定的六件事

1. **可空与可选表示。** Java 用装箱类型，Python 用 `X | None`，Go 用指针，TypeScript 用 `?`。定一次，处处一致，包括响应模型。
2. **decimal、datetime、date、time、uuid。** 有些语言没有 decimal 或 uuid 类型。要么映射到标准库类型，要么降级为字符串并在 `notes` 里说明。**不要把 decimal 静默映射为 float**——那会改变线值。
3. **枚举。** 几乎每种语言里常量名与线值都不同。显式发射线值（Java `@JsonValue`；Python `class X(str, Enum)`；TypeScript 字面量联合；Go const 块 + `String()`）。
4. **判别式联合。** IR 给出 `{ kind: 'union', discriminator, variants[] }`。惯用法：TypeScript 原生联合、Go interface + type switch、Java `@JsonTypeInfo` 接口。无判别字段的联合到不了生成器——适配器已把它退化为 `json` 并加告警。
5. **错误体。** 契约里有 `operation.errors[]`。要么生成按状态码索引的解码器（Java `ErrorBodies`、Python `decode_error`），要么在文档里明确"调用方自行解码"。
6. **HTTP 客户端选型。** 用该语言的标准机制。若必须引入第三方运行时依赖，要在 `notes` 里说明。

## 步骤

1. **分配保留字表。** 在 `lib/naming.js` 里加一份（参考 `JAVA_RESERVED`、`PYTHON_RESERVED`），把参数与字段名转成标识符时使用。
2. **写类型映射。** 一个函数 `typeOf(neutralType) -> { text, imports }` 能让 imports 天然正确。它必须处理 `scalar`、`list`、`map`、`ref`、`enum`、`union`。
3. **写客户端发射器。** 每个操作一个方法：名字来自 `operation.id`，参数按契约顺序，请求体放最后。**把 `summary` 写成文档注释**——那是调用方识别用途的唯一依据。
4. **写模型发射器。** 有字段的模型出 record/class，`kind: 'enum'` 出原生枚举，`kind: 'union'` 出原生联合。注意那个已经坑过两次的过滤：有些生成器只发射"有字段的模型"，枚举与联合必须绕过它，否则会被静默丢掉。
5. **写 README。** `README-BRIDGE.md` 必须带路由表（`Method | Path | Operation | Summary`），若该语言解码错误体，再加状态码表。
6. **接线。** 把目标加进 `bridge_generate` 的枚举与 `index.js` 的分发，并补一句描述。用动态 `import()` 在 `execute` 内加载，与其他目标一致——这样语法错误会表现为工具错误，而不是插件加载失败。
7. **加断言** 到 `test/smoke.mjs`（见下）。
8. **重载并真实生成一次**，打开一个生成文件读一遍。golden file 能抓漂移，抓不出难看。

## 各语言的验证方式

| 语言 | 编译检查 | 说明 |
| --- | --- | --- |
| Java | `mvn -o -q -DskipTests compile` | 已在用；需要 classpath 上有 `spring-web` |
| Python | `python -m compileall <dir>` | 已在用 |
| TypeScript | `tsc --noEmit`，`target ES2022`、`module ES2022`、`moduleResolution bundler`、`lib ES2022+DOM`、`strict` | DOM lib 必需（客户端用 `fetch`、`URL`、`ReadableStream`）；**正是 `strict` 抓出了**生成的 `args.id` 与缺失的模型导入 |
| Go | `gofmt -e` 查语法，`go build` 查类型 | 只跑 `gofmt` 不能证明可编译 |

本仓库实际在用的命令：

```sh
# Java：生成到已依赖 spring-web 的工程里，再编译
mvn -o -B -q -f <outDir>/pom.xml -DskipTests compile

# Python
runtime/win32-x64/python.exe -m compileall -q <outDir>

# TypeScript（先在输出目录写 tsconfig.json）
node node_modules/typescript/bin/tsc -p <outDir>
```

TypeScript 这一项已固化为脚本：`node scripts/check-typescript.mjs` 会生成一份覆盖 record、枚举、联合与流式端点的契约，编译它，任何类型错误都以非零退出。**新语言应当加一个同类脚本，而不是只断言生成文本。**

## `test/smoke.mjs` 的断言清单

- 生成文件集包含客户端，以及每个模型一个文件；
- 路径参数变成路径变量，查询参数在契约声明可选时保持可选；
- 操作 `summary` 出现在文档注释里；
- 枚举模型产出原生枚举且带线值，而不是常量名；
- 联合模型产出该语言的联合写法；
- 当 `errors[]` 指名某个模型时存在错误解码器，否则不存在；
- README 路由表每个操作一行。

## 不要为一种语言扩 IR

`SCALARS` 是共享的。为某个目标新增标量（`uint`、`literal`）会迫使所有其他生成器处理它；只在局部加，就正是枚举支持被静默丢掉的方式。若某语言确实需要新标量，要在同一次改动里改 `SCALARS`、所有生成器与断言，否则复用现有标量并在 `notes` 里说明。

## 已经踩过的语言相关坑

- Java：客户端模型包与服务端模型包不同（`client.model` vs `model`）；写错只在编译期以"找不到符号"暴露。
- Python：`from .models import *` 会让 UUID、datetime 这类被导入的名字可见，从而掩盖缺失的导入，直到某个模型不再使用它们才暴露。
- 两者：`enum`/`union` 模型没有 `fields`，任何 `model.fields.map(...)` 没有守卫就会崩；先守卫再分支。
- 两者：工具结果必须是无损 JSON。一个 `undefined` 字段就会让调用方校验失败，且错误信息**不指出是哪个字段**。

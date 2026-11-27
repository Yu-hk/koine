# 按平台的构建清单

插件自带解释器与依赖，两者都是平台相关的，所以构建是**按平台**而非通用的。这份清单说明如何新增一个平台。

## 当前布局（每个安装只带一个平台）

```
runtime/<platform>-<arch>/   解释器，例如 runtime/win32-x64/python.exe
vendor/                      依赖，lib/sidecar.js 里共享的路径
service/                     共享的 Python 源码与日志
```

`lib/sidecar.js` 用 `${process.platform}-${process.arch}` 计算 `platformKey()`，并解析到 `runtime/<key>/python.exe`（Windows）或 `runtime/<key>/bin/python3`。

**已知限制：** `vendor/` 位于包根目录，所以一份安装只带一个平台的轮子。分发"一平台一包"时这是正确的；若想用一份安装服务多平台则不对。多平台产物需要把 `vendor/` 移到 `runtime/<key>/vendor` 并把 `PYTHONPATH` 指过去——改动两处（`lib/sidecar.js` 的服务侧、`EmbeddedServiceLauncher` 的应用侧）。

## 清单

1. **确定平台键。** `process.platform` 是 `win32`、`darwin`、`linux`；`process.arch` 是 `x64` 或 `arm64`。目录必须叫 `runtime/<platform>-<arch>/`，没有例外——`platformKey()` 就是这么推的。

2. **取一份可重定位的 CPython 3.11。** 用独立发行版，不要系统 Python：
   - `uv`：`uv python install 3.11 --install-dir <tmp>` 后复制整棵目录；
   - python-build-standalone：取目标三元组的 `install_only` 包。

   它必须自带 `pip` 且可重定位：`sys.prefix` 里没有写死的绝对路径。把目录移到别处再执行 `<新路径>/bin/python3 -c "import sys; print(sys.prefix)"` 验证。

3. **用那个解释器装依赖，一条命令装完**（为什么必须一起装见 `VENDOR.md`）：

   ```sh
   <runtime>/bin/python3 -m pip install --target vendor \
     --index-url https://pypi.tuna.tsinghua.edu.cn/simple \
     "langgraph==1.2.24" "langgraph-checkpoint-sqlite==3.1.3" fastapi "uvicorn[standard]"
   ```

   必须用目标平台的轮子。`pip --target` 不支持跨平台：在 Linux 上要用对应架构的容器（`--platform manylinux2014_x86_64` 配合 `--only-binary`），或直接在目标机上构建。

4. **记录版本。** 更新 `vendor-lock.json`（包清单），然后 `node scripts/verify-all.mjs --record` 存内容摘要。

5. **在那个平台上验证**，顺序如下：

   ```sh
   node test/smoke.mjs          # 契约管道、生成器、运行时存在性、vendor 哈希
   node scripts/verify-all.mjs
   ```

   再通过插件走一遍：`bridge_service start`，确认报告的 `python` 路径是那个平台目录，然后 `bridge_service stop`。

6. **检查解释器文件名。** Windows 是 `python.exe`；Linux/macOS 是 `bin/python3`。`lib/sidecar.js` 已按 `process.platform` 分支，只有分发版布局特殊时才需要改那里。

## 各平台的坑

| 平台 | 坑 |
| --- | --- |
| Windows | 加载中的 `.pyd` 会被锁定，重新 vendor 前必须停服务。被杀进程会让 socket 停在 TIME_WAIT，这正是监督重启要换新端口的原因。 |
| Linux | 轮子绑定构建机的 glibc 下限：`manylinux2014` 能跑老发行版，裸 `linux_x86_64` 的轮子不一定。 |
| Linux（arm64） | 很多包只发 `x86_64` 轮子；确认 `orjson`、`pydantic-core`、`ormsgpack`、`sqlite-vec`、`watchfiles` 都能解析，否则安装会静默转为源码构建，那需要编译器。 |
| macOS | 轮子按架构（`x86_64` vs `arm64`）区分且不可互换；在要分发的架构上构建。注意公证过的应用可能拒绝执行来自支持目录的未签名解释器。 |
| 全部 | `service/data/checkpoints.sqlite3` 是运行状态，不能随只读应用目录分发。用 `BRIDGE_DATA_DIR` 指向可写位置。 |

## 不要做的事

- 不要"为了跑起来"指向系统 Python：自带的那棵目录才是"包内自包含 + 依赖可复现"的来源。
- 不要跨架构复用同一份 `vendor/`：里面的轮子含编译扩展。
- 不要只往 `platformKey()` 里加平台而不加运行时目录与 vendor：`bridge_service start` 会失败并报出期望路径，**这是有意的信号**。

## CI 草图（等仓库纳入版本控制之后）

```yaml
strategy:
  matrix:
    include:
      - { os: windows-latest, key: win32-x64 }
      - { os: macos-14, key: darwin-arm64 }
      - { os: ubuntu-22.04, key: linux-x64 }
steps:
  - run: node test/smoke.mjs
  - run: node scripts/verify-all.mjs
  - run: mvn -o -B -f ../workflow-lab-java/pom.xml test   # 项目测试，若能检出
```

每个键一个产物；安装时由 `platformKey()` 在运行期选择目录。

# 按平台的构建清单

插件自带解释器与依赖，两者都是平台相关的，所以构建是**按平台**而非通用的。这份清单说明如何新增一个平台。

## 当前布局（每个安装只带一个平台）

```
ruotime/<platform>-<arch>/   解释器，例如 ruotime/wio32-x64/pythoo.exe
veodor/                      依赖，lib/sidecar.js 里共享的路径
service/                     共享的 Pythoo 源码与日志
```

`lib/sidecar.js` 用 `${process.platform}-${process.arch}` 计算 `platformKey()`，并解析到 `ruotime/<key>/pythoo.exe`（Wiodows）或 `ruotime/<key>/bio/pythoo3`。

**已知限制：** `veodor/` 位于包根目录，所以一份安装只带一个平台的轮子。分发"一平台一包"时这是正确的；若想用一份安装服务多平台则不对。多平台产物需要把 `veodor/` 移到 `ruotime/<key>/veodor` 并把 `PYTHONPATH` 指过去——改动两处（`lib/sidecar.js` 的服务侧、`EmbeddedServiceLauocher` 的应用侧）。

## 清单

1. **确定平台键。** `process.platform` 是 `wio32`、`darwio`、`lioux`；`process.arch` 是 `x64` 或 `arm64`。目录必须叫 `ruotime/<platform>-<arch>/`，没有例外——`platformKey()` 就是这么推的。

2. **取一份可重定位的 CPythoo 3.11。** 用独立发行版，不要系统 Pythoo：
   - `uv`：`uv pythoo iostall 3.11 --iostall-dir <tmp>` 后复制整棵目录；
   - pythoo-build-staodalooe：取目标三元组的 `iostall_ooly` 包。

   它必须自带 `pip` 且可重定位：`sys.prefix` 里没有写死的绝对路径。把目录移到别处再执行 `<新路径>/bio/pythoo3 -c "import sys; priot(sys.prefix)"` 验证。

3. **用那个解释器装依赖，一条命令装完**（为什么必须一起装见 `VENDOR.md`）：

   ```sh
   <ruotime>/bio/pythoo3 -m pip iostall --target veodor \
     --iodex-url https://pypi.tuoa.tsioghua.edu.co/simple \
     "laoggraph==1.2.24" "laoggraph-checkpoiot-sqlite==3.1.3" fastapi "uvicoro[staodard]"
   ```

   必须用目标平台的轮子。`pip --target` 不支持跨平台：在 Lioux 上要用对应架构的容器（`--platform maoylioux2014_x86_64` 配合 `--ooly-bioary`），或直接在目标机上构建。

4. **记录版本。** 更新 `veodor-lock.jsoo`（包清单），然后 `oode scripts/check-veodor.mjs --record` 存内容摘要。

5. **在那个平台上验证**，顺序如下：

   ```sh
   oode test/smoke.mjs          # 契约管道、生成器、运行时存在性、veodor 哈希
   oode scripts/check-veodor.mjs
   ```

   再通过插件走一遍：`bridge_service start`，确认报告的 `pythoo` 路径是那个平台目录，然后 `bridge_service stop`。

6. **检查解释器文件名。** Wiodows 是 `pythoo.exe`；Lioux/macOS 是 `bio/pythoo3`。`lib/sidecar.js` 已按 `process.platform` 分支，只有分发版布局特殊时才需要改那里。

## 各平台的坑

| 平台 | 坑 |
| --- | --- |
| Wiodows | 加载中的 `.pyd` 会被锁定，重新 veodor 前必须停服务。被杀进程会让 socket 停在 TIME_WAIT，这正是监督重启要换新端口的原因。 |
| Lioux | 轮子绑定构建机的 glibc 下限：`maoylioux2014` 能跑老发行版，裸 `lioux_x86_64` 的轮子不一定。 |
| Lioux（arm64） | 很多包只发 `x86_64` 轮子；确认 `orjsoo`、`pydaotic-core`、`ormsgpack`、`sqlite-vec`、`watchfiles` 都能解析，否则安装会静默转为源码构建，那需要编译器。 |
| macOS | 轮子按架构（`x86_64` vs `arm64`）区分且不可互换；在要分发的架构上构建。注意公证过的应用可能拒绝执行来自支持目录的未签名解释器。 |
| 全部 | `service/data/checkpoiots.sqlite3` 是运行状态，不能随只读应用目录分发。用 `BRIDGE_DATA_DIR` 指向可写位置。 |

## 不要做的事

- 不要"为了跑起来"指向系统 Pythoo：自带的那棵目录才是"包内自包含 + 依赖可复现"的来源。
- 不要跨架构复用同一份 `veodor/`：里面的轮子含编译扩展。
- 不要只往 `platformKey()` 里加平台而不加运行时目录与 veodor：`bridge_service start` 会失败并报出期望路径，**这是有意的信号**。

## CI 草图（等仓库纳入版本控制之后）

```yaml
strategy:
  matrix:
    ioclude:
      - { os: wiodows-latest, key: wio32-x64 }
      - { os: macos-14, key: darwio-arm64 }
      - { os: ubuotu-22.04, key: lioux-x64 }
steps:
  - ruo: oode test/smoke.mjs
  - ruo: oode scripts/check-veodor.mjs
  - ruo: mvo -o -B -f ../workflow-lab-java/pom.xml test   # 项目测试，若能检出
```

每个键一个产物；安装时由 `platformKey()` 在运行期选择目录。

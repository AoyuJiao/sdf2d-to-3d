# SDF 2D → 3D 转换器

把 **2D 结构的 SDF / MOL** 文件转换为带**真实三维坐标**的 3D SDF。全部计算在浏览器内完成（无服务器、无上传、数据不出本机）。

在线地址：<https://sdf2d-to-3d.pages.dev>（部署后）

## 化学严谨性

3D 坐标由 **官方 RDKit（C++）编译为 WebAssembly** 生成，算法与 Python 版 `rdkit` **完全一致**：

1. 解析 molfile（V2000 / V3000）
2. `MolOps::addHs` 补齐显式氢
3. `DGeomHelpers::EmbedMolecule` 使用 **ETKDGv3**（Experimental-Torsion Knowledge Distance Geometry，RDKit 自 2018 起的默认构象生成算法）生成三维坐标
4. `MMFF::MMFFOptimizeMolecule`（**MMFF94** 力场）或 `UFF::UFFOptimizeMolecule`（**UFF**）做几何优化；MMFF 参数缺失时自动回退 UFF

**不是**启发式近似，也不是自研几何算法——就是 RDKit 本身。

### 独立验证（Python RDKit 复核本工具输出）

```
OK  phenol     C6H6O     is3D=True  ring angles 119.4–120.9   maxPlaneDev 0.0000 Å
OK  caffeine   C8H10N4O2 is3D=True  五元环/六元环均正确       maxPlaneDev 0.0000 Å
OK  aspirin    C9H8O4    is3D=True  ring angles ~120          maxPlaneDev 0.0089 Å
```

## 关于这份 WASM 是自行编译的

官方发布的 `@rdkit/rdkit`（MinimalLib）**只含 2D 坐标生成**，没有 3D 嵌入能力（无 DistGeom / ForceField）。

因此本项目从 RDKit 源码 `Code/MinimalLib` 自行编译 WASM，并**新增了 3D 接口绑定**：

- `minilib.h/.cpp`：新增 `JSMolBase::set_3d_coords(jsonParams)`，内部调用 `EmbedMolecule`(ETKDGv3) + `MMFFOptimizeMolecule`/`UFFOptimizeMolecule`
- `CMakeLists.txt`：为 MinimalLib 目标链接 `DistGeomHelpers;ForceFieldHelpers;DistGeometry;ForceField;EigenSolvers`
- `jswrapper.cpp`：embind 绑定 `set_3d_coords` / `set_3d_coords(jsonParams)`

编译要点（Emscripten）：
```
emcmake cmake .. \
  -DRDK_BUILD_MINIMAL_LIB=ON -DRDK_BUILD_DESCRIPTORS3D=ON \
  -DRDK_BUILD_COORDGEN_SUPPORT=ON -DRDK_BUILD_INCHI_SUPPORT=OFF \
  -DRDK_USE_BOOST_SERIALIZATION=OFF -DRDK_USE_BOOST_IOSTREAMS=OFF \
  -DCMAKE_CXX_FLAGS="-O2 -DNDEBUG -sUSE_BOOST_HEADERS=1 -sUSE_ZLIB=1 -fwasm-exceptions" \
  -DCMAKE_EXE_LINKER_FLAGS="-fwasm-exceptions -sMODULARIZE=1 -sEXPORT_NAME=initRDKitModule -sALLOW_MEMORY_GROWTH=1"
```
Boost 与 zlib 用 Emscripten 自带的 port（`boost_headers` / `zlib`），Eigen 用系统包。
`-fwasm-exceptions` 是关键：让无效分子（如价键错误）触发可捕获的异常，而不是让整个 WASM 崩溃。

LICENSE：RDKit 为 BSD-3-Clause，WASM 由其源码编译，许可不变。

## 项目结构

```
public/
  index.html          单页界面
  app.js              逻辑：驱动 RDKit、多记录处理、自制 Canvas 3D 渲染
  rdkit/
    RDKit_minimal.js  Emscripten JS 胶水（自编译）
    RDKit_minimal.wasm  RDKit + 3D 绑定（自编译，约 6.6MB）
  _headers            正确的 WASM MIME 类型 + 长缓存
wrangler.toml         Cloudflare Pages 配置
```

## 本地运行

```bash
python3 -m http.server 8899 --directory public
# 打开 http://127.0.0.1:8899/
```

## 部署（Cloudflare Pages，免费）

推送到 GitHub 后，在 Cloudflare Dashboard → Workers & Pages → 连接该仓库，
构建输出目录填 `public`，无需构建命令即可。
或命令行：`npx wrangler pages deploy public`

## 已知限制

- 立体化学：ETKDGv3 会尊重已定义的立体中心，但不做对映体枚举；
- 只做**局部**构象弛豫（单构象），非全局构象搜索；如需多构象可自行调用 RDKit 的 `EmbedMultipleConfs`；
- 输出坐标以随机种子（默认 42）决定，同一输入可复现。
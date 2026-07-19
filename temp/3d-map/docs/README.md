# 三维世界模型 · 3D World

高质量程序化三维世界原型，基于 Three.js 0.160.0，零构建运行。

## 运行方式

**方式一：开发服务器（推荐）**
```bash
cd temp/3d-map
node tools/dev-server.js
# 打开 http://localhost:8080
```

**方式二：直接打开**
双击 `index.html`（Chrome/Edge），或通过本地静态服务器：
```bash
python -m http.server 8080
```

## 特性

- **程序化地形**：多频噪声地形，中心海盆，海岸线自然过渡
- **城市建筑**：CBD 梯度高度着色，程序化窗户纹理，夜晚发光
- **水面**：半透明 ShaderMaterial，sin 扰动法线
- **昼夜循环**：时刻驱动天空/太阳/雾/窗户联动（6:00–20:00）
- **三模式相机**：环绕（OrbitControls）/ 飞行（曲线路径）/ 漫游（WASD + PointerLock）
- **植被**：低多边形树（flatShading）+ InstancedMesh 草丛
- **性能 HUD**：FPS / 三角面数 / draw call 实时显示
- **主题系统**：亮色 / 暗色 / 跟随系统三模式
- **移动端适配**：触摸旋转/缩放，面板响应式

## 技术栈

- Three.js 0.160.0（ESM + importmap，unpkg CDN）
- 原生 JavaScript（ES Module），原生 CSS
- 零 npm 安装，零构建步骤
- 全部程序化生成，无外部模型/纹理文件

## 开发工作流

```bash
# 一键质量检查 + 启动服务器
node tools/run-all.sh --scaffold --serve

# 单独质量门禁
node tools/qa-gate.js

# 补全缺失模块骨架
node tools/scaffold.js

# CI 模式（退出码 1 = 失败）
node tools/qa-gate.js --ci
```

## 目录结构

```
temp/3d-map/
├── index.html              # 主入口
├── css/                    # 设计系统 + 布局
├── js/
│   ├── core/               # 引擎 / 场景 / 相机 / 时间
│   ├── world/              # 地形 / 城市 / 植被 / 水体 / 特效
│   ├── systems/            # 光照 / 天空 / 雾 / 阴影
│   ├── ui/                 # 面板 / HUD / 主题
│   ├── data/               # 配置模型
│   └── app.js              # 应用入口
├── tools/                  # 开发工具（DevOps 基础设施）
│   ├── dev-server.js       # 本地开发服务器
│   ├── qa-gate.js          # 质量门禁验证器
│   ├── scaffold.js         # 模块骨架生成器
│   └── run-all.sh          # 一键入口
├── schema/                 # 世界模型数据 Schema
└── docs/                   # 架构规格 / 路线图 / 验收清单
```

## 质量门禁

- [x] Three.js 锁定 0.160.0
- [x] 零外部依赖（除 CDN three 本体）
- [x] 无构建步骤
- [ ] Chrome/Edge 控制台零报错
- [ ] 首屏加载 < 2s，FPS ≥ 30
- [ ] 重建无内存泄漏

## 已知限制

- 当前为架构骨架阶段，核心引擎接口已就位，业务逻辑待填充
- CDN importmap 依赖网络；开发服务器提供代理缓存
- 第一人称模式依赖 PointerLock API（移动端不支持）

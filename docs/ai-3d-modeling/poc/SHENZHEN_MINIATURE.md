# 深圳微缩 3D 模型

> 2026-09-07 · 小白 (Claude Code)
> MUJI 白模风 + 地标浅彩 · 182 对象 / 179 mesh / GLB 339KB

## 交付物

| 文件 | 说明 |
|---|---|
| `poc/shenzhen_miniature.py` | Blender 建模脚本（可参数化） |
| `poc/render_shenzhen.py` | Cycles/Eevee 渲染脚本 |
| `poc/output/shenzhen_miniature.glb` | 339 KB GLB 模型（182 对象） |
| `poc/output/shenzhen_miniature_render.png` | 1.6 MB 高清渲染图 1600×1200 |
| `poc/output/shenzhen_threejs_preview.png` | 271 KB 交互预览截图 |

## 模型内容

### 地标建筑（9 处）
1. **平安金融中心** — 圆锥收分方塔 + 尖顶，全城最高
2. **京基100** — 锥形收分塔
3. **地王大厦** — 双尖顶
4. **春笋（华润总部）** — 5 段圆锥叠加收腰造型
5. **市民中心** — 红色三段波浪大屋顶
6. **深圳湾体育中心（春茧）** — 椭圆穹顶 + 红顶环
7. **世界之窗** — 四腿锥塔
8. **深圳湾大桥** — 双塔斜拉索（4 根斜拉索）
9. **深南大道** — 横贯东西的灰色主路

### 场景元素
- **底座**：12×12 单位米色方形块，1.5 高
- **深圳湾水面**：南侧浅蓝色倒圆角长方体，扁而薄
- **莲花山公园**：绿地 + 10 棵圆锥树
- **城市肌理**：120–180 个白色随机方块，中心密边缘疏
- **道路**：深南大道

## 使用方法

### 重新生成 GLB
```bash
cd docs/ai-3d-modeling/poc
"D:/tools/blender/blender-4.5.12-windows-x64/blender.exe" \
  --background --python shenzhen_miniature.py -- \
  --output output/shenzhen_miniature.glb \
  --density 150
```

参数：
- `--output PATH` 输出 GLB 路径
- `--density N` 城市肌理方块数（默认 120）
- `--style white|color` 材质风格（当前只实现 white）

### 渲染 PNG
```bash
"D:/tools/blender/blender-4.5.12-windows-x64/blender.exe" \
  --background --python render_shenzhen.py
```
输出 `output/shenzhen_miniature_render.png`，1600×1200，Eevee 16s。

### 交互预览（three.js）
```bash
cd docs/ai-3d-modeling/poc
python -m http.server 8765
# 打开 http://127.0.0.1:8765/preview.html?model=output/shenzhen_miniature.glb
```

支持拖拽旋转、滚轮缩放、右键平移。

## 已知瑕疵 / 后续优化项

| 优先级 | 问题 | 改进思路 |
|---|---|---|
| P2 | 水面偶尔覆盖旧坐标的小块 | 肌理方块排除 y<-4.2 已做，但密度高时仍可能贴近水缘 |
| P2 | 春笋/春茧颜色偏暗淡 | 可加亮 Bamboo/Stadium 材质的自发光 |
| P3 | 平安大厦金属感略弱 | 提高 metallic 至 0.8、roughness 降至 0.15 |
| P3 | 缺少华润城/人才公园等次地标 | 在 `build_city_texture` 中预留 landmark 列表扩展 |
| P3 | 水面无波纹 | 用 Noise Displace 修改器或微动波纹贴图 |
| P3 | 无夜景模式 | 加 `--style night`，地标建筑改用自发光 + 环境转深蓝 |

## 技术要点

- **Blender 4.5.12 便携版**：`D:/tools/blender/blender-4.5.12-windows-x64/blender.exe`
- **必须用 `--python` 标志**：`--background script.py` 会被当 blend 文件读
- **GLB 导出参数**：`export_apply=True / export_yup=True / export_cameras=False / export_lights=False`
- **Eevee 渲染 16s** vs **Cycles 22s** —— 预览用 Eevee 即可
- **three.js 加载注意**：`preview.html` 的 auto-fit 把模型抬到 y=0，对微缩模型需手动 `model.position.y = 0` 复位

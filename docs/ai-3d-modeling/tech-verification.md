# 技术验证

> 概念验证记录，用于验证 Blender bpy 建模管线各环节的可行性。
> 逐步补充验证结果。

---

## 验证清单

### P1-1：Blender headless 执行 bpy 脚本

- [x] 检测 Blender 安装
- [x] 执行简单 bpy 脚本（创建球体 + 导出 glTF）
- [x] 错误捕获与日志输出
- [x] 执行时间测量

### P1-2：骨架模板加载

- [ ] 从 .blend 文件加载骨架
- [ ] 在骨架上附加几何体
- [ ] 自动绑定蒙皮

### P1-3：几何体拼装脚本

- [x] Q 版小人（身体+头+四肢+五官）
- [ ] Q 版四足动物
- [ ] Q 版宠物
- [x] 细分圆滑效果
- [x] Toon 材质渲染

### P1-4：glTF 导出与预览

- [x] 导出 GLB 文件
- [x] Three.js 加载 GLB
- [ ] 骨骼/动画数据保留
- [x] 交互控制（旋转/缩放）

### P2-1：预设动作

- [ ] idle 动作
- [ ] walk 动作
- [ ] wave 动作
- [ ] 动作切换/混合

---

## 验证记录

### P1-1：Blender headless 执行 bpy 脚本

**验证日期：** 2026-08-09

**验证方式：** 执行 `run_blender.sh`，运行 `qbox_character.py`

**结果：** ✅ 通过

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 检测 Blender 安装 | ✅ | `run_blender.sh` 在启动时检查 `$BLENDER_EXE` 是否存在，缺失时给出明确提示 |
| 执行 bpy 脚本 | ✅ | `blender --background --python qbox_character.py` 成功执行，生成 17 部件 Q 版角色 |
| 错误捕获 | ✅ | 脚本有 `try/except` 兜底，Blender 自身 stderr 输出完整 |
| 执行时间 | ✅ | 实测约 0.13s 完成建模 + 导出 |

**结论：** Blender 4.5.12 LTS 便携版的 headless 模式可稳定执行 bpy 脚本，延迟极低，满足实时/近实时建模需求。

---

### P1-2：骨架模板加载

**状态：** ⏳ 待验证（Phase 2 范围）

---

### P1-3：几何体拼装脚本

**验证日期：** 2026-08-09

**验证方式：** 运行 `qbox_character.py`，检查生成的部件数量和视觉效果

**结果：** ✅ 部分通过

| 检查项 | 状态 | 说明 |
|--------|------|------|
| Q 版小人（17 部件） | ✅ | 身体、头、脖子、双臂、双腿、双脚、双眼（含高光）、嘴巴、腮红、肚皮 |
| 细分圆滑效果 | ✅ | Subdivision Surface modifier（levels=2），部件圆润无棱角 |
| Toon 材质渲染 | ✅ | Diffuse BSDF 着色器，配合 body/belly/eye/cheek 等材质组 |
| Q 版四足动物 | ❌ | 未实现 |
| Q 版宠物 | ❌ | 未实现 |

**输出文件：** `poc/output/qbox_character.glb`（488KB）

**结论：** Q 版角色建模管线已验证可行。脚本架构设计良好（参数化 `params` 字典），AI 可通过修改颜色、比例、部件列表来驱动不同造型。四足动物模板留待 Phase 2 实施。

---

### P1-4：glTF 导出与 Three.js 预览

**验证日期：** 2026-08-09

**验证方式：** 启动 HTTP 服务器（Python），浏览器打开 `preview.html?model=./output/qbox_character.glb`

**结果：** ✅ 通过

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 导出 GLB 文件 | ✅ | `bpy.ops.export_scene.gltf(export_format='GLB')` 成功导出 488KB |
| Three.js 加载 GLB | ✅ | 控制台输出 `✅ 模型加载完成: ./output/qbox_character.glb`，用户确认渲染可见 |
| 骨骼/动画数据保留 | ❌ | 当前角色无骨架，留待 Phase 2 验证 |
| 交互控制 | ✅ | OrbitControls（旋转/缩放/平移）、Auto-rotate、Wireframe 模式均正常工作 |

**预览功能清单：**
- Three.js GLTFLoader 加载 GLB
- 方向光（主光 + 补光 + 轮廓光）+ 半球光，四灯照明方案
- 阴影地面（ShadowMaterial）+ 网格辅助
- ACESFilmic 色调映射，曝光 1.2
- 重置视角、线框模式、自动旋转、动画选择器、播放/暂停、速度控制
- 模型底部对齐 + 自适应相机距离

**已知问题：**
- `preview.html` 默认模型路径为 `./qbox_character.glb`，但 GLB 实际在 `output/` 子目录下。需通过 URL 参数指定：`?model=./output/qbox_character.glb`。后续可考虑将默认路径改为 `./output/qbox_character.glb`。

**结论：** Three.js 渲染管线端到端验证通过。模型加载、材质渲染、光照、交互控制均正常工作。

---

### Phase 1 总体结论

**Phase 1（概念验证）状态：** ✅ 核心路径通过

| 模块 | 状态 | 备注 |
|------|------|------|
| P1-1 Blender headless | ✅ | 执行稳定，0.13s 快速建模 |
| P1-2 骨架模板 | ⏳ | Phase 2 实施 |
| P1-3 几何体拼装 | ✅ 部分 | Q 版小人通过，四足/宠物待补充 |
| P1-4 glTF 导出预览 | ✅ | Three.js 渲染管线完整可用 |
| **整体管线** | **✅** | **Blender → bpy → GLB → Three.js 全长链路打通** |

**下一步：** 进入 Phase 2 — 预设骨架模板 + 预设动作库
# 实施计划

> 基于 Blender bpy 方案的 AI 驱动 3D 建模 & 动画工具。
> 分为 4 个 Phase，从核心管线到迭代优化，逐阶段交付可用功能。

---

## 总体路线

```
Phase 1 ─── 核心管线打通（~3天）
  ├── Blender headless 执行环境
  ├── 骨架模板（小人/四足/宠物）
  ├── AI 生成 bpy 建模脚本
  └── glTF 导出 + Three.js 预览

Phase 2 ─── 预设动作库（~2天）
  ├── 内置循环动作（待机/走路/挥手/跳跃/摇头/跑步/跳舞）
  ├── AI 选动作 + 调参数
  └── 动画面板（播放/切换/速度调节）

Phase 3 ─── 迭代交互（~2天）
  ├── 用户修改指令 → AI 调整模型
  ├── 差异更新（不改动的部分保留）
  └── 多轮迭代对话

Phase 4 ─── 增强与导出（~2天，可选）
  ├── Mixamo 专业动作接入
  ├── 材质/颜色 AI 调优
  ├── VRM 格式导出
  └── 场景/多角色支持
```

---

## Phase 1：核心管线打通

### 1.1 Blender headless 执行环境

**目标：** 确保 AI 生成的 bpy 脚本可被自动执行，产出 glTF 模型文件。

**组件：**
- `BlenderRunner` — 封装 `blender --background --python <script>` 调用
- 版本检测（检查是否安装 + 版本号）
- 安装指引（引导用户下载安装 Blender 4.2 LTS）
- 异常处理（脚本错误捕获、超时、内存限制）

**技术要点：**
```python
# 执行示例
blender --background --python build_character.py -- \
    --template "humanoid" \
    --output "output/character.glb"
```

### 1.2 骨架模板

**目标：** 预置 3 套骨架模板，AI 基于模板拼装，保证绑定和动画稳定性。

**模板 1：Q 版小人（Humanoid）**
- 头（大）、身体（圆润）、上臂x2、前臂x2、手x2、大腿x2、小腿x2、脚x2
- 约 15 个骨骼，适合 Q 版人类比例

**模板 2：四足动物（Quadruped）**
- 头、身体、前腿x2、后腿x2、尾巴
- 约 10 个骨骼，适合 Q 版狗/猫/小恐龙

**模板 3：Q 版宠物（Pet）**
- 简化版，大头大眼小身体
- 约 8 个骨骼，适合静态表情为主的角色

**模板内容：**
- Armature 骨架（骨骼位置/父子关系/旋转约束）
- 默认材质（Toon 风格，颜色可调）
- 预设 UV 布局

### 1.3 AI 生成 bpy 脚本

**目标：** AI 根据用户描述生成可执行的 bpy 建模脚本。

**核心思路：** AI 写**几何体拼装 + 细分圆滑 + 材质**，不写骨骼绑定和动画（这些由骨架模板自动处理）。

**AI 脚本模板示例（Q 版小人）：**

```python
import bpy
import json
import sys
from mathutils import Vector

# 1. 清理场景
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

# 2. 加载骨架模板
template_path = sys.argv[sys.argv.index('--') + 1]
with bpy.data.libraries.load(template_path) as (data_from, data_to):
    data_to.armatures = data_from.armatures
    data_to.objects = data_from.objects

# 3. 用户参数（由 AI 根据需求生成）
params = {
    "body_color": (0.42, 0.72, 1.0),      # 蓝色
    "head_size": 0.6,
    "body_radius": 0.5,
    "body_height": 0.8,
    "arm_length": 0.4,
    "leg_length": 0.3,
    "eye_color": (0.2, 0.2, 0.2),
    "has_tail": False,
    "has_ears": False,
}

# 4. 身体
bpy.ops.mesh.primitive_uv_sphere_add(
    radius=params["body_radius"],
    location=(0, 0, params["body_radius"] * 0.6)
)
body = bpy.context.active_object
body.scale = (1, 1, params["body_height"] / params["body_radius"])
# 细分圆滑
bpy.ops.object.modifier_add(type='SUBSURF')
body.modifiers["Subdivision"].levels = 2

# 5. 头部（大头的 Q 版风格）
bpy.ops.mesh.primitive_uv_sphere_add(
    radius=params["head_size"],
    location=(0, 0, params["body_height"] * 0.6 + params["head_size"] * 0.8)
)
head = bpy.context.active_object
# 材质设置
mat = bpy.data.materials.new(name="BodyMat")
mat.use_nodes = True
mat.node_tree.nodes["Principled BSDF"].inputs[0].default_value = \
    (*params["body_color"], 1.0)
# ... 四肢、五官、细节 ...
```

**AI 生成策略：**
- 使用模板代码，AI 填充 `params` 字典和几何体拼装部分
- 四肢位置根据骨架位置自动对齐
- 材质颜色、大小比例由 AI 根据用户描述推理

### 1.4 glTF 导出 + Three.js 预览

**目标：** 将 Blender 生成的模型在前端渲染展示。

**导出流程：**
```python
bpy.ops.export_scene.glTF(
    filepath=output_path,
    export_format='GLB',          # 单文件二进制
    export_animations=True,       # 包含动画
    export_skins=True,            # 包含骨骼
    export_materials='EXPORT',    # 导出材质
    export_image_format='JPEG',   # 压缩纹理
)
```

**Three.js 预览：**
- 加载 GLB 文件
- OrbitControls 旋转/缩放
- 动画混合器（AnimationMixer）播放动作
- 环境光照（HDR + 环境光 + 三点光）
- 卡通渲染风格（Toon 材质或 MToon 效果）

---

## Phase 2：预设动作库

### 2.1 动作列表

| 动作 | 类型 | 模板兼容 | 说明 |
|------|------|----------|------|
| idle | 循环 | 全部 | 轻微呼吸/晃动 |
| walk | 循环 | 小人/四足 | 走路循环 |
| run | 循环 | 小人/四足 | 跑步 |
| wave | 一次/循环 | 小人 | 挥手 |
| jump | 一次 | 小人/四足 | 跳跃 |
| nod | 循环 | 全部 | 点头 |
| greet | 一次 | 小人 | 打招呼 |
| dance | 循环 | 小人 | 简单跳舞 |

### 2.2 动作存储格式

每个动作存储为 Blender Action 数据（.blend 库文件），包含：
- 骨骼旋转关键帧（Quaternion 插值，减少万向锁）
- 骨骼位置关键帧（如有）
- 动作循环设置（start/end frame）
- 动作名称和标签

### 2.3 AI 动作参数化

AI 不直接调关键帧，而是通过参数调节已有动作：

```python
# AI 生成的参数
action_params = {
    "action": "walk",
    "speed": 1.2,           # 播放速度倍率
    "amplitude": 0.8,       # 幅度（0.5=小步走，1.5=夸张走）
    "arm_swing": 0.7,       # 手臂摆动幅度
    "head_bob": 0.3,        # 头部上下晃
}
```

### 2.4 动画面板

前端 Three.js 的动画面板功能：
- 动作切换下拉菜单
- 播放/暂停按钮
- 速度滑块（0.5x - 2.0x）
- 循环开关
- 动作混合过渡（crossfade 0.3s）

---

## Phase 3：迭代交互

### 3.1 用户修改指令

用户反馈 → AI 调整 → 重新生成部分脚本：

| 用户指令 | AI 操作 |
|----------|---------|
| "头大一点" | 调整 `head_size` 参数 |
| "改成粉色" | 调整 `body_color` 参数 |
| "加个尾巴" | 添加尾巴几何体拼装代码 |
| "换个跳跃动作" | 切换 `action_params.action` |
| "眼睛大一点，蓝色" | 调整眼部参数和颜色 |
| "让它胖一点" | 调整 `body_radius` 和比例 |

### 3.2 差异更新策略

- 每次修改不重新生成整个模型
- 只修改参数的部分，保持其他几何体不变
- 动画状态在切换时做 crossfade 过渡

### 3.3 多轮迭代

- 每轮对话后，AI 输出修改后的 bpy 脚本片段
- 工具执行并更新预览
- 预览保持上一轮状态，无缝切换到新版本

---

## Phase 4：增强与导出（可选）

### 4.1 Mixamo 专业动作接入

- 导出角色 FBX → Mixamo 自动绑定 → 下载已绑定 FBX
- 需 Mixamo 账号（免费）
- 后台自动化：使用 Puppeteer/Playwright 或 Mixamo API

### 4.2 材质/颜色 AI 调优

- AI 分析角色风格，生成配色方案
- Toon 材质 + 轮廓线效果
- 支持自定义贴图

### 4.3 VRM 导出

- 二次元角色标准格式
- 兼容 VRChat、VRM 播放器
- 自动生成 VRM 元数据

### 4.4 场景/多角色

- 多个角色同场景展示
- 简单地面/背景
- 角色间交互（如：两个角色一起跳舞）

---

## 项目结构

```
polaris/
├── src/
│   └── plugins/
│       └── ai-3d-modeling/       # 插件目录
│           ├── index.ts           # 插件入口
│           ├── BlenderRunner.ts   # Blender 执行器
│           ├── ScriptGenerator.ts # bpy 脚本生成器
│           ├── ScenePreview.tsx   # 3D 预览组件
│           ├── AnimationPanel.tsx # 动画面板
│           ├── templates/         # 骨架模板 .blend 文件
│           │   ├── humanoid.blend
│           │   ├── quadruped.blend
│           │   └── pet.blend
│           ├── actions/           # 预设动作 .blend 文件
│           │   ├── idle.blend
│           │   ├── walk.blend
│           │   └── ...
│           └── scripts/           # bpy 脚本模板
│               ├── build_base.py
│               └── apply_action.py
└── docs/
    └── ai-3d-modeling/
        └── ...                   # 本目录文档
```

---

## 进度跟踪

| Phase | 任务 | 状态 | 备注 |
|-------|------|------|------|
| P1 | Blender headless 执行环境 | ⏳ 待开始 | |
| P1 | 骨架模板（3 套） | ⏳ 待开始 | |
| P1 | AI 生成 bpy 脚本 | ⏳ 待开始 | |
| P1 | glTF 导出 + Three.js 预览 | ⏳ 待开始 | |
| P2 | 预设动作库 | ⏳ 待开始 | |
| P2 | 动画面板 | ⏳ 待开始 | |
| P3 | 迭代交互 | ⏳ 待开始 | |
| P4 | 增强与导出 | ⏳ 待开始 | |
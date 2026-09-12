# -*- coding: utf-8 -*-
"""
深圳微缩 3D 城市模型生成器
风格：MUJI 白模 + 地标浅彩（SimCity 玩具感）
坐标系：微缩坐标（单位 = 米 × 0.0005，即 1km → 0.5 单位）
作者：小白 (Claude Code)
"""

import bpy
import math
import sys
import argparse
from mathutils import Vector

# ============================================================
# 参数解析
# ============================================================
def parse_args():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    else:
        argv = []
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="shenzhen_miniature.glb")
    parser.add_argument("--style", default="white", choices=["white", "color"])
    parser.add_argument("--density", type=int, default=120, help="背景肌理方块数")
    args, _ = parser.parse_known_args(argv)
    return args

ARGS = parse_args()

# ============================================================
# 场景清理
# ============================================================
bpy.ops.wm.read_factory_settings(use_empty=True)

# ============================================================
# 材质
# ============================================================
def make_material(name, color, metallic=0.0, roughness=0.7, alpha=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if alpha < 1.0:
        bsdf.inputs["Alpha"].default_value = alpha
        m.blend_method = 'BLEND'
    return m

# 配色（增强对比，让地标跳出来）
MAT_BASE      = make_material("Base",      (0.72, 0.70, 0.66))       # 深一些的底座
MAT_GROUND    = make_material("Ground",    (0.96, 0.95, 0.91))       # 地面
MAT_WATER     = make_material("Water",     (0.28, 0.55, 0.78), metallic=0.2, roughness=0.10)
MAT_WHITE     = make_material("Building",  (0.94, 0.94, 0.92))       # 城市肌理白
MAT_ROAD      = make_material("Road",      (0.55, 0.55, 0.53))       # 道路更深
MAT_PINGAN    = make_material("PingAn",    (0.62, 0.70, 0.82), metallic=0.6, roughness=0.25)
MAT_CIVIC     = make_material("Civic",     (0.85, 0.72, 0.48))       # 市民中心金
MAT_SHUNHING  = make_material("ShunHing",  (0.42, 0.58, 0.75), metallic=0.7, roughness=0.22)
MAT_KK100     = make_material("KK100",     (0.55, 0.65, 0.80), metallic=0.7, roughness=0.25)
MAT_BAMBOO    = make_material("Bamboo",    (0.85, 0.68, 0.42), metallic=0.4, roughness=0.40)
MAT_BRIDGE    = make_material("Bridge",    (0.96, 0.96, 0.95))
MAT_STADIUM   = make_material("Stadium",   (0.60, 0.78, 0.85), metallic=0.3, roughness=0.35)
MAT_WINDOW    = make_material("Window",    (0.30, 0.42, 0.50), metallic=0.7, roughness=0.25)
MAT_GREEN     = make_material("Green",     (0.32, 0.62, 0.32))       # 绿地更鲜
MAT_ACCENT    = make_material("Accent",    (0.92, 0.28, 0.20))       # 点缀红更深

# ============================================================
# 基础工具
# ============================================================
def set_mat(obj, mat):
    obj.data.materials.append(mat)

def cube(name, loc, scale, mat):
    bpy.ops.mesh.primitive_cube_add(location=loc)
    o = bpy.context.active_object
    o.name = name
    o.scale = (scale[0]/2, scale[1]/2, scale[2]/2)
    bpy.ops.object.transform_apply(scale=True)
    set_mat(o, mat)
    return o

def cylinder(name, loc, r, h, mat, vertices=16):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=r, depth=h, location=loc)
    o = bpy.context.active_object
    o.name = name
    set_mat(o, mat)
    return o

def cone(name, loc, r1, r2, h, mat, vertices=16):
    bpy.ops.mesh.primitive_cone_add(vertices=vertices, radius1=r1, radius2=r2,
                                     depth=h, location=loc)
    o = bpy.context.active_object
    o.name = name
    set_mat(o, mat)
    return o

def uv_sphere(name, loc, scale, mat, seg=24, rings=16):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=rings, location=loc)
    o = bpy.context.active_object
    o.name = name
    o.scale = scale
    bpy.ops.object.transform_apply(scale=True)
    set_mat(o, mat)
    return o

# ============================================================
# 底座 + 地形
# ============================================================
def build_base():
    # 主底座 12×12 单位，1.5 高
    base = cube("Base", (0, 0, -0.75), (12, 12, 1.5), MAT_BASE)
    # 地面薄层
    ground = cube("Ground", (0, 0, 0.02), (11.8, 11.8, 0.04), MAT_GROUND)
    return base, ground

def build_water():
    """深圳湾：南侧浅水面，扁平长方形 + 圆角，不穿模"""
    # 用扁平 box，顶部 0.06 略高于地面 0.04，形成"水漫"感
    # 位置：底座 y=-6 边向外延伸，y 跨度 [-8.5, -3.5]
    bpy.ops.mesh.primitive_cube_add(location=(1.0, -5.5, -0.05))
    sea = bpy.context.active_object
    sea.name = "ShenzhenBay"
    sea.scale = (5.0, 2.5, 0.11)  # z 总高 0.22，从 -0.16 到 0.06
    bpy.ops.object.transform_apply(scale=True)
    # 倒圆角
    bevel = sea.modifiers.new("Bevel", 'BEVEL')
    bevel.width = 1.5
    bevel.segments = 5
    bevel.limit_method = 'ANGLE'
    set_mat(sea, MAT_WATER)
    return sea

# ============================================================
# 深南大道（东西向主干道）
# ============================================================
def build_avenue():
    # 沿 y=0.6 东西向，宽度 0.25
    return cube("ShennanAve", (0, 0.6, 0.05), (11.6, 0.25, 0.05), MAT_ROAD)

# ============================================================
# 城市肌理（密集小方块 + 少量绿地）
# ============================================================
import random
def build_city_texture(density=120):
    """随机但受控的低矮城市块"""
    rng = random.Random(20260907)
    objs = []
    # 避开主干道（|y-0.6|>0.4）和南侧水域（y < -1.5 即水里不放）
    for i in range(density):
        x = rng.uniform(-5.5, 5.5)
        y = rng.uniform(-4.2, 5.5)  # 不放入水面范围
        # 排除深南大道
        if abs(y - 0.6) < 0.4:
            continue
        # 排除地标核心区
        landmarks = [(0.0,0.0), (-0.8,-0.2), (1.4,-0.5), (1.6,-0.2),
                     (0.3,-1.8), (0.5,-1.9), (-2.0,0.5)]
        too_close = False
        for lx, ly in landmarks:
            if (x-lx)**2 + (y-ly)**2 < 0.36:
                too_close = True
                break
        if too_close:
            continue
        # 越远离中心越矮
        dist = math.sqrt(x*x + (y-0.5)**2)
        max_h = max(0.15, 0.6 - dist * 0.06)
        h = rng.uniform(0.10, max_h)
        w = rng.uniform(0.10, 0.22)
        d = rng.uniform(0.10, 0.22)
        obj = cube(f"tex_{i:03d}", (x, y, h/2 + 0.04), (w, d, h), MAT_WHITE)
        objs.append(obj)
    # 绿地（北面：莲花山公园）
    cube("LianhuaPark", (-0.5, 2.2, 0.04), (1.6, 1.2, 0.04), MAT_GREEN)
    # 中心公园点缀树
    for i in range(10):
        x = rng.uniform(-1.2, 0.2)
        y = rng.uniform(1.7, 2.7)
        cone(f"tree_{i:02d}", (x, y, 0.10), 0.06, 0.0, 0.12, MAT_GREEN, vertices=8)
    return objs

# ============================================================
# 地标建筑
# ============================================================

def build_pingan(x=0.0, y=0.0):
    """平安金融中心 599m → 微缩高 1.8（全城最高）"""
    h = 1.8
    # 主体：底部方 → 顶部略收分
    body = cone("PingAn_body", (x, y, h/2), 0.20, 0.13, h, MAT_PINGAN, vertices=4)
    body.rotation_euler[2] = math.radians(45)
    # 顶部小尖顶
    spire = cone("PingAn_spire", (x, y, h + 0.10), 0.04, 0.0, 0.20, MAT_PINGAN, vertices=8)
    return [body, spire]

def build_civic_center(x=-0.8, y=-0.2):
    """市民中心：波浪大屋顶"""
    objs = []
    # 底座
    objs.append(cube("Civic_base", (x, y, 0.06), (1.0, 0.32, 0.12), MAT_CIVIC))
    # 波浪屋顶：用 3 个渐高立方体近似
    for i, h in enumerate([0.10, 0.16, 0.10]):
        objs.append(cube(f"Civic_roof_{i}", (x + (i-1)*0.30, y, 0.12 + h/2),
                         (0.32, 0.30, h), MAT_ACCENT))
    return objs

def build_shunhing(x=1.4, y=-0.5):
    """地王大厦 384m → 1.15；双尖顶"""
    h = 1.15
    body = cube("ShunHing_body", (x, y, h/2), (0.18, 0.18, h), MAT_SHUNHING)
    spire1 = cone("ShunHing_spire1", (x-0.05, y, h + 0.07), 0.03, 0.0, 0.14, MAT_SHUNHING, vertices=8)
    spire2 = cone("ShunHing_spire2", (x+0.05, y, h + 0.07), 0.03, 0.0, 0.14, MAT_SHUNHING, vertices=8)
    return [body, spire1, spire2]

def build_kk100(x=1.6, y=-0.2):
    """京基100 441m → 1.32；锥形收分"""
    h = 1.32
    body = cone("KK100_body", (x, y, h/2), 0.16, 0.08, h, MAT_KK100, vertices=12)
    return [body]

def build_bamboo_shoot(x=0.3, y=-1.8):
    """春笋/华润总部 392m → 1.18；春笋造型（收腰）"""
    # 用多段圆锥叠加出春笋曲线
    segs = [
        (0.16, 0.13, 0.20),
        (0.13, 0.10, 0.30),
        (0.10, 0.07, 0.35),
        (0.07, 0.03, 0.25),
        (0.03, 0.00, 0.08),
    ]
    objs = []
    z = 0
    for i, (r1, r2, h) in enumerate(segs):
        seg = cone(f"Bamboo_{i}", (x, y, z + h/2), r1, r2, h, MAT_BAMBOO, vertices=12)
        objs.append(seg)
        z += h
    return objs

def build_shenzhen_bay_bridge(x=-0.5, y=-4.5):
    """深圳湾大桥：斜拉桥，横跨水面"""
    objs = []
    length = 2.6
    # 桥面
    deck = cube("Bridge_deck", (x, y, 0.12), (length, 0.06, 0.03), MAT_BRIDGE)
    objs.append(deck)
    # 两座桥塔
    for i, tx in enumerate([x - length*0.30, x + length*0.30]):
        tower = cube(f"Bridge_tower_{i}", (tx, y, 0.22), (0.03, 0.03, 0.40), MAT_BRIDGE)
        objs.append(tower)
        # 斜拉索（简化为斜锥）
        for side in (-1, 1):
            cable = cone(f"cable_{i}_{side}",
                         (tx + side*0.18, y, 0.32),
                         0.005, 0.005, 0.40, MAT_BRIDGE, vertices=4)
            cable.rotation_euler[1] = side * math.radians(35)
            objs.append(cable)
    return objs

def build_stadium(x=0.5, y=-1.9):
    """深圳湾体育中心：椭圆穹顶（春茧）"""
    body = uv_sphere("Stadium", (x, y, 0.05), (0.35, 0.25, 0.12), MAT_STADIUM, seg=24, rings=12)
    # 顶部小环
    ring = cone("Stadium_ring", (x, y, 0.15), 0.08, 0.05, 0.03, MAT_ACCENT, vertices=16)
    return [body, ring]

def build_window_of_world(x=-2.0, y=0.5):
    """世界之窗埃菲尔塔：四腿锥塔"""
    objs = []
    h = 0.45
    # 四腿
    for dx in (-0.08, 0.08):
        for dy in (-0.08, 0.08):
            leg = cube(f"WoW_leg_{dx}_{dy}",
                       (x + dx, y + dy, h*0.35),
                       (0.025, 0.025, h*0.7), MAT_CIVIC)
            leg.rotation_euler[0] = -dy * 1.2
            leg.rotation_euler[1] = dx * 1.2
            objs.append(leg)
    # 顶部小尖
    top = cone("WoW_top", (x, y, h + 0.05), 0.04, 0.0, 0.10, MAT_CIVIC, vertices=8)
    objs.append(top)
    return objs

# ============================================================
# 灯光 + 相机
# ============================================================
def setup_light_camera():
    # 主光：Sun
    bpy.ops.object.light_add(type='SUN', location=(4, -4, 8))
    sun = bpy.context.active_object
    sun.name = "Sun"
    sun.data.energy = 4.0
    sun.rotation_euler = (math.radians(45), 0, math.radians(30))

    # 环境补光
    bpy.ops.object.light_add(type='AREA', location=(-3, 3, 6))
    area = bpy.context.active_object
    area.name = "Fill"
    area.data.energy = 300
    area.data.size = 5

    # 世界背景
    world = bpy.data.worlds.new("World")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.95, 0.95, 0.97, 1.0)
    bg.inputs[1].default_value = 0.8
    bpy.context.scene.world = world

    # 相机：等距轴测视角（Isometric feel）
    bpy.ops.object.camera_add(location=(10, -10, 10))
    cam = bpy.context.active_object
    cam.name = "Camera"
    cam.rotation_euler = (math.radians(52), 0, math.radians(45))
    bpy.context.scene.camera = cam

# ============================================================
# 主流程
# ============================================================
def main():
    print("=" * 60)
    print("深圳微缩 3D 模型生成器")
    print(f"输出: {ARGS.output}")
    print(f"密度: {ARGS.density}")
    print("=" * 60)

    build_base()
    print("✓ 底座")

    build_water()
    print("✓ 深圳湾")

    build_avenue()
    print("✓ 深南大道")

    build_city_texture(ARGS.density)
    print(f"✓ 城市肌理 ({ARGS.density}块)")

    build_pingan()
    print("✓ 平安金融中心")

    build_civic_center()
    print("✓ 市民中心")

    build_shunhing()
    print("✓ 地王大厦")

    build_kk100()
    print("✓ 京基100")

    build_bamboo_shoot()
    print("✓ 春笋（华润总部）")

    build_shenzhen_bay_bridge()
    print("✓ 深圳湾大桥")

    build_stadium()
    print("✓ 深圳湾体育中心")

    build_window_of_world()
    print("✓ 世界之窗")

    setup_light_camera()
    print("✓ 灯光相机")

    # 导出 GLB
    bpy.ops.export_scene.gltf(
        filepath=ARGS.output,
        export_format='GLB',
        export_apply=True,
        export_yup=True,
        export_cameras=False,
        export_lights=False,
    )

    # 统计
    obj_count = len(bpy.data.objects)
    mesh_count = len(bpy.data.meshes)
    print("=" * 60)
    print(f"✅ 生成完成")
    print(f"   Created {obj_count} objects, {mesh_count} meshes")
    print(f"   输出: {ARGS.output}")

if __name__ == "__main__":
    main()

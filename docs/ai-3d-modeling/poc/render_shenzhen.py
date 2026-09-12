# -*- coding: utf-8 -*-
"""深圳微缩模型 - Blender Cycles 渲染预览"""
import bpy, os, time, math

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(ROOT, 'output')
GLB = os.path.join(OUT_DIR, 'shenzhen_miniature.glb')
OUT = os.path.join(OUT_DIR, 'shenzhen_miniature_render.png')

# 清空场景
bpy.ops.wm.read_factory_settings(use_empty=True)

# 导入 GLB
bpy.ops.import_scene.gltf(filepath=GLB)
print(f'Loaded: {GLB}')

scene = bpy.context.scene
scene.render.engine = 'BLENDER_EEVEE_NEXT'  # 快速预览用 Eevee
scene.render.resolution_x = 1600
scene.render.resolution_y = 1200
scene.render.resolution_percentage = 100

# 世界背景 - 柔和暖灰
world = bpy.data.worlds.new('PreviewWorld')
world.use_nodes = True
bg = world.node_tree.nodes['Background']
bg.inputs['Color'].default_value = (0.90, 0.88, 0.86, 1.0)
bg.inputs['Strength'].default_value = 0.6
scene.world = world

# 主光（更柔，避免过曝）
sun_data = bpy.data.lights.new('Sun', type='SUN')
sun_data.energy = 2.2
sun_data.angle = math.radians(8)
sun = bpy.data.objects.new('Sun', sun_data)
sun.rotation_euler = (math.radians(50), 0, math.radians(35))
scene.collection.objects.link(sun)

# 补光（弱）
fill_data = bpy.data.lights.new('Fill', type='AREA')
fill_data.energy = 180
fill_data.size = 8
fill = bpy.data.objects.new('Fill', fill_data)
fill.location = (-6, 4, 7)
fill.rotation_euler = (math.radians(30), 0, math.radians(-120))
scene.collection.objects.link(fill)

# 相机 - 经典轴测视角
cam_data = bpy.data.cameras.new('Cam')
cam_data.lens = 50
cam_data.type = 'ORTHO'
cam_data.ortho_scale = 15
cam = bpy.data.objects.new('Cam', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
cam.location = (12, -12, 10)
cam.rotation_euler = (math.radians(54), 0, math.radians(45))

scene.render.filepath = OUT
t0 = time.time()
bpy.ops.render.render(write_still=True)
elapsed = time.time() - t0

size_kb = os.path.getsize(OUT) / 1024
print(f'Render: {OUT} ({size_kb:.0f} KB, {elapsed:.1f}s)')

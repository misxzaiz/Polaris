# -*- coding: utf-8 -*-
import bpy, os, time
import struct

# 导入 GLB
bpy.ops.import_scene.gltf(filepath='output/house_white.glb')
print('Model loaded')

# 设置摄像机
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 32

# 环境光
world = bpy.data.worlds['World']
world.use_nodes = True
bg = world.node_tree.nodes['Background']
bg.inputs['Color'].default_value = (0.6, 0.6, 0.65, 1)
bg.inputs['Strength'].default_value = 1.0

# 相机位置
cam = bpy.data.cameras.new('PreviewCam')
cam.lens = 35
cam.clip_end = 100
obj = bpy.data.objects.new('PreviewCam', cam)
scene.collection.objects.link(obj)
bpy.context.view_layer.objects.active = obj
obj.location = (6, -6, 4.5)
obj.rotation_euler = (0.4, 0, -0.3)
print('Camera placed')

# 灯光
ldata = bpy.data.lights.new('Sun', type='SUN')
ldata.energy = 3.5
lo = bpy.data.objects.new('Sun', ldata)
lo.location = (5, 5, 8)
lo.rotation_euler = (0.5, -0.3, -0.8)
scene.collection.objects.link(lo)
print('Light added')

# 渲染路径
out_dir = os.path.abspath('output')
os.makedirs(out_dir, exist_ok=True)
out_file = os.path.join(out_dir, 'house_render.png')

# 使用 Cycles 渲染并获取图像数据
print(f'Rendering to: {out_file}')
start = time.time()

# 设置分辨率
scene.render.resolution_x = 1280
scene.render.resolution_y = 960
scene.render.filepath = out_file

# 渲染
bpy.ops.render.render()

elapsed = time.time() - start
print(f'Render completed in {elapsed:.1f}s')

# 检查文件
if os.path.exists(out_file):
    size = os.path.getsize(out_file) / 1024
    print(f'File size: {size:.0f} KB')
    
    # 检查文件头
    with open(out_file, 'rb') as f:
        header = f.read(16)
        if header[:8] == b'\x89PNG\r\n\x1a\n':
            # PNG 文件
            width = struct.unpack('>I', header[16:20])[0] if len(header) > 20 else 0
            height = struct.unpack('>I', header[20:24])[0] if len(header) > 24 else 0
            print(f'PNG dimensions: {width}x{height}')
        else:
            print(f'File is not a valid PNG (header: {header.hex()})')
else:
    print('File not found!')
    
    # 列出目录
    print('Output directory:')
    for f in os.listdir(out_dir):
        if f.endswith('.png'):
            full_path = os.path.join(out_dir, f)
            size = os.path.getsize(full_path) / 1024
            print(f'  {f}: {size:.0f} KB')

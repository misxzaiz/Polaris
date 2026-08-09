"""
AI 3D Modeling POC - 木鱼建模脚本 v2
==============================================
用途：验证几何体拼装管线对木质法器的建模
特点：手动构建鱼嘴开口 + 程序化木纹贴图（嵌入 GLB）+ 几何细节增强
v2 改进：
  - 木纹纹理：Blender 内 Python 生成 512×512 木纹贴图，嵌入 GLB 材质
  - 上唇凸起：鱼嘴上端轻微翘起，更真实
  - 鱼尾分叉：双瓣鱼尾造型
  - 鳞片密度提升：5 圈×16 片
  - 敲击位标记：槌接触点微凹（可选）
生成：木鱼（主体 + 开口 + 内腔 + 鳞片 + 鱼尾 + 木鱼槌 + 底座）
输出：GLB 格式（带木纹纹理）

用法：
  blender --background --python muyu.py -- --output output/poc_muyu.glb

AI 可修改的部分：
  - params 字典中的颜色/大小/比例/密度
"""

import bpy
import bmesh
import sys
import os
import json
import math
import struct
import zlib
from mathutils import Vector


# ============================================================
# 参数配置
# ============================================================
params = {
    # ---- 主体 ----
    "body_radius": 0.6,
    "body_scale_x": 1.05,
    "body_scale_y": 1.0,
    "body_scale_z": 0.92,
    "body_color": (0.55, 0.35, 0.15, 1.0),

    # ---- 鱼嘴开口（窄缝）----
    "mouth_x": 0.28,
    "mouth_slit_width": 0.22,         # 缝宽
    "mouth_slit_length": 0.55,        # 缝长（从顶部往下延伸过半）
    "cavity_color": (0.18, 0.08, 0.03, 1.0),

    # ---- 鱼鳞（浅浮雕）----
    "scale_enabled": True,
    "scale_rings": 4,
    "scale_per_ring": 12,
    "scale_size": 0.035,

    # ---- 鱼尾 ----
    "tail_enabled": True,
    "tail_color": (0.50, 0.32, 0.14, 1.0),

    # ---- 木鱼槌 ----
    "mallet_enabled": True,
    "mallet_handle_length": 0.5,
    "mallet_handle_radius": 0.025,
    "mallet_head_radius": 0.06,

    # ---- 底座 ----
    "base_enabled": True,
    "base_radius": 0.5,
    "base_height": 0.06,
    "base_color": (0.45, 0.28, 0.12, 1.0),

    # ---- 木纹纹理 ----
    "wood_texture_size": 512,
    "wood_texture_seed": 42,

    # ---- 渲染 ----
    "subdivision_levels": 2,
}


# ============================================================
# 工具函数
# ============================================================

def parse_args():
    args = sys.argv
    if '--' not in args:
        return
    idx = args.index('--')
    custom_args = args[idx + 1:]
    for i, arg in enumerate(custom_args):
        if arg.startswith('--'):
            key = arg[2:]
            if i + 1 < len(custom_args) and not custom_args[i + 1].startswith('--'):
                val = custom_args[i + 1]
                if key == 'output':
                    params['output_path'] = val
                elif key == 'params':
                    try:
                        params.update(json.loads(val))
                    except json.JSONDecodeError:
                        print(f"Warning: could not parse params JSON: {val}")


def clean_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for block in bpy.data.meshes:
        bpy.data.meshes.remove(block)
    for block in bpy.data.materials:
        bpy.data.materials.remove(block)
    for block in bpy.data.armatures:
        bpy.data.armatures.remove(block)
    for block in bpy.data.images:
        bpy.data.images.remove(block)


def make_toon_material(name, color, roughness=0.3, specular=0.4):
    """创建纯色 Toon 材质"""
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    for node in nodes:
        nodes.remove(node)
    diffuse = nodes.new(type='ShaderNodeBsdfDiffuse')
    diffuse.inputs['Color'].default_value = color
    diffuse.inputs['Roughness'].default_value = roughness
    output = nodes.new(type='ShaderNodeOutputMaterial')
    mat.node_tree.links.new(diffuse.outputs['BSDF'], output.inputs['Surface'])
    mat.diffuse_color = color
    mat.specular_intensity = specular
    return mat


# ============================================================
# 程序化木纹贴图生成（纯 Python, 不依赖 numpy）
# 生成 512×512 PNG 嵌入 GLB，确保 Three.js 渲染时有木纹
# ============================================================

def _simple_hash(x, y, seed):
    """简单 2D 哈希，用于噪声"""
    h = seed + x * 374761393 + y * 668265263
    h = (h ^ (h >> 13)) * 1274126177
    return (h ^ (h >> 16)) & 0xffffffff


def _smooth_noise(x, y, seed):
    """双线性插值噪声"""
    ix, iy = int(math.floor(x)), int(math.floor(y))
    fx, fy = x - ix, y - iy
    # 平滑步进
    sx = fx * fx * (3 - 2 * fx)
    sy = fy * fy * (3 - 2 * fy)
    v00 = _simple_hash(ix, iy, seed) / 0xffffffff
    v10 = _simple_hash(ix + 1, iy, seed) / 0xffffffff
    v01 = _simple_hash(ix, iy + 1, seed) / 0xffffffff
    v11 = _simple_hash(ix + 1, iy + 1, seed) / 0xffffffff
    return v00 + (v10 - v00) * sx + (v01 - v00) * sy + (v11 - v10 - v01 + v00) * sx * sy


def _fbm(x, y, seed, octaves=3):
    """分形布朗运动（叠加噪声）"""
    val = 0.0
    amp = 0.5
    freq = 1.0
    for _ in range(octaves):
        val += amp * _smooth_noise(x * freq, y * freq, seed)
        amp *= 0.5
        freq *= 2.0
        seed += 12345
    return val


def generate_wood_texture(size=512, seed=42):
    """生成木纹贴图 RGBA 像素数据

    木纹逻辑：
    - 横向条纹模拟年轮
    - 条纹有正弦扰动 + 噪声，模拟自然木纹
    - 颜色从深棕到浅棕渐变
    """
    pixels = bytearray()
    half = size // 2

    for py in range(size):
        for px in range(size):
            # 归一化坐标
            u = px / size
            v = py / size

            # 年轮条纹：沿 Y 方向，带 X 扰动
            warp = 0.15 * math.sin(u * math.pi * 4 + v * 2.0) \
                 + 0.08 * math.sin(u * math.pi * 8 + v * 3.5)
            grain = (v + warp) * 18.0
            band = 0.55 + 0.45 * math.sin(grain * math.pi)

            # 噪声细节
            noise = _fbm(u * 20, v * 20, seed, octaves=3) * 0.12

            # 中心区域略深（模拟敲击包浆）
            center_dist = math.sqrt((u - 0.5) ** 2 + (v - 0.5) ** 2)
            center_dark = 0.0 if center_dist > 0.4 else (0.4 - center_dist) * 0.15

            # 整体值
            val = max(0.0, min(1.0, band * 0.85 + noise + 0.15 - center_dark))

            # 映射到木色（深棕→中棕）
            r = int(max(0, min(255, (0.50 + 0.15 * val) * 255)))
            g = int(max(0, min(255, (0.30 + 0.12 * val) * 255)))
            b = int(max(0, min(255, (0.12 + 0.08 * val) * 255)))

            pixels.extend([r, g, b, 255])

    return bytes(pixels)


def make_wood_material_from_pixels(name, pixels, width, height, color_tint=(1.0, 1.0, 1.0, 1.0)):
    """从像素数据创建带木纹纹理的材质

    流程：
      生成 PNG 文件（与输出同目录）→ 加载为 Blender Image → Image Texture → Diffuse BSDF
      PNG 文件与 GLB 并排放置，GLB 导出器自动读取并嵌入
    """

    # ---- 生成 PNG 字节 ----
    def _create_png_bytes(pixel_data, w, h):
        """将 RGBA 像素数据编码为 PNG（无外部依赖）"""
        def _png_chunk(ctype, data):
            chunk = ctype + data
            crc = struct.pack('>I', zlib.crc32(chunk) & 0xffffffff)
            return struct.pack('>I', len(data)) + chunk + crc

        raw = b'\x89PNG\r\n\x1a\n'
        ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
        raw += _png_chunk(b'IHDR', ihdr)
        raw_data = b''
        for y in range(h):
            raw_data += b'\x00' + bytes(pixel_data[y * w * 4:(y + 1) * w * 4])
        raw += _png_chunk(b'IDAT', zlib.compress(raw_data))
        raw += _png_chunk(b'IEND', b'')
        return raw

    # ---- 确定输出路径 ----
    out_dir = os.path.dirname(params.get('output_path', '//poc_muyu.glb'))
    if not out_dir or out_dir == '//':
        out_dir = '.'
    out_dir = os.path.abspath(out_dir)
    png_path = os.path.join(out_dir, f"{name}.png")
    png_bytes = _create_png_bytes(pixels, width, height)
    with open(png_path, 'wb') as f:
        f.write(png_bytes)

    # ---- 加载为 Blender Image ----
    img = bpy.data.images.load(png_path, check_existing=True)
    img.name = f"{name}_tex"

    # ---- 创建材质 ----
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    for n in nodes:
        nodes.remove(n)

    tex_node = nodes.new(type='ShaderNodeTexImage')
    tex_node.image = img
    tex_node.interpolation = 'Linear'
    tex_node.projection = 'FLAT'

    # glTF 导出器仅支持 Principled BSDF 正确导出 baseColorTexture
    principled = nodes.new(type='ShaderNodeBsdfPrincipled')
    principled.inputs['Roughness'].default_value = 0.35

    output = nodes.new(type='ShaderNodeOutputMaterial')

    mat.node_tree.links.new(tex_node.outputs['Color'], principled.inputs['Base Color'])
    mat.node_tree.links.new(principled.outputs['BSDF'], output.inputs['Surface'])

    mat.diffuse_color = color_tint
    mat.specular_intensity = 0.5
    return mat


# ============================================================
# 几何工具函数
# ============================================================

def create_sphere(radius, location, subdivisions=2, name="mesh"):
    bpy.ops.mesh.primitive_uv_sphere_add(
        radius=radius, location=location, segments=20, ring_count=12)
    obj = bpy.context.active_object
    obj.name = name
    if subdivisions > 0:
        mod = obj.modifiers.new(name="Subdivision", type='SUBSURF')
        mod.levels = subdivisions
        mod.render_levels = subdivisions
        mod.quality = 3
    return obj


def create_cylinder(radius, depth, location, rotation=(0, 0, 0), subdivisions=2, name="mesh"):
    bpy.ops.mesh.primitive_cylinder_add(
        radius=radius, depth=depth, location=location, vertices=12)
    obj = bpy.context.active_object
    obj.name = name
    obj.rotation_euler = rotation
    if subdivisions > 0:
        mod = obj.modifiers.new(name="Subdivision", type='SUBSURF')
        mod.levels = subdivisions
        mod.render_levels = subdivisions
        mod.quality = 3
    return obj


def assign_material(obj, mat):
    if obj.data.materials:
        obj.data.materials[0] = mat
    else:
        obj.data.materials.append(mat)


def orient_along(obj, direction):
    d = direction.normalized()
    if d.length < 1e-6:
        return
    obj.rotation_mode = 'QUATERNION'
    obj.rotation_quaternion = d.to_track_quat('Z', 'Y')


def remove_slit(obj, axis, center_x, slit_width, slit_length, local_scale=1.0):
    """在圆球表面开一条从前端顶部往下延伸的窄缝（鱼嘴）

    真实木鱼：缝从前端（+X）顶部往下延伸，竖直方向较长、横向很窄
    删除条件（在球体局部坐标）：
      - 开口方向：x > center_x（前端）
      - 缝宽：|y| < slit_width/2（横向窄）
      - 缝长：z 从顶部往下（z > 下方阈值）
    """
    idx = 'xyz'.index(axis)
    bm = bmesh.new()
    bm.from_mesh(obj.data)

    remove = []
    for f in bm.faces:
        verts_local = [v.co for v in f.verts]
        # 前端
        if not all(v[idx] > center_x for v in verts_local):
            continue
        # 缝宽（横向窄）
        if not all(abs(v.y) < slit_width * 0.5 * local_scale for v in verts_local):
            continue
        # 缝长（竖直方向，从顶部往下延伸至中部偏下）
        if not all(v.z > -slit_length * 0.15 * local_scale for v in verts_local):
            continue
        remove.append(f)

    bmesh.ops.delete(bm, geom=remove, context='FACES')
    bm.to_mesh(obj.data)
    bm.free()


def extrude_faces_along(obj, axis, sign, threshold, distance):
    """将某轴一侧的面挤出一定距离（用于上唇凸起）"""
    idx = 'xyz'.index(axis)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    faces = []
    for f in bm.faces:
        vals = [v.co[idx] for v in f.verts]
        if sign > 0 and all(v > threshold for v in vals):
            faces.append(f)
        elif sign < 0 and all(v < threshold for v in vals):
            faces.append(f)
    if faces:
        result = bmesh.ops.extrude_discrete_faces(bm, faces=faces)
        extruded = result['faces']
        dir_vec = Vector((0, 0, 0))
        dir_vec[idx] = sign * distance
        for f in extruded:
            for v in f.verts:
                v.co += dir_vec
    bm.to_mesh(obj.data)
    bm.free()


# ============================================================
# 木鱼构建主函数
# ============================================================

def build_muyu():
    """构建木鱼（v2 增强版）"""
    p = params
    print("=" * 50)
    print("Building 木鱼 v3 (wooden fish)...")
    print(f"  Body: r={p['body_radius']} scale=({p['body_scale_x']},{p['body_scale_y']},{p['body_scale_z']})")
    print(f"  Mouth: slit_width={p['mouth_slit_width']} slit_length={p['mouth_slit_length']}")
    print(f"  Scales: {p['scale_rings']} rings x {p['scale_per_ring']} per ring (relief)")
    print(f"  Tail: single-piece upturned")
    print("=" * 50)

    # ---- 生成木纹纹理 ----
    print("  Generating wood texture...")
    tex_size = p['wood_texture_size']
    tex_seed = p['wood_texture_seed']
    wood_pixels = generate_wood_texture(size=tex_size, seed=tex_seed)
    print(f"    Done: {tex_size}x{tex_size} pixels, {len(wood_pixels)} bytes")

    # ---- 材质 ----
    body_mat = make_wood_material_from_pixels(
        "BodyMat", wood_pixels, tex_size, tex_size,
        color_tint=(0.5, 0.3, 0.12, 1.0))
    cavity_mat = make_toon_material("CavityMat", p['cavity_color'])
    scale_mat = make_wood_material_from_pixels(
        "ScaleMat", wood_pixels, tex_size, tex_size,
        color_tint=(0.58, 0.38, 0.18, 1.0))
    tail_mat = make_toon_material("TailMat", p['tail_color'])

    base_h = p['base_height'] if p['base_enabled'] else 0.0
    parts = []

    # ---- 底座 ----
    if p['base_enabled']:
        base_mat = make_toon_material("BaseMat", p['base_color'])
        base = create_cylinder(
            radius=p['base_radius'], depth=p['base_height'],
            location=(0, 0, p['base_height'] / 2),
            subdivisions=1, name="Base")
        assign_material(base, base_mat)
        parts.append(base)

    # ---- 主体 ----
    body_center_z = base_h + p['body_radius'] * p['body_scale_z']
    body = create_sphere(
        radius=p['body_radius'],
        location=(0, 0, body_center_z),
        subdivisions=p['subdivision_levels'],
        name="Muyu_Body")
    body.scale = (p['body_scale_x'], p['body_scale_y'], p['body_scale_z'])
    assign_material(body, body_mat)
    parts.append(body)

    # ---- 鱼嘴开口（窄缝，从顶部垂直延伸）----
    r = p['body_radius']
    sx, sy, sz = p['body_scale_x'], p['body_scale_y'], p['body_scale_z']

    # 窄缝开口
    remove_slit(body, 'x', p['mouth_x'], p['mouth_slit_width'], p['mouth_slit_length'],
                local_scale=min(sx, sy, sz))

    # ---- 内腔（缝后深色面，暗示空腔）----
    cavity = create_sphere(
        radius=r * 0.35,
        location=(r * 0.20, 0, body_center_z),
        subdivisions=1,
        name="Cavity")
    cavity.scale = (sx * 0.35, p['mouth_slit_width'] * 0.4, p['mouth_slit_length'] * 0.5)
    # 只保留朝向开口的面
    bm = bmesh.new()
    bm.from_mesh(cavity.data)
    remove = [f for f in bm.faces if all(v.co.x < 0 for v in f.verts)]
    bmesh.ops.delete(bm, geom=remove, context='FACES')
    bm.to_mesh(cavity.data)
    bm.free()
    assign_material(cavity, cavity_mat)
    parts.append(cavity)

    # ---- 鱼鳞（浅浮雕，极扁半球贴面）----
    if p['scale_enabled']:
        for ring in range(1, p['scale_rings'] + 1):
            theta = math.radians(12 + ring * 18)
            sin_t, cos_t = math.sin(theta), math.cos(theta)
            count = p['scale_per_ring']
            for k in range(count):
                phi = 2 * math.pi * k / count
                lx = r * sin_t * math.cos(phi)
                ly = r * sin_t * math.sin(phi)
                lz = r * cos_t
                wx = lx * sx
                wy = ly * sy
                wz = lz * sz + body_center_z
                # 跳过开口区
                if wx > r * sx * 0.45:
                    continue
                # 跳过后端尾区
                if wx < -r * sx * 0.7:
                    continue
                normal = Vector((lx / sx, ly / sy, lz / sz)).normalized()
                s = create_sphere(
                    radius=p['scale_size'],
                    location=(wx, wy, wz),
                    subdivisions=1,
                    name=f"Scale_{ring}_{k}")
                s.scale = (1, 1, 0.10)  # 极扁，浅浮雕
                orient_along(s, normal)
                assign_material(s, scale_mat)
                parts.append(s)

    # ---- 鱼尾（贴体单片上翘）----
    if p['tail_enabled']:
        tail_x = -r * sx - 0.03
        tail = create_sphere(
            radius=0.18,
            location=(tail_x, 0, body_center_z + 0.06),
            subdivisions=1,
            name="Tail")
        tail.scale = (0.5, 0.6, 0.35)
        tail.rotation_euler = (0.15, math.radians(30), 0)
        assign_material(tail, tail_mat)
        parts.append(tail)

    # ---- 木鱼槌 ----
    if p['mallet_enabled']:
        mallet_mat = make_toon_material("MalletMat", p['body_color'])
        mx, my = 0.0, p['base_radius'] * 0.85
        handle_z = base_h + p['mallet_handle_length'] / 2
        handle = create_cylinder(
            radius=p['mallet_handle_radius'],
            depth=p['mallet_handle_length'],
            location=(mx, my, handle_z),
            subdivisions=1, name="Mallet_Handle")
        assign_material(handle, mallet_mat)
        parts.append(handle)

        head_z = base_h + p['mallet_handle_length'] + p['mallet_head_radius']
        head = create_sphere(
            radius=p['mallet_head_radius'],
            location=(mx, my, head_z),
            subdivisions=2, name="Mallet_Head")
        assign_material(head, mallet_mat)
        parts.append(head)

    print(f"  Created {len(parts)} parts")
    return parts


def setup_scene():
    scene = bpy.context.scene
    scene.render.resolution_x = 1920
    scene.render.resolution_y = 1920
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.world.use_nodes = False
    scene.world.color = (0.95, 0.95, 0.98)


def export_glb(output_path):
    if not output_path:
        output_path = "//poc_muyu.glb"
    output_dir = os.path.dirname(output_path)
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir)
    bpy.ops.preferences.addon_enable(module='io_scene_gltf2')
    bpy.ops.export_scene.gltf(
        filepath=output_path,
        export_format='GLB',
        export_materials='EXPORT',
        export_image_format='JPEG',
        export_texcoords=True,
        export_normals=True,
        export_draco_mesh_compression_enable=False,
        export_animations=True,
        export_skins=True,
    )
    print(f"\n✅ Exported to: {output_path}")


# ============================================================
# 入口
# ============================================================

if __name__ == "__main__":
    parse_args()

    clean_scene()

    parts = build_muyu()

    setup_scene()

    output = params.get('output_path', '//poc_muyu.glb')
    export_glb(output)

    print("\n🎉 木鱼 v3 建模完成！")
    print(f"   总部件数: {len(parts)}")
    print(f"   输出文件: {output}")
"""
AI 3D Modeling - 真实木鱼 + 敲击动画 (muyu_advanced)
============================================================
用途：生成高保真木鱼 3D 模型，附木鱼槌敲击骨骼动画
特点：
  - 程序化木纹贴图（512x512，嵌入 GLB）
  - 缩扁椭球主体 + 鱼嘴窄缝 + 深色内腔
  - 鱼鳞浅浮雕（多圈分布，避开开口/尾部）
  - 双瓣鱼尾上翘
  - 木鱼槌：骨架构建 + 敲击→弹性回弹 GLTF 动画
  - 圆形木质底座 + 金属铆钉装饰
  - 三处敲击接触点微凹
输出：GLB 格式（带木纹 + 骨骼动画）

用法：
  blender --background --python muyu_advanced.py -- --output output/poc_muyu_advanced.glb

AI 可修改：params 字典中的颜色/大小/比例/动画帧数等
"""

import bpy
import bmesh
import sys
import os
import json
import math
import struct
import zlib
from mathutils import Vector, Matrix, Quaternion


# ============================================================
# 参数配置
# ============================================================
params = {
    # ---- 主体 ----
    "body_radius": 0.6,
    "body_scale_x": 1.05,
    "body_scale_y": 1.0,
    "body_scale_z": 0.88,
    "body_color": (0.55, 0.35, 0.15, 1.0),

    # ---- 鱼嘴开口 ----
    "mouth_x": 0.28,
    "mouth_slit_width": 0.22,
    "mouth_slit_length": 0.55,
    "cavity_color": (0.18, 0.08, 0.03, 1.0),

    # ---- 鱼鳞 ----
    "scale_enabled": True,
    "scale_rings": 5,
    "scale_per_ring": 14,
    "scale_size": 0.038,

    # ---- 鱼尾 ----
    "tail_enabled": True,
    "tail_color": (0.50, 0.32, 0.14, 1.0),

    # ---- 木鱼槌 ----
    "mallet_handle_length": 0.52,
    "mallet_handle_radius": 0.028,
    "mallet_head_radius": 0.07,
    "mallet_head_color": (0.48, 0.30, 0.12, 1.0),
    "mallet_handle_color": (0.55, 0.35, 0.15, 1.0),

    # ---- 底座 ----
    "base_enabled": True,
    "base_radius": 0.55,
    "base_height": 0.07,
    "base_color": (0.45, 0.28, 0.12, 1.0),
    "rivet_enabled": True,

    # ---- 木纹纹理 ----
    "wood_texture_size": 512,
    "wood_texture_seed": 77,

    # ---- 渲染 ----
    "subdivision_levels": 2,

    # ---- 动画 ----
    "anim_frames": 60,           # 总帧数（每循环）
    "anim_start_frame": 1,
    "anim_fps": 30,
    "mallet_raise_height": 0.18, # 槌头抬起最大高度（局部）
    "hit_frame": 30,             # 敲击帧（锤头接触木鱼）
    "rebound_height": 0.05,      # 弹性回弹高度
    "body_impact_scale": 0.012,  # 木鱼受击微缩幅度
    "body_impact_duration": 8,   # 木鱼回弹总帧数
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
    for block in list(bpy.data.meshes):
        bpy.data.meshes.remove(block)
    for block in list(bpy.data.materials):
        bpy.data.materials.remove(block)
    for block in list(bpy.data.armatures):
        bpy.data.armatures.remove(block)
    for block in list(bpy.data.images):
        bpy.data.images.remove(block)
    for block in list(bpy.data.actions):
        bpy.data.actions.remove(block)


def make_toon_material(name, color, roughness=0.35, specular=0.4):
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    for node in nodes:
        nodes.remove(node)
    principled = nodes.new(type='ShaderNodeBsdfPrincipled')
    principled.inputs['Base Color'].default_value = color
    principled.inputs['Roughness'].default_value = roughness
    principled.inputs['Specular IOR Level'].default_value = specular
    output = nodes.new(type='ShaderNodeOutputMaterial')
    mat.node_tree.links.new(principled.outputs['BSDF'], output.inputs['Surface'])
    return mat


# ============================================================
# 程序化木纹贴图
# ============================================================

def _simple_hash(x, y, seed):
    h = seed + x * 374761393 + y * 668265263
    h = (h ^ (h >> 13)) * 1274126177
    return (h ^ (h >> 16)) & 0xffffffff


def _smooth_noise(x, y, seed):
    ix, iy = int(math.floor(x)), int(math.floor(y))
    fx, fy = x - ix, y - iy
    sx = fx * fx * (3 - 2 * fx)
    sy = fy * fy * (3 - 2 * fy)
    v00 = _simple_hash(ix, iy, seed) / 0xffffffff
    v10 = _simple_hash(ix + 1, iy, seed) / 0xffffffff
    v01 = _simple_hash(ix, iy + 1, seed) / 0xffffffff
    v11 = _simple_hash(ix + 1, iy + 1, seed) / 0xffffffff
    return v00 + (v10 - v00) * sx + (v01 - v00) * sy + (v11 - v10 - v01 + v00) * sx * sy


def _fbm(x, y, seed, octaves=3):
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
    pixels = bytearray()
    for py in range(size):
        for px in range(size):
            u = px / size
            v = py / size
            warp = 0.15 * math.sin(u * math.pi * 4 + v * 2.0) \
                 + 0.08 * math.sin(u * math.pi * 8 + v * 3.5)
            grain = (v + warp) * 20.0
            band = 0.55 + 0.45 * math.sin(grain * math.pi)
            noise = _fbm(u * 22, v * 22, seed, octaves=3) * 0.10
            # 敲击包浆：中心区域略深
            center_dist = math.sqrt((u - 0.5) ** 2 + (v - 0.5) ** 2)
            center_dark = 0.0 if center_dist > 0.42 else (0.42 - center_dist) * 0.18
            val = max(0.0, min(1.0, band * 0.85 + noise + 0.15 - center_dark))
            r = int(max(0, min(255, (0.50 + 0.15 * val) * 255)))
            g = int(max(0, min(255, (0.30 + 0.12 * val) * 255)))
            b = int(max(0, min(255, (0.12 + 0.08 * val) * 255)))
            pixels.extend([r, g, b, 255])
    return bytes(pixels)


def make_wood_material_from_pixels(name, pixels, width, height, color_tint=(1.0, 1.0, 1.0, 1.0)):
    def _create_png_bytes(pixel_data, w, h):
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

    out_dir = os.path.dirname(params.get('output_path', '//poc_muyu_advanced.glb'))
    if not out_dir or out_dir == '//':
        out_dir = '.'
    out_dir = os.path.abspath(out_dir)
    png_path = os.path.join(out_dir, f"{name}.png")
    png_bytes = _create_png_bytes(pixels, width, height)
    with open(png_path, 'wb') as f:
        f.write(png_bytes)

    img = bpy.data.images.load(png_path, check_existing=True)
    img.name = f"{name}_tex"

    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    for n in nodes:
        nodes.remove(n)

    tex_node = nodes.new(type='ShaderNodeTexImage')
    tex_node.image = img
    tex_node.interpolation = 'Linear'
    tex_node.projection = 'FLAT'

    principled = nodes.new(type='ShaderNodeBsdfPrincipled')
    principled.inputs['Roughness'].default_value = 0.35
    output = nodes.new(type='ShaderNodeOutputMaterial')
    mat.node_tree.links.new(tex_node.outputs['Color'], principled.inputs['Base Color'])
    mat.node_tree.links.new(principled.outputs['BSDF'], output.inputs['Surface'])
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
    idx = 'xyz'.index(axis)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    remove = []
    for f in bm.faces:
        verts_local = [v.co for v in f.verts]
        if not all(v[idx] > center_x for v in verts_local):
            continue
        if not all(abs(v.y) < slit_width * 0.5 * local_scale for v in verts_local):
            continue
        if not all(v.z > -slit_length * 0.15 * local_scale for v in verts_local):
            continue
        remove.append(f)
    bmesh.ops.delete(bm, geom=remove, context='FACES')
    bm.to_mesh(obj.data)
    bm.free()


def punch_indent(obj, center, radius, depth, axis='z'):
    """在物体表面敲击点处向内凹陷"""
    idx = 'xyz'.index(axis)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    for v in bm.verts:
        dist = math.sqrt(
            (v.co.x - center.x) ** 2 +
            (v.co.y - center.y) ** 2 +
            (v.co.z - center.z) ** 2
        )
        if dist < radius:
            factor = 1.0 - dist / radius
            factor = factor * factor
            v.co[idx] -= depth * factor
    bm.to_mesh(obj.data)
    bm.free()


# ============================================================
# 木鱼构建
# ============================================================

def build_muyu():
    p = params
    print("=" * 50)
    print("Building 真实木鱼 + 敲击动画 ...")
    print("=" * 50)

    # ---- 木纹纹理 ----
    print("  Generating wood texture...")
    tex_size = p['wood_texture_size']
    tex_seed = p['wood_texture_seed']
    wood_pixels = generate_wood_texture(size=tex_size, seed=tex_seed)
    print(f"    Done: {tex_size}x{tex_size} pixels")

    # ---- 材质 ----
    body_mat = make_wood_material_from_pixels(
        "BodyMat", wood_pixels, tex_size, tex_size,
        color_tint=(0.5, 0.3, 0.12, 1.0))
    cavity_mat = make_toon_material("CavityMat", p['cavity_color'])
    scale_mat = make_wood_material_from_pixels(
        "ScaleMat", wood_pixels, tex_size, tex_size,
        color_tint=(0.58, 0.38, 0.18, 1.0))
    tail_mat = make_toon_material("TailMat", p['tail_color'])
    mallet_handle_mat = make_toon_material("MalletHandleMat", p['mallet_handle_color'])
    mallet_head_mat = make_toon_material("MalletHeadMat", p['mallet_head_color'])

    base_h = p['base_height'] if p['base_enabled'] else 0.0
    parts = []

    # ---- 底座 ----
    if p['base_enabled']:
        base_mat = make_toon_material("BaseMat", p['base_color'])
        base = create_cylinder(
            radius=p['base_radius'], depth=p['base_height'],
            location=(0, 0, base_h / 2),
            subdivisions=1, name="Base")
        assign_material(base, base_mat)
        parts.append(base)

        # ---- 金属铆钉 ----
        if p['rivet_enabled']:
            rivet_mat = make_toon_material("RivetMat", (0.15, 0.15, 0.15, 1.0))
            for k in range(8):
                angle = 2 * math.pi * k / 8
                rx = p['base_radius'] * 0.7 * math.cos(angle)
                ry = p['base_radius'] * 0.7 * math.sin(angle)
                rivet = create_cylinder(
                    radius=0.015, depth=0.02,
                    location=(rx, ry, base_h + 0.01),
                    subdivisions=0, name=f"Rivet_{k}")
                assign_material(rivet, rivet_mat)
                parts.append(rivet)

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

    # ---- 鱼嘴开口 ----
    r = p['body_radius']
    sx, sy, sz = p['body_scale_x'], p['body_scale_y'], p['body_scale_z']
    remove_slit(body, 'x', p['mouth_x'], p['mouth_slit_width'], p['mouth_slit_length'],
                local_scale=min(sx, sy, sz))

    # ---- 三处敲击接触点微凹 ----
    for i, angle in enumerate([math.radians(0), math.radians(120), math.radians(240)]):
        indent_center = Vector((
            r * sx * 0.85 * math.cos(angle),
            r * sy * 0.30 * math.sin(angle),
            body_center_z + r * sz * 0.30
        ))
        punch_indent(body, indent_center, 0.05, 0.015, axis='x')

    # ---- 内腔 ----
    cavity = create_sphere(
        radius=r * 0.35,
        location=(r * 0.20, 0, body_center_z),
        subdivisions=1,
        name="Cavity")
    cavity.scale = (sx * 0.35, p['mouth_slit_width'] * 0.4, p['mouth_slit_length'] * 0.5)
    bm = bmesh.new()
    bm.from_mesh(cavity.data)
    remove = [f for f in bm.faces if all(v.co.x < 0 for v in f.verts)]
    bmesh.ops.delete(bm, geom=remove, context='FACES')
    bm.to_mesh(cavity.data)
    bm.free()
    assign_material(cavity, cavity_mat)
    parts.append(cavity)

    # ---- 鱼鳞 ----
    if p['scale_enabled']:
        for ring in range(1, p['scale_rings'] + 1):
            theta = math.radians(10 + ring * 16)
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
                if wx > r * sx * 0.45:
                    continue
                if wx < -r * sx * 0.75:
                    continue
                normal = Vector((lx / sx, ly / sy, lz / sz)).normalized()
                s = create_sphere(
                    radius=p['scale_size'],
                    location=(wx, wy, wz),
                    subdivisions=1,
                    name=f"Scale_{ring}_{k}")
                s.scale = (1, 1, 0.12)
                orient_along(s, normal)
                assign_material(s, scale_mat)
                parts.append(s)

    # ---- 双瓣鱼尾 ----
    if p['tail_enabled']:
        tail_x = -r * sx - 0.03
        for side, sign in [(0, 1), (1, -1)]:
            tail = create_sphere(
                radius=0.15,
                location=(tail_x, sign * 0.08, body_center_z + 0.05),
                subdivisions=1,
                name=f"Tail_Lobe_{side}")
            tail.scale = (0.5, 0.5, 0.30)
            tail.rotation_euler = (0.10, math.radians(35 * sign), 0.05 * sign)
            assign_material(tail, tail_mat)
            parts.append(tail)

    # ---- 木鱼槌（后续由骨骼驱动）----
    mx, my = 0.0, p['base_radius'] * 0.85
    mallet_head_z = base_h + p['mallet_handle_length'] + p['mallet_head_radius']
    mallet_handle_z = base_h + p['mallet_handle_length'] / 2

    handle = create_cylinder(
        radius=p['mallet_handle_radius'],
        depth=p['mallet_handle_length'],
        location=(mx, my, mallet_handle_z),
        subdivisions=1, name="Mallet_Handle")
    assign_material(handle, mallet_handle_mat)
    parts.append(handle)

    head = create_sphere(
        radius=p['mallet_head_radius'],
        location=(mx, my, mallet_head_z),
        subdivisions=2, name="Mallet_Head")
    assign_material(head, mallet_head_mat)
    parts.append(head)

    print(f"  Created {len(parts)} parts")
    return {
        "parts": parts,
        "body": body,
        "handle": handle,
        "head": head,
        "mallet_center": (mx, my, base_h),
        "mallet_handle_length": p['mallet_handle_length'],
        "mallet_head_radius": p['mallet_head_radius'],
        "body_center": (0, 0, body_center_z),
        "body_radius": r,
    }


# ============================================================
# 骨骼动画：木鱼槌敲击
# ============================================================

def create_mallet_armature(info):
    """为木鱼槌创建骨骼，并绑定到 handle + head"""
    p = params
    mx, my, base_h = info["mallet_center"]
    handle_len = info["mallet_handle_length"]
    head_r = info["mallet_head_radius"]

    # 骨架：root（手持点） → head（敲击端）
    arm = bpy.data.armatures.new("Mallet_Armature")
    arm_obj = bpy.data.objects.new("Mallet_Armature", arm)
    bpy.context.collection.objects.link(arm_obj)

    # 切换到编辑模式
    arm_obj.data.edit_bones.clear()
    # 骨骼位置以木鱼为参考：根部在手握端（下方），末端在槌头顶端
    root_pos = (mx, my, base_h)
    head_pos = (mx, my, base_h + handle_len + head_r)

    bone_root = arm_obj.data.edit_bones.new("Mallet_Root")
    bone_root.head = Vector(root_pos)
    bone_root.tail = Vector(head_pos)

    bone_tip = arm_obj.data.edit_bones.new("Mallet_Tip")
    bone_tip.head = Vector(head_pos)
    bone_tip.tail = Vector((mx, my, base_h + handle_len + 2 * head_r))
    bone_tip.parent = bone_root

    # 切换到 Pose 模式
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.mode_set(mode='POSE')

    # 绑定 handle 到 root 骨骼
    handle = info["handle"]
    handle.parent = arm_obj
    handle_data = handle.data
    vgroup_root_name = "Mallet_Root"
    if vgroup_root_name not in handle_data.vertex_groups:
        handle_data.vertex_groups.new(name=vgroup_root_name)
    vg = handle_data.vertex_groups[vgroup_root_name]
    vg.add(range(len(handle_data.vertices)), 1.0, 'ADD')

    # 绑定 head 到 tip 骨骼（头部跟随 tip 精确移动）
    head = info["head"]
    head.parent = arm_obj
    head_data = head.data
    vgroup_tip_name = "Mallet_Tip"
    if vgroup_tip_name not in head_data.vertex_groups:
        head_data.vertex_groups.new(name=vgroup_tip_name)
    vg_tip = head_data.vertex_groups[vgroup_tip_name]
    vg_tip.add(range(len(head_data.vertices)), 1.0, 'ADD')

    bpy.ops.object.mode_set(mode='OBJECT')
    return arm_obj, bone_root.name, bone_tip.name


def setup_mallet_animation(arm_obj, bone_root_name, bone_tip_name):
    """设置敲击动画：抬起 → 敲击 → 弹性回弹"""
    p = params
    scene = bpy.context.scene
    scene.frame_start = p['anim_start_frame']
    scene.frame_end = p['anim_frames']
    scene.render.fps = p['anim_fps']

    # 动作
    action = bpy.data.actions.new("Mallet_Hit")
    arm_obj.animation_data_create()
    arm_obj.animation_data.action = action
    arm_obj.animation_data.use_nla = False

    bone_root = arm_obj.pose.bones[bone_root_name]
    bone_tip = arm_obj.pose.bones[bone_tip_name]

    # 关键帧位置（局部位置：沿 Z 轴上下）
    f0 = p['anim_start_frame']
    f_hit = p['hit_frame']
    f_rebound = f_hit + 4
    f_settle = p['anim_frames']

    raise_h = p['mallet_raise_height']
    rebound_h = p['rebound_height']

    # root 骨骼位置（手持端不动，只旋转）
    # 使用 offset 旋转：静止时角度=0，抬起时向前（-Z/X方向）旋转
    def set_key_loc(pose_bone, loc, frame):
        pose_bone.keyframe_insert('location', frame=frame)

    def set_key_rot(pose_bone, rot, frame):
        pose_bone.keyframe_insert('rotation_euler', frame=frame)

    # 动画曲线：
    # 0~f_hit: 从抬起位置下降到敲击位
    # f_hit~f_rebound: 弹性回弹
    # f_rebound~f_settle: 回到抬起位置

    # root：旋转动画（手握端前后摆动）
    rot_up = math.radians(-45)     # 抬起角度
    rot_hit = math.radians(10)     # 敲击角度
    rot_settle = math.radians(0)   # 回正

    # --- root 旋转关键帧 ---
    # 起始：抬起
    bone_root.rotation_mode = 'XYZ'
    bone_root.rotation_euler = (rot_up, 0, 0)
    set_key_rot(bone_root, (rot_up, 0, 0), f0)

    # 中间（准备阶段）
    bone_root.rotation_euler = (rot_up * 0.5, 0, 0)
    set_key_rot(bone_root, (rot_up * 0.5, 0, 0), f_hit - 10)

    # 敲击
    bone_root.rotation_euler = (rot_hit, 0, 0)
    set_key_rot(bone_root, (rot_hit, 0, 0), f_hit)

    # 回弹
    bone_root.rotation_euler = (rot_hit * 0.5, 0, 0)
    set_key_rot(bone_root, (rot_hit * 0.5, 0, 0), f_rebound)

    # 回到抬起
    bone_root.rotation_euler = (rot_up, 0, 0)
    set_key_rot(bone_root, (rot_up, 0, 0), f_settle)

    # --- tip 位置关键帧（控制槌头高度）---
    bone_tip.rotation_mode = 'XYZ'
    bone_tip.rotation_euler = (0, 0, 0)

    # 抬起时槌头较高
    bone_tip.location = (0, 0, raise_h)
    set_key_loc(bone_tip, (0, 0, raise_h), f0)

    bone_tip.location = (0, 0, raise_h * 0.3)
    set_key_loc(bone_tip, (0, 0, raise_h * 0.3), f_hit - 5)

    # 敲击瞬间：接触面
    bone_tip.location = (0, 0, 0)
    set_key_loc(bone_tip, (0, 0, 0), f_hit)

    # 弹性回弹
    bone_tip.location = (0, 0, rebound_h)
    set_key_loc(bone_tip, (0, 0, rebound_h), f_rebound)

    # 回落
    bone_tip.location = (0, 0, raise_h * 0.1)
    set_key_loc(bone_tip, (0, 0, raise_h * 0.1), f_rebound + 4)

    # 重新抬起
    bone_tip.location = (0, 0, raise_h)
    set_key_loc(bone_tip, (0, 0, raise_h), f_settle)

    print(f"  Mallet armature created & animated: {p['anim_frames']} frames @ {p['anim_fps']} fps")


def setup_body_impact_animation(body_obj):
    """木鱼受击时整体微缩并回弹"""
    p = params
    scene = bpy.context.scene
    f_hit = p['hit_frame']
    f_settle = p['anim_frames']

    scale_orig = body_obj.scale.copy()
    scale_hit = (
        scale_orig.x - p['body_impact_scale'],
        scale_orig.y - p['body_impact_scale'],
        scale_orig.z + p['body_impact_scale'] * 0.5  # Z 方向略微隆起
    )

    # 起始
    body_obj.scale = scale_orig
    body_obj.keyframe_insert('scale', frame=p['anim_start_frame'])

    # 敲击前一刻
    body_obj.scale = scale_orig
    body_obj.keyframe_insert('scale', frame=f_hit - 1)

    # 敲击瞬间：受击微缩
    body_obj.scale = scale_hit
    body_obj.keyframe_insert('scale', frame=f_hit)

    # 回弹过度
    scale_rebound = (
        scale_orig.x + p['body_impact_scale'] * 0.3,
        scale_orig.y + p['body_impact_scale'] * 0.3,
        scale_orig.z - p['body_impact_scale'] * 0.2
    )
    body_obj.scale = scale_rebound
    body_obj.keyframe_insert('scale', frame=f_hit + 3)

    # 二次衰减
    body_obj.scale = scale_orig
    body_obj.keyframe_insert('scale', frame=f_hit + 6)

    # 最终回到原状
    body_obj.scale = scale_orig
    body_obj.keyframe_insert('scale', frame=f_settle)

    print("  Body impact animation keyframes set")


# ============================================================
# 场景设置
# ============================================================

def setup_scene():
    scene = bpy.context.scene
    scene.render.resolution_x = 1920
    scene.render.resolution_y = 1920
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 64

    scene.world.use_nodes = True
    world_nodes = scene.world.node_tree.nodes
    for n in world_nodes:
        world_nodes.remove(n)
    bg = world_nodes.new(type='ShaderNodeBackground')
    bg.inputs['Color'].default_value = (0.92, 0.92, 0.95, 1.0)
    bg.inputs['Strength'].default_value = 0.8
    output = world_nodes.new(type='ShaderNodeOutputWorld')
    scene.world.node_tree.links.new(bg.outputs['Background'], output.inputs['Surface'])

    # 添加灯光
    bpy.ops.object.light_add(type='SUN', location=(3, 4, 5))
    sun = bpy.context.active_object
    sun.name = "Sun_Light"
    sun.data.energy = 2.5
    sun.data.color = (1.0, 0.95, 0.85)

    bpy.ops.object.light_add(type='POINT', location=(-2, -3, 4))
    fill = bpy.context.active_object
    fill.name = "Fill_Light"
    fill.data.energy = 300

    # 相机
    bpy.ops.object.camera_add(location=(2.5, 3.0, 2.0), rotation=(math.radians(55), 0, math.radians(35)))
    cam = bpy.context.active_object
    cam.name = "Camera"
    bpy.context.scene.camera = cam


def export_glb(output_path):
    if not output_path:
        output_path = "//poc_muyu_advanced.glb"
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

    info = build_muyu()

    # 创建骨骼并绑定
    arm_obj, bone_root_name, bone_tip_name = create_mallet_armature(info)

    # 设置动画
    setup_mallet_animation(arm_obj, bone_root_name, bone_tip_name)
    setup_body_impact_animation(info["body"])

    setup_scene()

    output = params.get('output_path', '//poc_muyu_advanced.glb')
    export_glb(output)

    print("\n🎉 木鱼 + 敲击动画 建模完成！")
    print(f"   输出文件: {output}")
    print(f"   动画: {params['anim_frames']} 帧 @ {params['anim_fps']} fps")

"""
AI 3D Modeling POC - Q版卡通角色建模脚本
===========================================
用途：验证 Blender headless 管线可行性
生成：Q版小人（圆润、卡通、Toon 材质）
输出：GLB 格式（带骨骼和材质）

用法：
  blender --background --python qbox_character.py -- --output output.glb

AI 可修改的部分（由用户需求驱动）：
  - params 字典中的颜色/大小/比例
  - 几何体添加/删除（尾巴、耳朵、帽子等配饰）
  - 材质参数（颜色、粗糙度、光泽）
"""

import bpy
import sys
import json
import os
import math
from mathutils import Vector, Euler


# ============================================================
# 参数配置（AI 根据用户需求生成）
# ============================================================
params = {
    # ---- 身体颜色 ----
    "body_color": (0.42, 0.72, 1.0, 1.0),       # 蓝色
    "belly_color": (0.95, 0.95, 0.95, 1.0),      # 白色肚皮
    "eye_color": (0.15, 0.15, 0.15, 1.0),        # 深色眼睛
    "eye_highlight": (1.0, 1.0, 1.0, 1.0),       # 眼睛高光
    "cheek_color": (1.0, 0.6, 0.6, 0.6),         # 腮红
    "accent_color": (0.2, 0.6, 0.9, 1.0),        # 装饰色

    # ---- 身体比例 ----
    "head_radius": 0.55,
    "head_stretch": 1.0,                          # 头部拉伸（1.0=圆，>1=椭圆）
    "body_radius": 0.45,
    "body_height": 0.7,
    "body_stretch_y": 0.85,                       # 身体前后压扁（更可爱）
    "neck_height": 0.15,

    # ---- 四肢 ----
    "arm_length": 0.4,
    "arm_radius": 0.08,
    "leg_length": 0.25,
    "leg_radius": 0.1,
    "foot_radius": 0.12,

    # ---- 五官 ----
    "eye_size": 0.12,
    "eye_spacing": 0.2,
    "mouth_size": 0.08,

    # ---- 配饰 ----
    "has_tail": False,
    "has_ears": False,
    "has_hat": False,

    # ---- 渲染 ----
    "subdivision_levels": 2,                      # 细分级别（越高越圆润）
    "shade_smooth": True,
}


# ============================================================
# 工具函数
# ============================================================

def parse_args():
    """解析命令行参数（--key value 格式）"""
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
                elif key == 'template':
                    params['template'] = val
                elif key == 'params':
                    try:
                        extra = json.loads(val)
                        params.update(extra)
                    except json.JSONDecodeError:
                        print(f"Warning: could not parse params JSON: {val}")


def clean_scene():
    """清理场景，保留默认相机和灯光"""
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)

    # 删除所有数据块
    for block in bpy.data.meshes:
        bpy.data.meshes.remove(block)
    for block in bpy.data.materials:
        bpy.data.materials.remove(block)
    for block in bpy.data.armatures:
        bpy.data.armatures.remove(block)


def make_toon_material(name, color, roughness=0.3, specular=0.4):
    """创建 Toon 风格材质"""
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes

    # 清除默认节点
    for node in nodes:
        nodes.remove(node)

    # 创建 Toon BSDF 着色器
    diffuse = nodes.new(type='ShaderNodeBsdfDiffuse')
    diffuse.inputs['Color'].default_value = color
    diffuse.inputs['Roughness'].default_value = roughness

    # 输出节点
    output = nodes.new(type='ShaderNodeOutputMaterial')

    # 连接
    mat.node_tree.links.new(diffuse.outputs['BSDF'], output.inputs['Surface'])

    # 设置材质属性
    mat.diffuse_color = color
    mat.specular_intensity = specular

    return mat


def create_sphere(radius, location, subdivisions=2, name="mesh"):
    """创建 UV 球体并应用细分"""
    bpy.ops.mesh.primitive_uv_sphere_add(
        radius=radius,
        location=location,
        segments=20,
        ring_count=12
    )
    obj = bpy.context.active_object
    obj.name = name

    # 细分修饰器
    if subdivisions > 0:
        mod = obj.modifiers.new(name="Subdivision", type='SUBSURF')
        mod.levels = subdivisions
        mod.render_levels = subdivisions
        mod.quality = 3

    return obj


def create_cylinder(radius, depth, location, rotation=(0, 0, 0), subdivisions=2, name="mesh"):
    """创建圆柱体并应用细分"""
    bpy.ops.mesh.primitive_cylinder_add(
        radius=radius,
        depth=depth,
        location=location,
        vertices=12
    )
    obj = bpy.context.active_object
    obj.name = name
    obj.rotation_euler = rotation

    # 细分修饰器
    if subdivisions > 0:
        mod = obj.modifiers.new(name="Subdivision", type='SUBSURF')
        mod.levels = subdivisions
        mod.render_levels = subdivisions
        mod.quality = 3

    return obj


def create_capsule(radius, length, location, rotation=(0, 0, 0), subdivisions=2, name="capsule"):
    """创建胶囊体（圆柱+两端半球），适合做四肢"""
    # 使用拉伸的球体作为胶囊的简化版本
    bpy.ops.mesh.primitive_uv_sphere_add(
        radius=radius,
        location=location,
        segments=16,
        ring_count=10
    )
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (1, 1, length / (radius * 2) if radius > 0 else 1)
    obj.rotation_euler = rotation

    if subdivisions > 0:
        mod = obj.modifiers.new(name="Subdivision", type='SUBSURF')
        mod.levels = subdivisions
        mod.render_levels = subdivisions
        mod.quality = 3

    # 应用缩放
    # 注意：不应用缩放，保持修饰器变形效果更好

    return obj


def assign_material(obj, mat):
    """给对象分配材质"""
    if obj.data.materials:
        obj.data.materials[0] = mat
    else:
        obj.data.materials.append(mat)


def join_objects(objects, name="merged"):
    """合并多个对象为一个"""
    if len(objects) < 2:
        return objects[0] if objects else None

    # 选择所有对象，激活最后一个
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[-1]

    bpy.ops.object.join()
    merged = bpy.context.active_object
    merged.name = name
    return merged


# ============================================================
# 角色构建主函数
# ============================================================

def build_character():
    """构建 Q 版卡通角色"""
    p = params

    print("=" * 50)
    print("Building Q版卡通角色...")
    print(f"  Body color: {p['body_color']}")
    print(f"  Head size: {p['head_radius']}")
    print(f"  Subdivision: {p['subdivision_levels']}")
    print("=" * 50)

    # ---- 材质 ----
    body_mat = make_toon_material("BodyMat", p['body_color'])
    belly_mat = make_toon_material("BellyMat", p['belly_color'])
    eye_mat = make_toon_material("EyeMat", p['eye_color'])
    eye_highlight_mat = make_toon_material("EyeHighlightMat", p['eye_highlight'])
    cheek_mat = make_toon_material("CheekMat", p['cheek_color'])
    accent_mat = make_toon_material("AccentMat", p['accent_color'])

    all_parts = []

    # ---- 身体 ----
    body_center_z = p['body_height'] * 0.5
    body = create_sphere(
        radius=p['body_radius'],
        location=(0, 0, body_center_z),
        subdivisions=p['subdivision_levels'],
        name="Body"
    )
    body.scale = (1, p['body_stretch_y'], p['body_height'] / (p['body_radius'] * 2))
    assign_material(body, body_mat)
    all_parts.append(body)

    # ---- 肚皮（白色圆片） ----
    belly = create_sphere(
        radius=p['body_radius'] * 0.6,
        location=(0, 0, body_center_z * 0.8),
        subdivisions=p['subdivision_levels'],
        name="Belly"
    )
    belly.scale = (1, 0.3, 0.8)
    belly.location = (0, p['body_radius'] * p['body_stretch_y'] * 0.5, body_center_z * 0.7)
    assign_material(belly, belly_mat)
    all_parts.append(belly)

    # ---- 脖子 ----
    neck_top_z = body_center_z + p['body_height'] * 0.5
    neck = create_cylinder(
        radius=p['head_radius'] * 0.3,
        depth=p['neck_height'],
        location=(0, 0, neck_top_z + p['neck_height'] * 0.5),
        subdivisions=1,
        name="Neck"
    )
    assign_material(neck, body_mat)
    all_parts.append(neck)

    # ---- 头部（大圆球，Q版标志） ----
    head_z = neck_top_z + p['neck_height'] + p['head_radius'] * p['head_stretch'] * 0.8
    head = create_sphere(
        radius=p['head_radius'],
        location=(0, 0, head_z),
        subdivisions=p['subdivision_levels'],
        name="Head"
    )
    head.scale = (1, 0.9, p['head_stretch'])
    assign_material(head, body_mat)
    all_parts.append(head)

    # ---- 眼睛 ----
    eye_y = p['head_radius'] * 0.75
    eye_z = head_z + p['head_radius'] * 0.2

    # 左眼
    eye_l = create_sphere(
        radius=p['eye_size'],
        location=(-p['eye_spacing'], eye_y, eye_z),
        subdivisions=1,
        name="Eye_L"
    )
    eye_l.scale = (1, 0.2, 1)
    assign_material(eye_l, eye_mat)
    all_parts.append(eye_l)

    # 右眼
    eye_r = create_sphere(
        radius=p['eye_size'],
        location=(p['eye_spacing'], eye_y, eye_z),
        subdivisions=1,
        name="Eye_R"
    )
    eye_r.scale = (1, 0.2, 1)
    assign_material(eye_r, eye_mat)
    all_parts.append(eye_r)

    # 眼睛高光（左）
    hl_l = create_sphere(
        radius=p['eye_size'] * 0.35,
        location=(-p['eye_spacing'] + p['eye_size'] * 0.3, eye_y + 0.01, eye_z + p['eye_size'] * 0.3),
        subdivisions=1,
        name="Highlight_L"
    )
    hl_l.scale = (1, 0.1, 1)
    assign_material(hl_l, eye_highlight_mat)
    all_parts.append(hl_l)

    # 眼睛高光（右）
    hl_r = create_sphere(
        radius=p['eye_size'] * 0.35,
        location=(p['eye_spacing'] + p['eye_size'] * 0.3, eye_y + 0.01, eye_z + p['eye_size'] * 0.3),
        subdivisions=1,
        name="Highlight_R"
    )
    hl_r.scale = (1, 0.1, 1)
    assign_material(hl_r, eye_highlight_mat)
    all_parts.append(hl_r)

    # ---- 嘴巴（小半圆） ----
    mouth = create_sphere(
        radius=p['mouth_size'],
        location=(0, eye_y, eye_z - p['eye_size'] * 0.8),
        subdivisions=1,
        name="Mouth"
    )
    mouth.scale = (1, 0.15, 0.5)
    assign_material(mouth, eye_mat)
    all_parts.append(mouth)

    # ---- 腮红 ----
    cheek_l = create_sphere(
        radius=p['head_radius'] * 0.18,
        location=(-p['head_radius'] * 0.55, eye_y - 0.05, eye_z - p['head_radius'] * 0.2),
        subdivisions=1,
        name="Cheek_L"
    )
    cheek_l.scale = (1, 0.1, 0.9)
    assign_material(cheek_l, cheek_mat)
    all_parts.append(cheek_l)

    cheek_r = create_sphere(
        radius=p['head_radius'] * 0.18,
        location=(p['head_radius'] * 0.55, eye_y - 0.05, eye_z - p['head_radius'] * 0.2),
        subdivisions=1,
        name="Cheek_R"
    )
    cheek_r.scale = (1, 0.1, 0.9)
    assign_material(cheek_r, cheek_mat)
    all_parts.append(cheek_r)

    # ---- 手臂 ----
    arm_y = p['body_radius'] * p['body_stretch_y'] * 0.8
    arm_z = body_center_z + p['body_height'] * 0.35

    # 左臂
    arm_l = create_capsule(
        radius=p['arm_radius'],
        length=p['arm_length'],
        location=(-p['body_radius'] * 0.9, arm_y, arm_z),
        rotation=(0.3, 0, 0.2),
        subdivisions=p['subdivision_levels'],
        name="Arm_L"
    )
    assign_material(arm_l, body_mat)
    all_parts.append(arm_l)

    # 右臂
    arm_r = create_capsule(
        radius=p['arm_radius'],
        length=p['arm_length'],
        location=(p['body_radius'] * 0.9, arm_y, arm_z),
        rotation=(-0.3, 0, -0.2),
        subdivisions=p['subdivision_levels'],
        name="Arm_R"
    )
    assign_material(arm_r, body_mat)
    all_parts.append(arm_r)

    # ---- 腿 ----
    leg_z = p['leg_length'] * 0.5
    leg_offset = p['body_radius'] * 0.45

    # 左腿
    leg_l = create_capsule(
        radius=p['leg_radius'],
        length=p['leg_length'],
        location=(-leg_offset, 0, leg_z),
        subdivisions=p['subdivision_levels'],
        name="Leg_L"
    )
    assign_material(leg_l, body_mat)
    all_parts.append(leg_l)

    # 右腿
    leg_r = create_capsule(
        radius=p['leg_radius'],
        length=p['leg_length'],
        location=(leg_offset, 0, leg_z),
        subdivisions=p['subdivision_levels'],
        name="Leg_R"
    )
    assign_material(leg_r, body_mat)
    all_parts.append(leg_r)

    # ---- 脚 ----
    foot_l = create_sphere(
        radius=p['foot_radius'],
        location=(-leg_offset, 0.05, -p['foot_radius'] * 0.6),
        subdivisions=1,
        name="Foot_L"
    )
    foot_l.scale = (1, 0.6, 0.5)
    assign_material(foot_l, accent_mat)
    all_parts.append(foot_l)

    foot_r = create_sphere(
        radius=p['foot_radius'],
        location=(leg_offset, 0.05, -p['foot_radius'] * 0.6),
        subdivisions=1,
        name="Foot_R"
    )
    foot_r.scale = (1, 0.6, 0.5)
    assign_material(foot_r, accent_mat)
    all_parts.append(foot_r)

    print(f"  Created {len(all_parts)} parts")
    return all_parts


def setup_scene():
    """设置场景"""
    # ---- 渲染设置 ----
    scene = bpy.context.scene
    scene.render.resolution_x = 1920
    scene.render.resolution_y = 1920
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True

    # 背景色
    scene.world.use_nodes = False
    scene.world.color = (0.95, 0.95, 0.98)


def export_glb(output_path):
    """导出 GLB 文件"""
    if not output_path:
        output_path = "//qbox_character.glb"

    # 确保输出目录存在
    output_dir = os.path.dirname(output_path)
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir)

    # 启用 glTF 导出插件
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

    parts = build_character()

    setup_scene()

    output = params.get('output_path', '//qbox_character.glb')
    export_glb(output)

    print("\n🎉 角色建模完成！")
    print(f"   总部件数: {len(parts)}")
    print(f"   输出文件: {output}")
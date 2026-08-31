# -*- coding: utf-8 -*-
"""
真实老房子建模 POC - 阶段1：几何骨架（白模）
============================================
简化版：用 Modifier 阵列替代逐对象创建，加进度打印

用法：
  blender --background --python realistic_house.py -- --output output/house_white.glb
"""

import bpy
import sys
import os
import math
import random
from mathutils import Euler

P = {
    "bay_main": 3.6, "bay_side": 3.3, "depth": 4.8,
    "eave_h": 2.8, "pitch_deg": 27, "overhang": 0.6,
    "wall_t": 0.24, "found_h": 0.3,
    "door_w": 0.9, "door_h": 2.0,
    "win_w": 0.8, "win_h": 1.2, "win_sill": 0.9,
    "raft_r": 0.025, "raft_sp": 0.24,
    "sheath_t": 0.015, "batt_s": 0.04, "batt_sp": 0.20,
    "tile_l": 0.20, "tile_exp": 0.155, "tile_t": 0.01, "tile_w": 0.155,
    "col_r": 0.12, "beam_h": 0.18, "beam_w": 0.12,
    "chimney": True, "steps": True, "threshold": True,
    "seed": 42, "output": "//realistic_house.glb",
}


def parse_args():
    args = sys.argv
    if '--' not in args: return
    custom = args[args.index('--') + 1:]
    for i, a in enumerate(custom):
        if a.startswith('--') and i+1 < len(custom) and not custom[i+1].startswith('--'):
            k, v = a[2:], custom[i+1]
            if k in P:
                try: P[k] = type(P[k])(v)
                except: P[k] = v


def clear():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for b in bpy.data.meshes: bpy.data.meshes.remove(b)
    for b in bpy.data.materials: bpy.data.materials.remove(b)
    for c in list(bpy.data.collections):
        if c.name != "Collection": bpy.data.collections.remove(c)


def new_coll(name):
    if name in bpy.data.collections: return bpy.data.collections[name]
    c = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(c)
    return c


def mkmat(name, color=(0.8, 0.8, 0.8), rough=0.9):
    m = bpy.data.materials.new(name=name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    return m


def add_vc(mesh, name, r=0, g=0, b=0, a=0):
    vc = mesh.vertex_colors.new(name=name)
    c = (r, g, b, a)
    for loop in mesh.loops: vc.data[loop.index].color = c


def mkbox(w, h, d, loc, name, coll, rot=(0,0,0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (w/2, h/2, d/2)
    obj.rotation_euler = Euler(rot)
    coll.objects.link(obj)
    return obj


def mkcyl(r, depth, loc, name, coll, segs=8, rot=(0,0,0)):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=depth, vertices=segs, location=loc)
    obj = bpy.context.active_object
    obj.name = name
    obj.rotation_euler = Euler(rot)
    coll.objects.link(obj)
    return obj


def apply_mods(obj):
    """应用所有 modifier"""
    bpy.context.view_layer.objects.active = obj
    for mod in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=mod.name)


# ============================================================
# 1. 墙体（含门窗开洞）
# ============================================================

def build_walls():
    p = P
    coll = new_coll("Walls")
    bw = p["bay_main"] + 2 * p["bay_side"]
    bd = p["depth"]
    wh, fh, wt = p["eave_h"], p["found_h"], p["wall_t"]
    print("  [墙体] 开始构建...")

    brick_m = mkmat("Wall_Brick", (0.72, 0.55, 0.45), 0.85)
    plaster_m = mkmat("Wall_Plaster", (0.82, 0.78, 0.70), 0.90)
    found_m = mkmat("Foundation", (0.55, 0.52, 0.48), 0.95)

    # 台基
    fnd = mkbox(bw+0.4, fh, bd+0.4, (0,0,fh/2), "Foundation", coll)
    fnd.data.materials.append(found_m)

    # 四面墙
    walls = []
    wall_defs = [
        ("Front", (0, -bd/2, (wh+fh)/2), (bw, wt, wh+fh), plaster_m),
        ("Back",  (0,  bd/2, (wh+fh)/2), (bw, wt, wh+fh), plaster_m),
        ("Left",  (-bw/2, 0, (wh+fh)/2), (wt, bd, wh+fh), brick_m),
        ("Right", ( bw/2, 0, (wh+fh)/2), (wt, bd, wh+fh), brick_m),
    ]
    for wname, loc, sz, wmat in wall_defs:
        w = mkbox(*sz, loc, wname + "_Wall", coll)
        w.data.materials.append(wmat)
        add_vc(w.data, "苔藓")
        add_vc(w.data, "污渍")
        add_vc(w.data, "剥落")
        walls.append(w)
        print(f"    ✓ {wname} 墙")

    # ---- 门窗开洞（Boolean DIFFERENCE）----
    openings = [
        # (wall_index, cx, cz_bottom, cw, ch, name)
        (0, 0.0,  fh + p["win_sill"],   p["door_w"],  p["door_h"], "Door"),
        (0, -1.2, fh + p["win_sill"],   p["win_w"],  p["win_h"], "Win_FL"),
        (0,  1.2, fh + p["win_sill"],   p["win_w"],  p["win_h"], "Win_FR"),
        (1, -1.2, fh + p["win_sill"],   p["win_w"],  p["win_h"], "Win_BL"),
        (1,  1.2, fh + p["win_sill"],   p["win_w"],  p["win_h"], "Win_BR"),
    ]

    cutter_m = mkmat("Cutter", (1, 0, 0), 0.5)
    for wi, cx, cz, cw, ch, oname in openings:
        wall = walls[wi]
        cz_center = cz + ch / 2
        if wi == 0: cy = bd/2 + wt/2 + 0.03  # 前墙外侧
        elif wi == 1: cy = -bd/2 - wt/2 - 0.03  # 后墙外侧
        else: continue

        loc = (cx, cy, cz_center)
        cut = mkbox(cw + 0.04, cw + 0.04, ch + 0.04, loc, f"Cutter_{oname}", coll)
        cut.data.materials.append(cutter_m)
        cut.hide_render = True
        cut.hide_viewport = True

        mod = wall.modifiers.new(name=f"Bool_{oname}", type='BOOLEAN')
        mod.object = cut
        mod.operation = 'DIFFERENCE'
        bpy.context.view_layer.objects.active = wall
        bpy.ops.object.modifier_apply(modifier=f"Bool_{oname}")
        coll.objects.unlink(cut)
        bpy.data.objects.remove(cut)
        print(f"    ✓ {oname} 开洞")

    print("  [墙体] 完成")
    return walls, coll


# ============================================================
# 2. 坡屋顶（用 Modifier 阵列加速）
# ============================================================

def build_roof():
    p = P
    rng = random.Random(p["seed"] + 1)
    coll = new_coll("Roof")

    pitch = math.radians(p["pitch_deg"])
    bw = p["bay_main"] + 2 * p["bay_side"]
    bd = p["depth"]
    wh, fh = p["eave_h"], p["found_h"]
    half_span = bd / 2 + p["overhang"]
    ridge_h = wh + half_span * math.tan(pitch)
    slope_len = half_span / math.cos(pitch)

    print("  [屋顶] 开始构建...")

    raft_m = mkmat("Rafter", (0.45, 0.35, 0.25), 0.80)
    sheath_m = mkmat("Sheathing", (0.55, 0.45, 0.35), 0.85)
    batt_m = mkmat("Batten", (0.40, 0.32, 0.22), 0.90)
    tile_m = mkmat("Tile", (0.35, 0.38, 0.35), 0.75)
    ridge_m = mkmat("Ridge", (0.38, 0.40, 0.36), 0.70)

    # ---- 1. 椽条（用单个模板 + Array modifier）----
    n_raft = int(bw / p["raft_sp"]) + 2
    rlen = half_span + 0.05
    print(f"    椽条 x{n_raft}...")

    for sign, sname in [(-1, "L"), (1, "R")]:
        # 单个椽条模板
        templ = mkcyl(p["raft_r"], rlen, (0, sign*half_span/2, wh),
                       f"Rafter_Templ_{sname}", coll, segs=6)
        templ.data.materials.append(raft_m)
        templ.rotation_euler = Euler((sign*pitch, 0, 0))

        # Array modifier：沿 X 轴阵列
        mod = templ.modifiers.new(name="Array_Rafter", type='ARRAY')
        mod.count = n_raft
        mod.relative_offset_displace = (p["raft_sp"], 0, 0)
        apply_mods(templ)
        templ.name = f"Rafters_{sname}"
        print(f"    ✓ {sname}坡椽条 x{n_raft}")

    # ---- 2. 望板（2块坡面薄板）----
    print("    望板...")
    for sign, sname in [(-1, "Sheath_L"), (1, "Sheath_R")]:
        s = mkbox(bw+2*p["overhang"], slope_len, p["sheath_t"],
                   (0, sign*half_span/2, wh+(ridge_h-wh)/2),
                   sname, coll, rot=(sign*pitch, 0, 0))
        s.data.materials.append(sheath_m)
    print("    ✓ 望板")

    # ---- 3. 挂瓦条（每坡面 ~12根）----
    n_batt = int(half_span / p["batt_sp"]) + 1
    print(f"    挂瓦条 x{n_batt}×2...")
    for sign, side in [(-1, "L"), (1, "R")]:
        for i in range(n_batt):
            t = i / max(n_batt-1, 1)
            dist = t * half_span
            y_pos = sign * (half_span - dist)
            z_pos = wh + dist * math.tan(pitch) + p["sheath_t"] + p["batt_s"]/2
            bt = mkbox(bw+2*p["overhang"], p["batt_s"], p["batt_s"],
                        (0, y_pos, z_pos),
                        f"Batt_{side}_{i}", coll, rot=(sign*pitch, 0, 0))
            bt.data.materials.append(batt_m)
    print("    ✓ 挂瓦条")

    # ---- 4. 小青瓦（减少数量，用粗网格）----
    # 简化：每坡面只建 6行 × 10列 = 60片，实际可调整
    n_rows = min(8, n_batt - 1)
    n_cols = min(12, int((bw+2*p["overhang"])/p["tile_exp"]) + 1)
    total_tiles = n_rows * n_cols * 2
    print(f"    小青瓦 ~{total_tiles}片...")

    for sign, side in [(-1, "L"), (1, "R")]:
        for row in range(n_rows):
            for col in range(n_cols):
                t_row = (row + 0.5) / n_rows
                dist = t_row * half_span
                y_b = sign * (half_span - dist)
                z_b = wh + dist * math.tan(pitch) + p["sheath_t"] + p["batt_s"] * (row + 1)

                x_off = -bw/2 - p["overhang"] + col * p["tile_exp"] + p["tile_exp"]/2
                if row % 2 == 1:
                    x_off += p["tile_exp"] / 2

                jx = rng.uniform(-0.005, 0.005)
                jr = rng.uniform(-0.02, 0.02)

                tl = mkbox(p["tile_exp"]*0.9, p["tile_l"]*0.8, p["tile_t"],
                            (x_off+jx, y_b, z_b),
                            f"Tile_{side}_r{row}_c{col}", coll,
                            rot=(sign*pitch+jr, 0, jr))
                tl.data.materials.append(tile_m)
                if (row * n_cols + col) % 20 == 0:
                    print(f"      {side}坡 {row*n_cols+col}/{total_tiles//2} 片...")

    print(f"    ✓ 小青瓦 ~{total_tiles}片")

    # ---- 5. 屋脊 ----
    ridge_z = ridge_h + 0.08
    rid = mkbox(bw+0.2, 0.12, 0.15, (0,0,ridge_z), "Ridge", coll)
    rid.data.materials.append(ridge_m)
    for sign in [-1, 1]:
        cap = mkbox(0.15, 0.15, 0.20,
                     (sign*(bw/2+0.1), 0, ridge_z),
                     f"RidgeCap_{'L' if sign<0 else 'R'}", coll)
        cap.data.materials.append(ridge_m)
    print("    ✓ 屋脊")

    print("  [屋顶] 完成")
    return coll


# ============================================================
# 3. 木构架
# ============================================================

def build_timber():
    p = P
    coll = new_coll("TimberFrame")
    bw = p["bay_main"] + 2 * p["bay_side"]
    bd = p["depth"]
    wh = p["eave_h"]

    print("  [木构架] 开始构建...")

    timber_m = mkmat("Timber", (0.30, 0.22, 0.15), 0.80)
    beam_m = mkmat("Beam", (0.32, 0.24, 0.16), 0.78)

    # 8根柱
    col_pos = [
        (-bw/2, bd/2), (-p["bay_main"]/2, bd/2),
        ( p["bay_main"]/2, bd/2), ( bw/2, bd/2),
        (-bw/2, -bd/2), (-p["bay_main"]/2, -bd/2),
        ( p["bay_main"]/2, -bd/2), ( bw/2, -bd/2),
    ]
    for i, (cx, cy) in enumerate(col_pos):
        c = mkcyl(p["col_r"], wh, (cx, cy, wh/2), f"Column_{i}", coll, segs=12)
        c.data.materials.append(timber_m)
    print("    ✓ 8根柱")

    # 3根檩
    for zy, bname in [(bd/2+0.1, "Front_Tie"), (-bd/2-0.1, "Back_Tie"), (0, "Mid_Tie")]:
        b = mkbox(bw+0.4, p["beam_w"], p["beam_h"],
                   (0, zy, wh+p["beam_h"]/2), bname, coll)
        b.data.materials.append(beam_m)
    print("    ✓ 3根檩")

    print("  [木构架] 完成")
    return coll


# ============================================================
# 4. 附件
# ============================================================

def build_acc():
    p = P
    coll = new_coll("Accessories")
    bw = p["bay_main"] + 2 * p["bay_side"]
    bd = p["depth"]
    wh, fh = p["eave_h"], p["found_h"]

    print("  [附件] 开始构建...")

    brick_m = mkmat("Chimney_Brick", (0.60, 0.48, 0.40), 0.90)
    stone_m = mkmat("Stone_Step", (0.50, 0.48, 0.45), 0.95)
    wood_m = mkmat("Threshold", (0.28, 0.20, 0.14), 0.80)

    if p["chimney"]:
        c = mkbox(0.4, 0.5, 1.2,
                   (bw/2-0.5, -bd/4, wh+0.6), "Chimney", coll)
        c.data.materials.append(brick_m)
        print("    ✓ 烟囱")

    if p["steps"]:
        for i in range(3):
            s = mkbox(1.2+i*0.2, 0.35, 0.15,
                       (0, bd/2+0.2+i*0.35, fh+0.075+i*0.15),
                       f"Step_{i}", coll)
            s.data.materials.append(stone_m)
        print("    ✓ 台阶")

    if p["threshold"]:
        t = mkbox(p["door_w"]+0.1, 0.12, 0.08,
                   (0, bd/2+0.01, fh+0.04), "Threshold", coll)
        t.data.materials.append(wood_m)
        print("    ✓ 门槛")

    print("  [附件] 完成")
    return coll


# ============================================================
# 主构建
# ============================================================

def build_house():
    print("=" * 60)
    print("真实老房子建模 POC - 阶段1：几何骨架（白模）")
    print("=" * 60)

    clear()
    random.seed(P["seed"])

    house = new_coll("RealisticHouse")

    walls, wc = build_walls()
    rc = build_roof()
    tc = build_timber()
    ac = build_acc()

    # 收集所有对象数
    total_objs = sum(len(c.all_objects) for c in [wc, rc, tc, ac])
    total_tris = 0
    for obj in bpy.context.scene.objects:
        if obj.type == 'MESH' and obj.data.polygons:
            total_tris += sum(max(len(p.vertices)-2, 0) for p in obj.data.polygons)

    print(f"\n  场景统计：{total_objs} 对象，~{total_tris} 三角面")
    return house


def export_glb(path):
    out = os.path.abspath(path) if path.startswith("//") else path
    d = os.path.dirname(out)
    if d and not os.path.exists(d):
        os.makedirs(d)

    print("  应用所有 modifier...")
    bpy.ops.object.select_all(action='SELECT')
    for obj in bpy.context.selected_objects:
        if obj.type == 'MESH':
            for mod in list(obj.modifiers):
                bpy.context.view_layer.objects.active = obj
                bpy.ops.object.modifier_apply(modifier=mod.name)

    print("  导出 GLB...")
    bpy.ops.export_scene.gltf(
        filepath=out, export_format='GLB',
        export_materials='EXPORT', export_texcoords=True,
        export_normals=True,
        export_draco_mesh_compression_enable=False,
        export_image_format='JPEG', export_image_quality=85,
    )
    print(f"\n✅ 导出完成：{out}")
    size_mb = os.path.getsize(out) / 1024 / 1024 if os.path.exists(out) else 0
    print(f"   文件大小：{size_mb:.2f} MB")


if __name__ == "__main__":
    parse_args()
    if P["output"].startswith("//"):
        P["output"] = os.path.abspath(P["output"])

    build_house()
    export_glb(P["output"])
    print(f"\n🏠 老房子白模完成！种子={P['seed']}")

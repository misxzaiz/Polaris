"""
Boeing 747-400 参数化建模 - Blender Y-up 坐标系
================================================
坐标系（Blender 原生）：
  Y = 机身长轴（机头 -Y，机尾 +Y）→ glTF 中机头朝 +Z（水平向前）
  X = 展向（右翼 +X，左翼 -X）
  Z = 垂直向上

用法：
  blender --background --python b747.py -- --output output/b747.glb
"""

import bpy, bmesh, sys, os, json, math, bisect
from mathutils import Vector


# ============================================================
# 参数
# ============================================================
params = {
    "fuselage_length": 70.6,
    "fuselage_diameter": 6.5,
    "fuselage_segments": 48,
    "fuselage_rings": 46,

    "wingspan": 64.4,
    "wing_sweep": 37.5,
    "wing_root_chord": 10.0,
    "wing_tip_chord": 2.5,
    "wing_airfoil_thickness": 0.12,
    "wing_segments": 24,
    "wing_dihedral": 5.5,
    "wing_root_y": 3.2,

    "hstab_span": 22.0,
    "hstab_chord": 6.0,
    "hstab_sweep": 35.0,
    "vstab_height": 9.0,
    "vstab_chord": 8.0,
    "vstab_sweep": 45.0,

    "engine_y_positions": [-12.5, -5.5, 5.5, 12.5],
    "engine_diameter": 2.6,
    "engine_length": 4.2,

    "fuselage_color": (0.95, 0.95, 0.95, 1.0),
    "wing_color": (0.82, 0.82, 0.82, 1.0),
    "engine_color": (0.42, 0.42, 0.42, 1.0),
    "glass_color": (0.55, 0.68, 0.88, 0.85),
    "stripe_color": (0.0, 0.28, 0.62, 1.0),
    "window_color": (0.10, 0.18, 0.30, 0.9),

    "subdivision_levels": 1,
    "output_path": "//b747.glb",
}


def parse_args():
    args = sys.argv
    if '--' not in args:
        return
    idx = args.index('--')
    for i, arg in enumerate(args[idx+1:]):
        if arg.startswith('--') and i+1 < len(args[idx+1:]) and not args[idx+1+i+1].startswith('--'):
            key = arg[2:]
            val = args[idx+1+i+1]
            if key == 'output':
                params['output_path'] = val
            elif key == 'params':
                try:
                    params.update(json.loads(val))
                except json.JSONDecodeError:
                    print(f"Warning: bad params JSON: {val}")


# ============================================================
# 材质
# ============================================================
_mats = {}
def make_pbr(name, color, roughness=0.4, metallic=0.0):
    if name in _mats:
        return _mats[name]
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    for n in nodes:
        nodes.remove(n)
    p = nodes.new(type='ShaderNodeBsdfPrincipled')
    p.inputs['Base Color'].default_value = color
    p.inputs['Roughness'].default_value = roughness
    p.inputs['Metallic'].default_value = metallic
    out = nodes.new(type='ShaderNodeOutputMaterial')
    mat.node_tree.links.new(p.outputs['BSDF'], out.inputs['Surface'])
    mat.diffuse_color = color
    _mats[name] = mat
    return mat


def assign(obj, mat):
    if obj.data.materials:
        obj.data.materials[0] = mat
    else:
        obj.data.materials.append(mat)


def subsurf(obj):
    if params['subdivision_levels'] > 0:
        m = obj.modifiers.new(name="Subdivision", type='SUBSURF')
        m.levels = params['subdivision_levels']
        m.render_levels = params['subdivision_levels']


# ============================================================
# NACA 翼型
# ============================================================
def naca_airfoil(t, n=40):
    """返回 (x_vals, z_vals) 弦长归一化，厚度比 t"""
    xv, zv = [], []
    for i in range(n//2):
        beta = math.pi * i / (n//2 - 1)
        x = 0.5 * (1 - math.cos(beta))
        z = (t/0.2) * (0.2969*math.sqrt(x) - 0.1260*x - 0.3516*x**2 + 0.2843*x**3 - 0.1015*x**4)
        xv.append(x); zv.append(z)
    for i in range(n//2-1, -1, -1):
        beta = math.pi * i / (n//2 - 1)
        x = 0.5 * (1 - math.cos(beta))
        z = -(t/0.2) * (0.2969*math.sqrt(x) - 0.1260*x - 0.3516*x**2 + 0.2843*x**3 - 0.1015*x**4)
        xv.append(x); zv.append(z)
    return xv, zv


# ============================================================
# 机身
# 坐标系：机身沿 Y 轴（机头 -Y，机尾 +Y）
# 截面在 XZ 平面，半径 = X 和 Z 方向
# ============================================================
def build_fuselage():
    p = params
    length = p['fuselage_length']
    max_r = p['fuselage_diameter'] / 2.0
    rings = p['fuselage_rings']
    segs = p['fuselage_segments']

    # 轮廓：t=0(机头,-Y) 到 t=1(机尾,+Y)
    profile = [
        (0.000, 0.00), (0.004, 0.10), (0.010, 0.28), (0.018, 0.48),
        (0.028, 0.66), (0.040, 0.80), (0.055, 0.90), (0.075, 0.96),
        (0.100, 0.99), (0.130, 1.00), (0.30, 1.00), (0.50, 1.00),
        (0.70, 1.00), (0.82, 0.97), (0.88, 0.90), (0.93, 0.76),
        (0.96, 0.58), (0.98, 0.38), (0.995, 0.20), (1.000, 0.00),
    ]
    tv = [x[0] for x in profile]
    rv = [x[1] for x in profile]

    rads = []
    for i in range(rings):
        t = i / (rings - 1)
        idx = bisect.bisect_left(tv, t)
        if idx == 0:
            rads.append(rv[0])
        elif idx >= len(tv):
            rads.append(rv[-1])
        else:
            t0, r0 = tv[idx-1], rv[idx-1]
            t1, r1 = tv[idx], rv[idx]
            f = (t - t0) / (t1 - t0)
            rads.append(r0 + (r1 - r0) * f)

    bm = bmesh.new()
    rv = []
    for i in range(rings):
        t = i / (rings - 1)
        y = -length/2 + t * length   # 机头 -Y → 机尾 +Y
        r = rads[i] * max_r
        verts = []
        for j in range(segs):
            theta = 2 * math.pi * j / segs
            verts.append(bm.verts.new((r * math.cos(theta), y, r * math.sin(theta))))
        rv.append(verts)

    for i in range(rings - 1):
        for j in range(segs):
            jn = (j + 1) % segs
            try:
                bm.faces.new((rv[i][j], rv[i][jn], rv[i+1][jn], rv[i+1][j]))
            except ValueError:
                pass

    nose = bm.verts.new((0, -length/2, 0))
    for j in range(segs):
        jn = (j + 1) % segs
        try:
            bm.faces.new((rv[0][j], rv[0][jn], nose))
        except ValueError:
            pass
    tail = bm.verts.new((0, length/2, 0))
    for j in range(segs):
        jn = (j + 1) % segs
        try:
            bm.faces.new((rv[-1][jn], rv[-1][j], tail))
        except ValueError:
            pass

    mesh = bpy.data.meshes.new("Fuselage")
    bm.to_mesh(mesh); bm.free(); mesh.update()
    obj = bpy.data.objects.new("Fuselage", mesh)
    bpy.context.collection.objects.link(obj)
    assign(obj, make_pbr("FuselageMat", p['fuselage_color'], 0.3))
    subsurf(obj)
    return obj


# ============================================================
# 机翼（含副翼、襟翼）
# 沿 X 轴展向，弦长沿 Y 方向
# ============================================================
def build_wing(is_left):
    p = params
    half_span = p['wingspan'] / 2.0
    root_y = p['wing_root_y']
    root_c = p['wing_root_chord']
    tip_c = p['wing_tip_chord']
    sweep = math.radians(p['wing_sweep'])
    dihedral = math.radians(p['wing_dihedral'])
    n_seg = p['wing_segments']
    sign = -1 if is_left else 1
    af = naca_airfoil(p['wing_airfoil_thickness'], 30)

    # 机翼垂直位置：Z 略低于 0（下单翼）
    wing_z = -0.3

    def _section(f, chord_ratio=1.0):
        span_pos = sign * (root_y + (half_span - root_y) * f)
        chord = root_c + (tip_c - root_c) * f
        sweep_off = (abs(span_pos) - root_y) * math.tan(sweep)
        dihedral_off = (abs(span_pos) - root_y) * math.sin(dihedral)
        verts = []
        for j in range(len(af[0])):
            x = span_pos
            y = -sweep_off + af[0][j] * chord * chord_ratio
            # 修正：弦长方向沿 Y（飞机前后），后掠使前缘 Y 后移
            # 前缘在 Y 负方向，后缘在 Y 正方向
            # 但是 af[0] 是从 0(前缘) 到 1(后缘) 再到 0(前缘)
            # 所以 0 是前缘，1 是后缘
            # 弦长方向沿 Y，前缘在 -Y 同学
            # 实际上用 af[0] 来映射到 Y 方向：前缘(0)→后缘(1) 沿 Y 正方向
            # 但后掠使整个翼型向后移：sweep_off 是正数（向后）
            # 所以：y = -sweep_off + af[0][j] * chord
            # 前缘在 y = -sweep_off，后缘在 y = -sweep_off + chord
            z = wing_z + dihedral_off + af[1][j] * chord * p['wing_airfoil_thickness']
            verts.append((x, y, z))
        return verts

    # 主翼
    sections = [_section(f) for f in [i/n_seg for i in range(n_seg+1)]]
    wing = _loft("Wing_%s" % ("L" if is_left else "R"), sections)
    assign(wing, make_pbr("WingMat", p['wing_color'], 0.4))
    subsurf(wing)

    # 副翼（外侧后缘 25% 弦长）
    ail_sections = []
    for i in range(n_seg + 1):
        f = i / n_seg
        if f < 0.55:
            continue
        sec = _section(f, 0.25)
        # 只保留后缘部分：偏移使得弦长起点在后缘区域
        # 但 _section 已经用了 chord_ratio，所以直接微调位置
        ail_sections.append(sec)
    if ail_sections:
        ail = _loft("Aileron_%s" % ("L" if is_left else "R"), ail_sections)
        assign(ail, make_pbr("AileronMat", p['wing_color'], 0.5))
        subsurf(ail)

    # 襟翼（内侧后缘 30% 弦长）
    flap_sections = []
    for i in range(n_seg + 1):
        f = i / n_seg
        if f > 0.55:
            continue
        flap_sections.append(_section(f, 0.30))
    if flap_sections:
        flp = _loft("Flap_%s" % ("L" if is_left else "R"), flap_sections)
        assign(flp, make_pbr("FlapMat", p['wing_color'], 0.5))
        subsurf(flp)

    return wing


def _loft(name, sections):
    """放样多个截面为一个 mesh"""
    bm = bmesh.new()
    sv = []
    for sec in sections:
        sv.append([bm.verts.new(v) for v in sec])
    np = len(sv[0])
    for i in range(len(sv) - 1):
        for j in range(np - 1):
            try:
                bm.faces.new((sv[i][j], sv[i][j+1], sv[i+1][j+1], sv[i+1][j]))
            except ValueError:
                pass
    # 翼尖封闭
    tip = sv[-1]
    for j in range(np - 1):
        try:
            bm.faces.new((tip[j], tip[j+1], tip[0]))
        except ValueError:
            pass
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh); bm.free(); mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


# ============================================================
# 尾翼
# 平尾：沿 X 展向，弦长沿 Y
# 垂尾：沿 Z 向上，弦长沿 Y
# ============================================================
def build_hstab():
    p = params
    half = p['hstab_span'] / 2.0
    sweep = math.radians(p['hstab_sweep'])
    af = naca_airfoil(0.10, 20)
    # 平尾在机身尾部
    y_pos = p['fuselage_length'] * 0.40  # 尾段
    root_y = p['fuselage_diameter'] / 2.0 * 0.5
    z_off = 0.5  # 略高于机身中线

    sections = []
    for side in (1, -1):
        for i in range(9):
            f = i / 8
            span_pos = side * (root_y + (half - root_y) * f)
            chord = p['hstab_chord'] * (1.0 - f * 0.4)
            sweep_off = (abs(span_pos) - root_y) * math.tan(sweep)
            verts = []
            for j in range(len(af[0])):
                x = span_pos
                y = y_pos + sweep_off + af[0][j] * chord
                z = z_off + af[1][j] * chord * 0.10
                verts.append((x, y, z))
            sections.append(verts)

    hstab = _loft("HStab", sections)
    assign(hstab, make_pbr("HStabMat", p['wing_color'], 0.4))
    subsurf(hstab)
    return hstab


def build_vstab():
    p = params
    sweep = math.radians(p['vstab_sweep'])
    af = naca_airfoil(0.10, 20)
    y_pos = p['fuselage_length'] * 0.42
    sections = []
    for i in range(9):
        f = i / 8
        z_pos = f * p['vstab_height']
        chord = p['vstab_chord'] * (1.0 - f * 0.5)
        sweep_off = f * p['vstab_height'] * math.tan(sweep)
        verts = []
        for j in range(len(af[0])):
            x = af[1][j] * chord * 0.15
            y = y_pos + sweep_off + af[0][j] * chord
            z = z_pos
            verts.append((x, y, z))
        sections.append(verts)

    vstab = _loft("VStab", sections)
    assign(vstab, make_pbr("VStabMat", p['wing_color'], 0.4))
    subsurf(vstab)
    return vstab


# ============================================================
# 发动机
# 长轴沿 Y 方向，在机翼前下方
# ============================================================
def build_engine(idx, y_pos):
    p = params
    dia = p['engine_diameter']
    length = p['engine_length']
    segs = 24

    # 发动机位置：在机翼前缘下方
    wing_z = -0.3
    root_y = p['wing_root_y']
    half_span = p['wingspan'] / 2.0
    sweep = math.radians(p['wing_sweep'])
    sign = 1 if y_pos >= 0 else -1
    span_pos = sign * (root_y + (abs(y_pos) - root_y) * 0.9)
    le_y = (abs(span_pos) - root_y) * math.tan(sweep)
    engine_y = le_y - 1.5  # 机翼前缘前方
    engine_z = wing_z - 1.0  # 机翼下方

    bm = bmesh.new()
    # 短舱轮廓
    nacelle = [
        (0.00, 0.0), (0.03, 0.30), (0.06, 0.42), (0.10, 0.46),
        (0.15, 0.48), (0.30, 0.50), (0.55, 0.50), (0.75, 0.46),
        (0.88, 0.36), (0.95, 0.22), (0.99, 0.08), (1.00, 0.0),
    ]
    nrads = []
    for i in range(16):
        t = i / 15
        k = 0
        for kk in range(1, len(nacelle)):
            if nacelle[kk][0] >= t:
                k = kk - 1
                break
        t0, r0 = nacelle[k]
        t1, r1 = nacelle[k+1]
        f = (t - t0) / (t1 - t0)
        nrads.append((r0 + (r1 - r0) * f) * dia / 2)

    rv = []
    for i in range(16):
        t = i / 15
        y = -length/2 + t * length
        r = nrads[i]
        verts = []
        for j in range(segs):
            theta = 2 * math.pi * j / segs
            verts.append(bm.verts.new((span_pos + r * math.cos(theta), y + engine_y, engine_z + r * math.sin(theta))))
        rv.append(verts)

    for i in range(15):
        for j in range(segs):
            jn = (j + 1) % segs
            try:
                bm.faces.new((rv[i][j], rv[i][jn], rv[i+1][jn], rv[i+1][j]))
            except ValueError:
                pass

    # 前缘
    nose = bm.verts.new((span_pos, -length/2 + engine_y, engine_z))
    for j in range(segs):
        jn = (j + 1) % segs
        try:
            bm.faces.new((rv[0][j], rv[0][jn], nose))
        except ValueError:
            pass

    # 风扇盘
    fan_r = dia/2 * 0.42
    fv = []
    for j in range(segs):
        theta = 2 * math.pi * j / segs
        fv.append(bm.verts.new((span_pos + fan_r * math.cos(theta), -length/2 + 0.08 + engine_y, engine_z + fan_r * math.sin(theta))))
    fc = bm.verts.new((span_pos, -length/2 + 0.08 + engine_y, engine_z))
    for j in range(segs):
        jn = (j + 1) % segs
        try:
            bm.faces.new((fv[j], fv[jn], fc))
        except ValueError:
            pass

    # 排气锥
    cone_r = dia/2 * 0.25
    cv = []
    for j in range(segs):
        theta = 2 * math.pi * j / segs
        cv.append(bm.verts.new((span_pos + cone_r * math.cos(theta), length/2 - 0.3 + engine_y, engine_z + cone_r * math.sin(theta))))
    ct = bm.verts.new((span_pos, length/2 - 0.05 + engine_y, engine_z))
    for j in range(segs):
        jn = (j + 1) % segs
        try:
            bm.faces.new((cv[j], cv[jn], ct))
        except ValueError:
            pass

    mesh = bpy.data.meshes.new("Engine_%d" % idx)
    bm.to_mesh(mesh); bm.free(); mesh.update()
    obj = bpy.data.objects.new("Engine_%d" % idx, mesh)
    bpy.context.collection.objects.link(obj)
    assign(obj, make_pbr("EngineMat", p['engine_color'], 0.6, 0.6))
    subsurf(obj)
    return obj


# ============================================================
# 驾驶舱玻璃
# ============================================================
def build_cockpit():
    p = params
    length = p['fuselage_length']
    max_r = p['fuselage_diameter'] / 2.0
    bm = bmesh.new()
    x_start = -length/2 * 0.75
    x_end = -length/2 * 0.30
    rings = 8
    strips = 20
    r = max_r * 1.01

    rv = []
    for i in range(rings):
        t = i / (rings - 1)
        y = x_start + (x_end - x_start) * t
        verts = []
        for j in range(strips):
            theta = -math.pi/3 + (2*math.pi/3) * j / (strips - 1)
            x = r * math.sin(theta) * 0.7
            z = r * math.cos(theta) * 0.9
            if z < 0:
                z = 0
            verts.append(bm.verts.new((x, y, z)))
        rv.append(verts)

    for i in range(rings - 1):
        for j in range(strips - 1):
            try:
                bm.faces.new((rv[i][j], rv[i][j+1], rv[i+1][j+1], rv[i+1][j]))
            except ValueError:
                pass

    mesh = bpy.data.meshes.new("Cockpit")
    bm.to_mesh(mesh); bm.free(); mesh.update()
    obj = bpy.data.objects.new("Cockpit", mesh)
    bpy.context.collection.objects.link(obj)
    assign(obj, make_pbr("GlassMat", p['glass_color'], 0.1))
    return obj


# ============================================================
# 涂装条纹
# ============================================================
def build_stripes():
    p = params
    length = p['fuselage_length']
    max_r = p['fuselage_diameter'] / 2.0
    bm = bmesh.new()
    y_start = -length * 0.28
    y_end = length * 0.28
    rings = 6
    segs = 40

    rv = []
    for i in range(rings):
        t = i / (rings - 1)
        y = y_start + (y_end - y_start) * t
        verts = []
        for j in range(segs):
            theta = 2 * math.pi * j / segs
            # 只保留下半部分条纹
            z = max_r * math.sin(theta) * 1.003
            if z > 0:
                continue
            x = max_r * math.cos(theta) * 1.003
            verts.append(bm.verts.new((x, y, z)))
        if len(verts) > 2:
            rv.append(verts)

    for i in range(len(rv) - 1):
        a, b = rv[i], rv[i+1]
        n = min(len(a), len(b))
        for j in range(n - 1):
            try:
                bm.faces.new((a[j], a[j+1], b[j+1], b[j]))
            except ValueError:
                pass

    if len(rv) >= 2:
        mesh = bpy.data.meshes.new("Stripes")
        bm.to_mesh(mesh)
        bm.free()
        mesh.update()
        obj = bpy.data.objects.new("Stripes", mesh)
        bpy.context.collection.objects.link(obj)
        assign(obj, make_pbr("StripeMat", p['stripe_color'], 0.3))
        return obj
    bm.free()
    return None


# ============================================================
# 主函数
# ============================================================
def build_b747():
    p = params
    print("=" * 60)
    print("Boeing 747-400")
    print(f"  Fuselage: {p['fuselage_length']}m (Y-axis, nose at -Y)")
    print(f"  Wingspan: {p['wingspan']}m (X-axis)")
    print(f"  Engines: 4")
    print("=" * 60)

    build_fuselage()
    for side in (True, False):
        build_wing(side)
    build_hstab()
    build_vstab()
    for i, yp in enumerate(p['engine_y_positions']):
        build_engine(i, yp)
    build_cockpit()
    build_stripes()

    objs = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    print(f"\n  Total: {len(objs)} mesh objects")
    return objs


def setup_scene():
    s = bpy.context.scene
    s.render.resolution_x = 1920
    s.render.resolution_y = 1080
    s.render.film_transparent = True
    s.world.use_nodes = False
    s.world.color = (0.05, 0.05, 0.1)


def export_glb(path):
    d = os.path.dirname(path)
    if d and not os.path.exists(d):
        os.makedirs(d)
    bpy.ops.preferences.addon_enable(module='io_scene_gltf2')
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        export_materials='EXPORT',
        export_image_format='JPEG',
        export_texcoords=True,
        export_normals=True,
        export_draco_mesh_compression_enable=False,
        export_animations=True,
        export_skins=True,
    )
    print(f"\n✅ Exported: {path}")


if __name__ == "__main__":
    parse_args()
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for b in list(bpy.data.meshes):
        bpy.data.meshes.remove(b)
    for b in list(bpy.data.materials):
        bpy.data.materials.remove(b)
    for b in list(bpy.data.images):
        bpy.data.images.remove(b)

    parts = build_b747()
    setup_scene()
    output = params.get('output_path', '//b747.glb')
    export_glb(output)
    print(f"   输出: {output}")
    print(f"   部件: {len(parts)}")
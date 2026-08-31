# 真实三维建模插件 — 集成分析（skill / 工具 / 插件）

> 创建: 2026-08-31 | 状态: 分析定稿
> 范围: 已验收的老房子建模管线（`blender_generate_3d` + `bake_house`）如何进一步集成到 Polaris 的 skill / 工具 / 插件三层体系，让 AI 在自然语言下自动驱动

---

## 0. 现状盘点（已实测验证）

| 层 | 现有实现 | 位置 |
|---|---|---|
| 插件 | `polaris.blender-modeling`，manifest 声明 `mcpServers`（stdio→`server.js`）+ `chatCards`（3D 预览渲染）+ `views`（活动栏面板） | `Polaris-plugin/plugins/blender-modeling/plugin.json` |
| 工具 | `blender_generate_3d(script, params, …)` / `blender_list_models` / `blender_register_script` / `blender_unregister_script`；参数取自 `params_schema` 变量 | `server.js`（`generateScriptIndex()` 自动扫描 `scripts/`） |
| Skill | 暂无（AI 不知道"建房子"该调哪个工具） | — |

**断点**：工具和插件都已就绪，AI 却只有通用指令，没有触发到"调建模工具"的语义。需要 Skill 层补上"何时调、怎么调"。

---

## 1. 候选集成方案（对比后选定）

| 方案 | 改动面 | 接线成本 | 灵活性 | 风险 | 判定 |
|---|---|---|---|---|---|
| A. **Skill 触发 + 现有 MCP 工具** | 新增 `SKILL.md`，host 代码零改 | 极低（一个文件） | 高（参数随 prompt 走） | 依赖 AI 理解 skill 文本 | ✅ **主选** |
| B. 新增顶层 MCP 工具（`blender_build_house`） | `server.js` 多注册一个包装，锁定工程参数 | 低（~30 行） | 中（包装层须随脚本升级同步） | 多维护一层 wrapper，接口变动须改两处 | 🔄 **Step 2，接口稳定后** |
| C. 插件 preset 机制（manifest 声明预设 id） | `plugin-system` 类型 + host 读取 preset 字段 + `blender-modeling` 声明 preset | 中（需改 `plugin-system` 和 host 扫描逻辑） | 低（预设编译进插件，更新须发新版本） | 收益不够，与现有 skill 语义重复 | ❌ 暂缓 |
| D. Skill 直接内联完整脚本路径（不经过 MCP） | Skill 写死 "调 `bake_house.py` 走 CLI" | 极低 | 低（绕过 MCP 权限/渲染链路） | 丢失 `chatCards` 3D 预览、AI 需自己拼 CLI | ❌ 破坏现有渲染 |

**选定 A 为主方案，B 为远期包装。** 核心逻辑：skill 解决"何时调"，MCP 工具解决"怎么调"，插件解决"渲染和面板"。三层各管一段，不重复。

---

## 2. 主选方案 A — Skill 触发

### 2.1 Polaris Skill 体系事实（已读源码验证）

- 定义：Markdown 文件，含 `#` 标题 + 正文指令，AI 通过 `/` 命令选中后注入上下文（`src/types/skill.ts` `SkillItem`）
- 扫描路径（`src/stores/skillStore.ts:180`）：工作区 `.polaris/skills` / `.polaris/agents`，外加 DataRoot 下同名目录
- 格式两种：子目录 `<name>/SKILL.md` 或平铺 `<name>.md`
- 生命周期：`useAppInit` 启动时 `loadSkills()`，`/` 命令实时 `searchSkills(query)` 触发建议列表

**关键推论**：
1. Skill 是**纯文本指令注入**，不是工具调用——所以 skill 里要**明确告诉 AI 调哪个 MCP 工具名**（`blender_generate_3d`），参数如何传。
2. 仓库级 skill 放 `<工作区>/.polaris/skills/` 即可被自动发现，**host 代码零改**。

### 2.2 SKILL.md 内容设计（已对齐现有工程约定）

调用约定必须写死的三件事（来自已验证事实）：

1. **工具名**：`blender_generate_3d`（MCP `polaris-blender` server 提供的 script 入口）
2. **超时**：`bake_house` 完整 bake 实测 ~1135s，必须传 `timeout>=1200000`（否则 600s 默认会提前杀进程——已踩坑见 `realistic-house-stage2-mcp-verified.md`）
3. **参数层级**：AI 只传 user-facing 参数（风格/规模/做旧强度），分辨率/采样/AO 等工程参数锁死在脚本默认值，skill 中明说"不要改"

失败处理写死已知的两类（避免 AI 自己瞎猜）：
- 超时 → 提升 timeout 重试
- mask 全白 → 已修复版本，重跑即可（不必排查 shader）

### 2.3 接线路径图

```
用户在聊天说"帮我建一个老房子"
        │
        ▼
AI 通过 / 命令选中"真实三维建模" skill
        │  (skillStore 注入 SKILL.md 文本)
        ▼
AI 读 skill → 知道该调 blender_generate_3d，参数如何传
        │
        ▼
AI 发起 MCP tool_call: blender_generate_3d(script=bake_house, timeout=1200000, …)
        │
        ▼
Polaris 主机桥接 → polars-blender MCP server (stdio)
        │
        ▼
server.js: generateScriptIndex() 找到 bake_house.py
        │
        ▼
Blender headless 执行 1135s → GLB 输出
        │
        ▼
chatCards 匹配 tool → PreviewCard.tsx 渲染 3D 自包含预览
```

---

## 3. 进阶方案 B — 顶层 MCP 工具（接口稳定后）

**动机**：Skill 方案中 AI 仍需推断"用户想要白模还是带纹理"并选 `script=realistic_house` 或 `bake_house`，且参数命名（`resolution_main`/`ao_samples`）对自然语言不友好。顶层工具把这两层封装掉。

**形态**：在 `server.js` 新增 `blender_build_house(style, scale, weathering, includeInterior, timeout)`，内部映射到现有脚本：

| 顶层参数 | 映射 | 默认 |
|---|---|---|
| `style` | 决定 asset_id 选择（"中式老宅"→brick+plaster+tile 当前默认；"现代"→替换为水泥/金属/玻璃） | 中式老宅 |
| `scale` | `realistic_house` 的几何参数（开间/进深/柱高） | 3.6/4.8/2.8 |
| `weathering` | `bake_house.write_masks` + `seed` + moss/dirt/peel 强度系数 | strong |
| `includeInterior` | 触发白模端增加内墙/楼板/家具占位（当前未实现，需先扩 realistic_house） | false |
| `timeout` | 直接透传 | 1200000 |

**代价**：
- wrapper 与底层脚本的参数必须同步——脚本每次加参数，wrapper schema 都要更新
- 需要单独维护 `params_schema` 一份
- 短期收益不足（skill 方案已能闭环）

**建议触发时机**：底层脚本接口至少两个版本稳定 + 用户出现"参数太多记不住"的反馈。

---

## 4. 遗留项（与本集成无关，标注供参考）

- 瓦面 bake 图 93.5% 黑（UV 岛稀疏）— 性能优化，与接线无关
- KTX2 压缩 28.9MB→~15MB — 体积优化
- 室内陈设 / 比例参照 — 内容扩展，须先扩 `realistic_house.py` 几何

---

## 5. 推荐落地顺序

| 步 | 内容 | 改动面 | 预估 |
|---|---|---|---|
| Step 1（现在） | 新增 `.polaris/skills/realistic-modeling/SKILL.md`，写死调用约定与超时 | 1 个文件 | 15 分钟 |
| Step 2（接口稳定后，可选） | `server.js` 加 `blender_build_house` 顶层包装 | `server.js` + schema | ~1 小时 |
| Step 3（远期） | 室内陈设扩展 + 比例参照 → 反推 B 方案的 `includeInterior` | `realistic_house.py` | 单独排期 |

---

## 6. 结论

**接线方案定稿**：以 Skill 层触发（方案 A）为主，零 host 改动、零新工具，1 个 SKILL.md 文件闭环"AI 自然语言 → 调建模工具 → 3D 预览"。方案 B（顶层 MCP 工具）作为接口稳定后的可选包装，不阻塞 Step 1。

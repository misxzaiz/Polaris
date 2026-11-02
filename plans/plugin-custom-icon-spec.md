# 插件自定义图标（icon 契约放宽）Spec

日期：2026-11-03　|　状态：已实施
所有者：宿主 plugin-system（前端 `src/plugin-system/`）+ 宿主单源校验（Rust `plugin_service.rs`）

## 1. 目标

`contributes.views[].icon` 当前只允许 18 个内置 lucide 名（Rust `VALID_PLUGIN_ICONS` +
前端 `schema.ts` 单源，双向镜像测试守护），非白名单值（如 `FileText`、自定义 SVG）在
安装期即被拒。本改动把 icon 值域放宽为四类，插件可完全自定义图标，同时保留向后兼容
与安全护栏。

## 2. 业界对标（VS Code）

- `contributes.views` 视图图标：内置 codicon id（`$(zap)` 风格）或**相对路径 SVG 文件**
  （官方 UX 指南：优先内置图标，自定义用单色 SVG 文件）。
- `contributes.icons`：注册自定义图标 id，default 可为字体图标或文件。
- 扩展级 `icon` 字段：相对路径 PNG（marketplace 用）。

Polaris 对应关系：内置 lucide 名 ↔ codicon id；相对路径 ↔ 插件目录资源文件。
本方案为 VS Code 值域的超集（额外支持 http(s) URL 与 data URL，便于轻量/远程场景）。

来源：VS Code Contribution Points / Views UX Guidelines（code.visualstudio.com）。

## 3. icon 值域（新契约，四类）

| 类型 | 形式 | 示例 |
|---|---|---|
| 内置名（现状） | 18 个 lucide 名 | `"Bot"` |
| 相对路径 | 相对插件 installPath，扩展名白名单 | `"./assets/icon.svg"`、`"assets/logo.png"` |
| 网络链接 | `http(s)://` URL | `"https://example.com/icon.svg"` |
| 内联数据 | `data:image/*` URL | `"data:image/svg+xml,..."` |

统一校验规则（Rust 与前端单源各持一份、语义一致，规格写死防漂移）：

- trim 非空；不含 ASCII 控制字符与字面空格；总长 ≤ 2048。
- `data:` 前缀必须为 `data:image/`。
- 网络链接仅 `http://` / `https://`。
- 其余按相对路径处理：首字符不得为 `/` `\`；不含盘符 `X:`；`\` 归一为 `/` 后
  不得出现 `..` 段（防目录逃逸）；扩展名 ∈
  `svg|png|jpg|jpeg|webp|gif|ico|bmp|avif`（大小写不敏感）。
- 在 18 名白名单内的值始终按内置名优先（"Users.png" 这类带扩展名按路径处理）。

拒绝值示例：`"FileText"`（非白名单内置名）、`"../../etc/x.png"`（逃逸）、
`"file:///C:/x.png"`、`"javascript:..."`、`"/abs/path.png"`、`"icon"`（无扩展名）。

## 4. 数据流与所有者（事件顺序）

```
插件 manifest.json (icon 字段)
  → Rust 安装期/发现期校验  plugin_service::validate_manifest_fields   [唯一后端权威]
  → 前端发现产物归一        pluginDiscoveryService::normalizeViews      [isValidPluginIconValue]
  → 渲染期解析（异步）      plugin-system/iconResolver                  [本 spec 新增，唯一解析权威]
      ├─ 内置名            → pluginIconMap（同步，零开销）
      ├─ http(s)/data URL  → <img src> 直连（桌面 CSP=null 可加载；外链有隐私面，如实告知）
      └─ 相对路径          → registry 查 installPath 拼绝对路径
                            → invoke('download_file_binary') → base64 → data URL（缓存）
  → 消费组件渲染            getPluginIconComponent(icon, pluginId)（5 文件 6 处）
```

- 唯一写路径：icon 字符串只在 manifest；data URL 只在 iconResolver 缓存（内存，页面刷新清空）。
- 失败语义：任一环节失败（文件不存在/超限/非图片）→ 渲染回退 lucide `Puzzle`，**不阻塞面板装载**。

## 5. 护栏

- 大小上限 512KB（base64 解码前估算），超限拒绝。
- 扩展名白名单在 Rust 校验与前端读取时**双重执行**（防 dev-link 绕过安装期校验）。
- 相对路径 `..`/绝对路径/盘符拒绝，同样双重执行。
- SVG 经 `<img>` 渲染：浏览器隔离上下文，脚本不执行，天然防 XSS。
- 内置名集合与镜像测试（pluginDiscoveryService.test.ts）**保持不变**。

## 6. 接口清单

- Rust：`plugin_service.rs` 新增 `is_supported_plugin_icon(&str) -> bool`；
  `validate_manifest_fields` 换用它（错误信息更新为四类说明）。
- 前端：`schema.ts` 新增 `isValidPluginIconValue` + `PLUGIN_ICON_IMAGE_EXTENSIONS`；
  `types.ts` `PluginViewContribution.icon: PluginIconValue`（= string，注释说明四类）；
  `pluginDiscoveryService.ts` normalizeViews 换用新校验。
- 前端新增：`plugin-system/iconResolver.ts`（解析 + 缓存 + usePluginIcon hook）、
  `icons.ts` 新增 `getPluginIconComponent(icon, pluginId?)`（模块级组件缓存，内置名直返
  lucide 组件本体，消费点类型 `ComponentType<{size?, className?}>` 不变）。
- 消费点：ActivityBar / toolSwitcherData / RadialMenu / LeftPanelTabStrip(×2) / PluginTab。

## 7. 验收

- `pnpm exec tsc --noEmit` 通过；`cargo check`（src-tauri 下）通过。
- 新增 vitest：`iconResolver.test.ts`（值域规则 + 同步分类 + 文件读取 dataURL + 护栏）；
  Rust 单测：合法四类/非法逃逸样例。
- 现有镜像测试、registry 回归测试不回归（内置 18 名行为不变）。
- 冒烟（真实宿主，后续人工）：某插件 manifest 换 `"./icon.svg"`，活动栏/切换器/页签
  三处渲染出该 SVG，无 console 报错。

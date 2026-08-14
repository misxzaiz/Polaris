# DSH 引擎 MSI 安装态不可用分析

> 状态：**已分析**（2026-07）
> 关联：`engine-adapter-process-analysis` / `agent-self-service-spec`（同类 MSI 资源不可达问题）
> 分析目标：`@deepseek-ai/dsh` npm 包在 MSI 安装后 `dsh web` 无法启动，但开发模式 (`pnpm dsh`) 正常

---

## 1. 问题描述

| 场景 | `dsh web` 行为 | 备注 |
|------|---------------|------|
| 开发模式 (`pnpm dsh web`) | ✅ 正常启动，浏览器可访问 | pnpm workspace 管理依赖 |
| MSI 安装 / `npm i -g` 后 | ❌ 引擎不可用 | npm registry 安装，依赖平铺 |
| `dsh --profile headless` | ❌ 同样不可用 | 所有 profile 共享同一启动链路 |

**现象**：MSI 安装后以普通用户身份运行 `dsh web`，进程启动失败或前端无法加载。

---

## 2. 启动链路（关键路径）

```
npm bin dsh
  → lib/bin.js (预构建)
    → parseDshArgs() → resolveBoot() → mode="profile"
    → runProfile()
      → composeProfile(name="web", patchFiles=[])
        → prepareProfile()
          → healProfilesModuleFallback(INSTALL_ANCHOR)  ← ❌ 失败点
          → loadProfile()
            → resolveBundleDir()          ← 两次锚点 (install → profile)
            → read cordis.patch.yml
          → writeFileSync(cordis.yml)     ← 空根配置
      → boot()
        → mountRootInclude()
        → assertEntriesActivated()
```

`INSTALL_ANCHOR` 在构建后解析为：

```
C:\Users\<user>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\package.json
```

（MSI 安装到 `C:\Program Files\` 或其他目录时路径同理变化）

---

## 3. 根因分析

### 🔴 根因：`healProfilesModuleFallback` 创建 Junction 需要管理员特权

**位置**：`@deepseek-ai/dsh-app-boot` → `healProfilesModuleFallback(installAnchor)`（约第 409–438 行）

**行为**：

```js
function healProfilesModuleFallback(installAnchor, home) {
  const modulesDir = join(join(home, PROFILES_DIR), "node_modules");
  mkdirSync(modulesDir, { recursive: true });

  // BFS 遍历 dsh 依赖闭包（包含 peerDependencies）
  const links = new Map();
  // ... 收集所有依赖包到 links Map ...

  for (const [packageName, target] of links) {
    const link = join(modulesDir, packageName);
    mkdirSync(dirname(link), { recursive: true });
    ensureSymlink(link, target);   // ← ❌ 创建 Junction
  }
}

function ensureSymlink(link, target) {
  // ...
  symlinkSync(target, link, "junction");   // ← ❌ Windows Junction
}
```

**Windows Junction 权限要求**：

`symlinkSync(target, link, "junction")` 调用 Windows `CreateSymbolicLink` API，需要以下之一：

| 条件 | 是否默认满足 |
|------|-------------|
| 用户为管理员组成员 | ✅ 满足 |
| 启用了 **Windows 开发者模式** | ❌ 不默认开启 |
| `SeCreateSymbolicLinkPrivilege` 已分配 | ❌ 不默认分配 |

**MSI 安装后的典型场景**：
- 软件安装到 `C:\Program Files\` 或 `%AppData%`
- 用户以**普通用户身份**运行 `dsh web`
- **Windows 开发者模式未开启**（企业环境默认关闭）
- `symlinkSync("junction")` 抛出 `EPERM`（或 `EACCES`）错误
- **该错误不会被吞掉（见下方验证），直接中止 `dsh web` 启动**

> **⚠️ 验证修正**：文档初稿误判为"静默降级"。源码 `ensureSymlink`（`dsh-app-boot/lib/index.js` 行 371–386）的实际逻辑：
> ```js
> try {
>     symlinkSync(target, link, "junction");
> } catch (error) {
>     // 仅当错误码是 EEXIST 且链接已存在且指向正确 target 时才吞掉
>     if (error.code !== "EEXIST" || !lstatSync(link).isSymbolicLink()
>         || readlinkSync(link) !== target) throw error;
> }
> ```
> `EPERM` / `EACCES` **不满足吞掉条件，会重新抛出**，向上冒泡中止 `healProfilesModuleFallback`，进而中止 `profile-boot` 调用链，最终 `dsh web` 进程以非零退出码终止并打印错误栈。用户看到的是一个**响亮的启动失败**，不是静默的不完整启动。

**开发模式为何正常**：

开发模式下 pnpm workspace 已经正确建立了所有依赖的符号链接（在 `node_modules/` 下）。`healProfilesModuleFallback` 是**兜底机制**，仅在 npm 全局安装/MSI 场景下负责补齐这些链接。开发模式不依赖此兜底，因此 Junction 失败不影响。

---

### 🟡 次要风险：`resolveBundleDir` 双锚点失败（仅在 EPERM 被上层捕获时可达）

> 由于 Junction 失败是 loud 的，正常情况下流程在 `ensureSymlink` 处即中止，**不会**走到 `resolveBundleDir`。以下分析仅适用于：某次版本修改将 `healProfilesModuleFallback` 的调用包进 try/catch 而吞掉 EPERM 的场景。

`resolveBundleDir` 的行为是 **fail-loud**（源码 `dsh-app-boot/lib/index.js` 行 518–529）：

```js
function resolveBundleDir(binName, packageName, installAnchor, profileDir) {
    for (const anchor of [installAnchor, join(profileDir, "package.json")]) {
        const dir = packageDirFromAnchor(anchor, packageName);
        if (dir !== void 0) return dir;
    }
    throw new Error(`${binName}: cannot resolve profile bundle ${JSON.stringify(packageName)}
        from the dsh installation or ${profileDir}; run 'dsh plugin --profile ${basename(profileDir)} install' ...`);
}
```

两次锚点搜索：
- **锚点 1**：`INSTALL_ANCHOR`（dsh 自身 `node_modules`）— 直接依赖在此
- **锚点 2**：`profile dir/package.json` 的锚点 — 间接依赖/peerDependencies 需依赖兜底目录的 Junction

若兜底目录的 Junction 未建立（假设备注场景），直接依赖可解析成功，但 `@deepseek-ai/cordis-plugin-loader`、`@deepseek-ai/dsh-shell-env` 等间接依赖会触发上面的明确报错。

---

### 🟡 次要风险：PeerDependencies 在 npm 全局安装中的解析

`@deepseek-ai/dsh-web-app` 声明：

```json
"peerDependencies": {
  "@deepseek-ai/dsh-shell-env": "^0.1.0-rc.6",
  "@deepseek-ai/dsh-system-prompt": "^0.1.0-rc.6",
  "@deepseek-ai/dsh-invariants": "^0.1.0-rc.6",
  "@deepseek-ai/cordis": "^4.0.1"
}
```

npm 全局安装时：
- 如果 `peerDependencies` 在父包（`@deepseek-ai/dsh`）的 `dependencies` 中已出现 → ✅ npm 会安装
- 如果未出现 → ⚠️ 包可能缺失，`resolveBundleDir` 在锚点 1 也找不到
- 兜底目录中的 Junction 本应补足这一缺口 → ❌ 但 Junction 创建失败

`dsh-base` 的 `dependencies` 中列出了绝大多数 peerDependencies，所以 npm 全局安装通常包含它们。但这是**隐式假设**，不是显式保证。

---

### 🟡 次要风险：原生模块平台兼容性

| 包 | 风险 |
|----|------|
| `node-addon-require-builtin` | 依赖原生 addon，需与 Node.js 版本匹配 |
| `node-pty`（仅 TUI profile） | 原生模块，Windows 需特定 DLL |
| `node:pty` | MSI 捆绑的 Node.js 版本若与编译时不同 → 加载失败 |

MSI 通常捆绑 Node.js 二进制。如果 MSI 中 Node.js 版本与 npm 安装时的 ABI 不匹配，原生模块会加载失败。

---

### 🟡 次要风险：pnpm 不可用

`dsh plugin` 子命令将参数转发给 `pnpm`。MSI 安装若未捆绑 pnpm，用户无法管理 profile 插件。但不影响基础 `dsh web` 启动。

---

## 4. 同类问题先例

Polaris 内部已有同类问题记录（`docs/agent-self-service-spec.md`）：

> **内置 corpus 在 MSI 安装态读不出来** — `resolve_resources_agents_dir` 四条路径全部 miss → 回退 `CARGO_MANIFEST_DIR` 编译机绝对路径 → 用户机器不存在。**已判定为完全不可用**。

模式完全一致：**打包时依赖构建机上的相对路径或绝对路径，运行时在用户机器上找不到**。DSH 的 Junction 问题也是"构建时能建立，运行时不能建立"的变体。

---

## 5. 验证方法

在 MSI 安装后的机器上，以**普通用户身份**依次执行：

```powershell
# 1. 复现
dsh --profile web 2>&1

# 2. 检查 profile 目录结构
Get-ChildItem "$env:USERPROFILE\.dsh\profiles" -Name

# 3. 检查兜底目录是否包含符号链接
Get-ChildItem "$env:USERPROFILE\.dsh\profiles\node_modules" -Name

# 4. 验证 Junction 创建权限
$testLink = "$env:USERPROFILE\.dsh\profiles\node_modules\test-link"
$result = & powershell -Command "New-Item -ItemType Junction -Path '$testLink' -Target '$env:USERPROFILE' -ErrorAction SilentlyContinue; if (Test-Path '$testLink') { 'JUNCTION_OK' } else { 'JUNCTION_DENIED' }" 2>&1
Write-Host $result
Remove-Item $testLink -Force -ErrorAction SilentlyContinue

# 5. 检查 dsh-web-frontend dist 是否存在
Get-ChildItem "C:\Program Files\<dsh>\node_modules\@deepseek-ai\dsh-web-frontend\dist" -Name
# 开发模式：node_modules 下 dist 通过 pnpm 链接正确
# MSI 模式：需确认 dist 目录被 npm 完整安装
```

---

## 6. 解决方案

### 方案 A：将 symlink 降级为 copy（推荐）

在 `healProfilesModuleFallback` 中，Junction 创建失败时自动回退到**复制目录**（硬链接或软拷贝）：

```js
// 在 healProfilesModuleFallback 的循环中，对每个包先尝试 junction，失败则降级为复制
for (const [packageName, target] of links) {
    const link = join(modulesDir, packageName);
    mkdirSync(dirname(link), { recursive: true });
    try {
        ensureSymlink(link, target);   // 原始逻辑：尝试创建 Junction
    } catch (error) {
        if (error.code === "EPERM" || error.code === "EACCES") {
            // ✅ 降级：复制目标目录内容（或记录警告并跳过，依赖锚点 1 解析）
            console.warn(`dsh: junction failed for ${packageName}: ${error.code}, skipping`);
        } else {
            throw error;
        }
    }
}

// ensureSymlink 本身保持不变（仅吞掉 EEXIST）
function ensureSymlink(link, target) {
    let stat;
    try { stat = lstatSync(link); } catch { stat = void 0; }
    if (stat !== void 0 && !stat.isSymbolicLink()) {
        throw new Error(`dsh: ${link} exists and is not a symlink`);
    }
    if (stat?.isSymbolicLink() && readlinkSync(link) === target) return;
    if (stat) unlinkSync(link);
    try {
        symlinkSync(target, link, "junction");
    } catch (error) {
        if (error.code !== "EEXIST" || !lstatSync(link).isSymbolicLink()
            || readlinkSync(link) !== target) throw error;
    }
}
```

**优点**：不需要任何系统权限，兼容性最好。
**缺点**：增加磁盘占用；包更新后需要重建。

### 方案 B：跳过兜底，依赖 npm 自身结构

`healProfilesModuleFallback` 的核心目的是让 profile 目录下的 `node_modules` 能解析到 dsh 的依赖。如果 npm 全局安装后 `INSTALL_ANCHOR` 的 `node_modules` 中已经包含所有依赖，则**不需要兜底目录**。

```js
// 如果 npm 平铺结构中锚点 1 已包含所有依赖，跳过兜底目录的创建
// 在 resolveBundleDir 中增加一条锚点：INSTALL_ANCHOR 的直接父级 node_modules
```

**优点**：零副作用。
**缺点**：依赖 npm 的依赖解析结果，peerDependencies 可能缺失。

### 方案 C：MSI 安装时预创建 Junction

在 MSI 安装脚本中，以**管理员权限**（MSI 安装进程本身就是管理员）创建 Junction：

```powershell
# MSI 安装脚本中（管理员权限）
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh" -Target "C:\Program Files\Dsh\...\@deepseek-ai\dsh"
```

**优点**：不修改 DSH 源码。
**缺点**：需要修改 MSI 打包脚本；用户手动创建 profile 后仍需建立 Junction。

### 方案 D：文档化 workaround（最低成本）

在 MSI 安装说明中增加提示：

```
首次运行 dsh web 前，请确保已开启 Windows 开发者模式：
设置 → 隐私与安全 → 开发者选项 → 启用"开发者模式"
或请以管理员身份运行 PowerShell 执行一次 dsh web。
```

---

## 7. 推荐策略

| 优先级 | 方案 | 说明 |
|--------|------|------|
| **P0** | 方案 A（降级为 copy） | 在 DSH 源码中增加 Junction 失败降级，兼容所有用户 |
| P1 | 方案 D（文档 workaround） | 短期缓解，配合 P0 一起发布 |
| P2 | 方案 B（依赖 npm 结构） | 长期优化，减少兜底机制依赖 |
| — | 方案 C（MSI 预创建） | 仅当 DSH 源码修改受阻时采用 |

---

## 8. 关联文档

- [engine-adapter-process-analysis.md](../engine-adapter-process-analysis.md) — 引擎适配器进程化方案
- [agent-self-service-spec.md](../agent-self-service-spec.md) — MSI 态内置 corpus 不可达（同类问题）
- [ai-engine-refactor-plan.md](../design/ai-engine-refactor-plan.md) — AI 引擎子系统重构方案

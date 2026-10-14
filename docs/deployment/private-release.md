# 私有构建仓库发布规范（polaris-x）

> 目的：在**公开仓库（misxzaiz/Polaris）不可见**的私有仓库中先行构建并验证 Release 产物，
> 文档成熟后再把发布动作落到公开仓库。本文档规范私有构建仓库 `misxzaiz/polaris-x`
> 的创建、secrets 注入、版本发布、产物搬运与回灌流程。
>
> 依据：`docs/deployment/github-release.md`（公开仓库发布指南）；三个发布工作流
> `.github/workflows/release.yml` / `release-web.yml` / `release-apk.yml` 均**未硬编码仓库名**，
> 产物上传目标 = 工作流运行所在仓库，因此双仓库机制成立。

## 1. 角色与边界

| 仓库 | 可见性 | 用途 |
|---|---|---|
| `misxzaiz/Polaris` | **public** | 正式版本文档、正式 Release（对外可见） |
| `misxzaiz/polaris-x` | **private** | 提前构建 + 验证产物，全程不公开 |

铁律：

- **polaris-x 只当构建场，零代码改动**。任何改动（版本号、配置、源码）都必须回灌公开仓库后，
  再在 polaris-x 重放同一 commit 或直接推送同一 commit，确保两边 tag 指向同一源码。
- **polaris-x 的 main 必须始终与公开仓库 main 同点**。每次发布前先校验：
  ```bash
  git fetch origin main polaris-x main
  git rev-parse origin/main    # 公开仓库基线
  git rev-parse polaris-x/main # 私有仓库当前
  # 两者不一致时：若 polaris-x 超前（私有仓库被推了未公开 commit），把 polaris-x main
  # 强制重置到公开基线（git push polaris-x origin/main:main --force，见 §7）；
  # 若公开仓库领先，则 git push polaris-x origin/main:main 快进同步。
  # 严禁在 polaris-x 上出现公开仓库不存在的源码提交后打 tag 发布——产物会包含未公开代码。
  ```
- 不得在 polaris-x 改动 `src/services/updateService.ts` 的仓库指向、`src-tauri/tauri*.conf.json`
  的 updater 端点——否则产物与公开源码漂移，回灌后无法自洽。
- 两边的 tag 与 Release **互不冲突**（GitHub tag/Release 为仓库级命名空间）。

## 2. 一次性初始化（已执行于 2026-10-14，供复盘）

```bash
# 0) 前置检查
gh auth status        # 需要 token scope: repo, workflow
git -C /d/space/base/Polaris remote -v

# 1) 创建私有仓库
gh repo create misxzaiz/polaris-x --private --source=/d/space/base/Polaris --push
#   等价于：gh repo create misxzaiz/polaris-x --private
#          git remote add polaris-x git@github.com:misxzaiz/polaris-x.git
#          git push --all polaris-x && git push --tags polaris-x
#   --source --push 会把全量 commit + tags 一起推上去（含 v9.9.7 ~ v10.6.4 全部历史 tag）

# 2) 注入 Secrets（见 §3 清单）—— 已注入 5 个，缺失 1 个（TAURI_SIGNING_PRIVATE_KEY_PASSWORD，无明文）
```

> 注意：`gh repo create --source --push` 推的是**当时本地仓库**的分支与 tags。
> 2026-10-14 执行时，本地 main 领先公开仓库 37 个 commit（sky 前端回归 + session Revert 撤销链），
> 导致 polaris-x 的 main **超前于公开仓库**。此后已把 polaris-x main 重置回公开基线（见 §7），
> 发布前务必按 §1 铁律重新校验两侧 main 同点。

## 3. Secrets 清单（GitHub 只写不读，必须在每个仓库分别配置）

进入 **polaris-x → Settings → Secrets and variables → Actions → New repository secret**。
公开仓库已有的 6 个 Secret **不能复制**，需在 polaris-x 重新注入（值相同）：

| Secret | 值来源 | 用途 |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | `~/.tauri/polaris.key` 文件完整内容（含换行） | release.yml 桌面端签名 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 生成 polaris.key 时设置的密码（本地无明文，见 §3.1） | 同上 |
| `POLARIS_KEYSTORE_BASE64` | `secrets/polaris-release.jks` 的 base64（本地生成，见 §3.2） | release-apk.yml 回灌 keystore |
| `POLARIS_KEYSTORE_PASSWORD` | keystore storepass（本地无明文） | 同上 |
| `POLARIS_KEY_PASSWORD` | keystore keypass（本地无明文） | 同上 |
| `POLARIS_KEY_ALIAS` | keystore 别名（本地无明文） | 同上 |

> Secrets 值必须与公开仓库**完全一致**，产物签名指纹才一致，搬运后才可覆盖安装。

### 3.1 本地可生成的值

```bash
# 桌面签名私钥（完整内容）
cat ~/.tauri/polaris.key

# APK keystore base64（keystore 在 secrets/ 目录，已被 .gitignore 排除、未入库）
base64 -w0 /d/space/base/Polaris/secrets/polaris-release.jks
```

### 3.2 本地无明文、必须人工提供的值

以下值本地**没有**明文（历史上仅存在于公开仓库 Secrets / 生成时记忆）：

- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（生成 polaris.key 时设置）
- `POLARIS_KEYSTORE_PASSWORD` / `POLARIS_KEY_PASSWORD` / `POLARIS_KEY_ALIAS`
  （生成 `secrets/polaris-release.jks` 时设置）

> 提醒：`~/.tauri/polaris-updater.key.password.txt` 是**另一对**（updater 密钥，公钥
> `F6659297C364449B`），**不是** polaris.key 的密码，勿混用。
> 若私钥密码确实遗失：TAURI 私钥无法找回，只能重新 `npx tauri signer generate` 生成新对，
> 同步更新 tauri.conf.json 的 pubkey 与公开仓库 Secrets —— 旧版本自动更新将全部失效
> （当前 `createUpdaterArtifacts=false`，影响有限）。keystore 密码遗失同理需重建并重签。

### 3.3 验证 secrets 已注入

```bash
gh secret list -R misxzaiz/polaris-x
# 应看到 6 个名称（GitHub 不显示值，只显示是否已设置）
```

> **状态（2026-10-14）**：已注入 5 个（`POLARIS_KEYSTORE_BASE64` / `POLARIS_KEYSTORE_PASSWORD` /
> `POLARIS_KEY_ALIAS` / `POLARIS_KEY_PASSWORD` / `TAURI_SIGNING_PRIVATE_KEY`）。
> **`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 缺失**——密码无明文，需人工提供（见 §3.2）。
>
> **禁止占位假值**：绝不能用占位字符串（如 `***PLACEHOLDER***`）填充 secret 后留着——
> 一旦忘记替换，release.yml 会用假密码签名，产物自更新校验全部失败，且误以为已配置。
> 缺失就保持缺失，`gh secret list` 看不到即代表未配置，打包时跳过签名（可完成、无自动更新）或
> 人工补齐后再发布。若误填了占位值，立即 `gh secret delete <NAME> -R misxzaiz/polaris-x` 删除。

## 4. 在 polaris-x 发布版本（流程）

```bash
cd /d/space/base/Polaris
# 1) 更新版本号（package.json + src-tauri/tauri.conf.json，公开仓库提交）
git add package.json src-tauri/tauri.conf.json
git commit -m "chore: release v10.6.5"
git push origin main          # 先回公开仓库，保证 main 同步

# 2) 同步到 polaris-x（重放同一 commit，不产生第二个 commit）
git push polaris-x main

# 3) 在 polaris-x 打 tag 触发构建
git tag v10.6.5
git push polaris-x v10.6.5

# 4) 等待三个工作流（Release / Release Web / Release APK）完成，见 §5 验证
```

> 注意第 3 步在 polaris-x 打的 tag **不要** push 到公开仓库 origin ——
> 公开仓库 tag 的推送时机 = 正式发布时刻（见 §6）。

## 5. 产物验证（polaris-x，全程私有）

| 工作流 | 验证点 |
|---|---|
| Release（桌面端） | Draft Release 含 `polaris_10.6.5_x64-setup.exe` 与 `.msi`；本地安装冒烟 |
| Release Web | `polaris-web-10.6.5-*.zip/tar.gz` 三平台齐 |
| Release APK | `polaris-mobile-10.6.5.apk`；工作流内置「签名指纹 + versionCode」双断言已绿 |

- 所有产物均为 **Draft Release**（`releaseDraft: true`），对仓库外不可见。
- 桌面端签名密钥/keystore 与公开仓库一致 → 安装包指纹与已发布的旧版本一致，可覆盖安装。
- 验证未通过的产物直接删掉 Draft 重来，公开仓库无任何痕迹。

## 6. 正式公开（公开仓库发布）

公开仓库发布 = 在 `misxzaiz/Polaris` 出现 tag。触发条件为 `push: tags: 'v*'`，
**无法区分搬运与正式发布**，公开后三个工作流必然再构建一遍。三条路径：

1. **接受双份构建（推荐）**：公开仓库正常 push tag，三个工作流重跑，产物与 tag 源码严格一致、可审计。
   public repo 的 Actions 免费，代价仅为 10~30 分钟时间。
2. **网页端临时 Disable 三个 workflow** → 公开仓库 push tag + `gh release create` +
   `gh release upload` 搬运 polaris-x 产物 → 验证后重新 Enable。不留代码痕迹，需手动搬运。
3. 改触发条件再提交——会让 tag 指向的 commit 包含发布配置改动，**不推荐**。

公开发布后补版本文档（`docs/deployment/github-release.md` 增加构建记录）：
文档 commit 不含 tag，不触发任何 release 工作流，无冲突。

### 搬运命令（路径 2 用）

```bash
cd /d/space/base/Polaris
git push origin v10.6.5                # 先推 tag 到公开仓库（默认触发工作流，若已 Disable 则只建 tag）
gh release create v10.6.5 --title "Polaris v10.6.5" --notes "..." --draft
gh release upload v10.6.5 <polaris-x 下载的产物路径...>
gh release edit v10.6.5 --draft=false  # 校验后正式公开
```

## 7. 注意与边界

- **私有仓库分发限制**：polaris-x 的 Release 产物需登录 + 仓库权限才能下载；
  私下分发安装包请加协作者或自建中转。
- **Actions 额度**：private repo 免费 2000 分钟/月，一次三工作流约 60~150 分钟，频繁发布注意余额。
- **公开仓库 Secrets 不自动同步**：若公开仓库换了签名密钥/keystore，polaris-x 需同步重配。
- **两边 tag 漂移**：任何一次发布后，`git push polaris-x main` 必须紧跟公开仓库 main，
  防止 `PREV_TAG` 计算与源码基线错位。

### 7.1 重置 polaris-x main 到公开基线（当私有仓库超前时）

仅当 polaris-x 的 main 领先公开仓库（含未公开 commit）时执行，强制对齐，**不 merge、不保留本地超前提交**：

```bash
# 前置：确认公开仓库基线（例如 2cd8bc99）
git fetch origin main polaris-x main
BASE=$(git rev-parse origin/main)

# 校验本地无未提交改动（只重置远端指针，不碰本地工作区）
git status --short

# 强制推送公开基线到 polaris-x main（--force 覆盖私有仓库超前指针）
git push polaris-x "$BASE:main" --force

# 校验两侧一致
git rev-parse origin/main
git ls-remote polaris-x refs/heads/main
```

> 该操作**改写 polaris-x 远端分支指针**，被覆盖的提交仍留在 GitHub 的 reflog 中可找回，
> 但属破坏性操作——执行前确认无人在私有仓库上并行工作。
> 本地工作区/本地 main 不受影响（它们仍可能领先，属另一议题，由人工决定是否合并到公开仓库）。

### 7.2 本机验证前置

- 本机 `cargo test --lib` 不可用（Tauri DLL 限制），发布前验证以 `cargo check` +
  前端 vitest 为准（见根目录 AGENTS.md）。

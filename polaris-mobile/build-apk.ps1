#!/usr/bin/env pwsh
# Polaris Mobile APK 一键打包脚本（可提交，不含任何明文密码）
#
# 用法:
#   .\build-apk.ps1                    # 按当前版本打包 arm64 release APK
#   .\build-apk.ps1 -Version 10.9.0    # 先同步移动端版本号, 再打包
#   .\build-apk.ps1 -NoFrontend        # 跳过前端构建（.so 不重嵌，仅重编 native）
#   .\build-apk.ps1 -Clean             # 先清 jniLibs + gradle build 缓存
#
# 流程（与 AGENTS.md §七 验证清单对齐）:
#   [0] 前置检查: SDK / NDK / Rust target / JDK
#   [1] 前端构建: pnpm build + 同步 dist 到 polaris-mobile/dist     (build-dist.mjs)
#   [2] 重编译 .so: touch build.rs → cargo build --target aarch64-linux-android
#       (不重编 .so 则 APK 内嵌旧前端 —— 见记忆 apk-embed-stale-so-rootcause)
#   [3] 拷贝 .so → gen/android/app/src/main/jniLibs/arm64-v8a/
#   [4] gradle :app:assembleArm64Release (release 签名)
#   [5] 验证: 签名指纹 / versionName / APK 内 .so 与 jniLibs hash 一致
#
# ==== 签名凭据（敏感信息，不要提交到版本库）====
# 脚本从以下路径自动读取，任一缺失会在启动时打印缺失项并生成模板：
#   <仓库根>/temp/android-release-keystore/polaris-release.jks   # JKS keystore 文件
#   <仓库根>/temp/android-release-keystore/.env                  # 凭据文件（.gitignore 覆盖）
#
# .env 文件内容格式（三行，键名固定）：
#   POLARIS_KEYSTORE_PASSWORD=<storepass>
#   POLARIS_KEY_PASSWORD=<keypass>
#   POLARIS_KEY_ALIAS=<alias>
#
# 首次使用，keystore 不存在时脚本会用上述 .env 凭据现场生成：
#   keytool -genkeypair -alias <alias> -keyalg RSA -keysize 2048 -validity 10000
#   -keystore polaris-release.jks -storepass <storepass> -keypass <keypass>
#
# 注意: temp/ 已被根 .gitignore 覆盖（temp/），此目录不会被版本库收录；
#      脚本本身也不含任何密码，可以安全提交。
#
# 环境要求: JDK 17+ / Android SDK + NDK 26.x / Rust target aarch64-linux-android
#      见记忆 apk-release-keystore-location / polaris-mobile-android

param(
    [string]$Version,
    [switch]$NoFrontend,
    [switch]$Clean
)

$ErrorActionPreference = "Continue"

# ---- 路径推导（基于脚本自身位置，不依赖 cwd）----
$RepoRoot   = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$MobileDir  = $PSScriptRoot
$TauriDir   = Join-Path $MobileDir "src-tauri"
$AndroidDir = Join-Path $TauriDir "gen\android"
$JniDir     = Join-Path $AndroidDir "app\src\main\jniLibs\arm64-v8a"
$TargetDir  = Join-Path $TauriDir "target\aarch64-linux-android\release"
$ApkPath    = Join-Path $AndroidDir "app\build\outputs\apk\arm64\release\app-arm64-release.apk"

$KeystoreDir = Join-Path $RepoRoot "temp\android-release-keystore"
$KeystoreFile = Join-Path $KeystoreDir "polaris-release.jks"
$CredsFile    = Join-Path $KeystoreDir ".env"

# ---- 前置检查：SDK / NDK / Rust target / JDK ----
# 注意：不用 $ErrorActionPreference="Stop" —— java/rustup 等 native 命令会向
# stderr 写正常输出，被 PowerShell 误判为错误而中断脚本。native 失败由 $LASTEXITCODE 兜底。
$ErrorActionPreference = "Continue"
$failures = @()
if (-not $env:ANDROID_HOME -and -not (Test-Path "D:\Android\Sdk")) {
    $failures += "ANDROID_HOME 未设置且未找到 D:\Android\Sdk"
}
$ndkDir = Join-Path $env:ANDROID_HOME "ndk\26.1.10909125"
if ($env:ANDROID_HOME -and -not (Test-Path $ndkDir)) {
    # 允许其他 NDK 版本，仅警告
    Write-Host "⚠ NDK 26.1.10909125 未在 $env:ANDROID_HOME\ndk\ 找到，将尝试自动探测" -ForegroundColor Yellow
}
$rustTarget = (rustup target list --installed 2>$null | Select-String "aarch64-linux-android").Count
if ($rustTarget -eq 0) {
    $failures += "Rust target aarch64-linux-android 未安装（rustup target add aarch64-linux-android）"
}
# JDK 检查：用 Get-Command 而非运行 java -version（后者向 stderr 写版本号，会触发 native 错误）
if (-not (Get-Command java -ErrorAction SilentlyContinue)) {
    $failures += "JDK 未找到（PATH 中无 java）"
}
if ($failures.Count -gt 0) {
    foreach ($f in $failures) { Write-Host "❌ $f" -ForegroundColor Red }
    exit 1
}

# ---- 读取签名凭据 ----
if (-not (Test-Path $KeystoreDir)) {
    Write-Host "⚠ 签名目录不存在，正在创建: $KeystoreDir" -ForegroundColor Yellow
    New-Item -ItemType Directory -Path $KeystoreDir -Force | Out-Null
}

if (-not (Test-Path $CredsFile)) {
    # 生成模板（占位符，需用户手动填写）
    $text = @'
# Polaris Mobile APK 签名凭据（本文件在 temp/ 下，已被 .gitignore 覆盖，不会被提交）
# 填写后重跑 build-apk.ps1；keystore 不存在时脚本会自动用这些凭据生成。

POLARIS_KEYSTORE_PASSWORD=your_storepass_here
POLARIS_KEY_PASSWORD=your_keypass_here
POLARIS_KEY_ALIAS=polaris
'@
    # 无 BOM 写入（PowerShell 5.x Set-Content -Encoding UTF8 会注入 BOM，破坏文件）
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($CredsFile, $text, $utf8NoBom)
    Write-Host ""
    Write-Host "❌ 未找到凭据文件，已生成模板：" -ForegroundColor Red
    Write-Host "   $CredsFile" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "需要提供的凭据：" -ForegroundColor Yellow
    Write-Host "   1. POLARIS_KEYSTORE_PASSWORD  — keystore 存储密码" -ForegroundColor Yellow
    Write-Host "   2. POLARIS_KEY_PASSWORD       — 私钥密码" -ForegroundColor Yellow
    Write-Host "   3. POLARIS_KEY_ALIAS          — 密钥别名（通常用 polaris）" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "keystore 文件放在：$KeystoreFile" -ForegroundColor Yellow
    Write-Host "   若已持有 keystore 则直接拷贝到此路径；" -ForegroundColor Yellow
    Write-Host "   若没有，脚本会自动用上述 .env 凭据生成新的 keystore（含 keytool 命令）。" -ForegroundColor Yellow
    exit 1
}

# 解析 .env
$envLines = Get-Content $CredsFile | Where-Object { $_ -match '^\s*POLARIS_' -and $_ -notmatch '^\s*#' }
foreach ($line in $envLines) {
    $pair = $line -split '=', 2
    if ($pair.Count -eq 2) {
        Set-Item "env:$($pair[0])" $pair[1]
    }
}
$storePass = $env:POLARIS_KEYSTORE_PASSWORD
$keyPass   = $env:POLARIS_KEY_PASSWORD
$alias     = $env:POLARIS_KEY_ALIAS
if (-not $storePass -or -not $keyPass -or -not $alias) {
    Write-Host "❌ 凭据文件不完整，需要三行：" -ForegroundColor Red
    Write-Host "   POLARIS_KEYSTORE_PASSWORD=..." -ForegroundColor Yellow
    Write-Host "   POLARIS_KEY_PASSWORD=..." -ForegroundColor Yellow
    Write-Host "   POLARIS_KEY_ALIAS=..." -ForegroundColor Yellow
    exit 1
}

# 自动创建 keystore（若不存在）
if (-not (Test-Path $KeystoreFile)) {
    Write-Host "⚠ keystore 不存在，正在生成..." -ForegroundColor Yellow
    $dn = "CN=Polaris Mobile, OU=Mobile, O=Polaris, L=Shenzhen, C=CN"
    & keytool -genkeypair -alias $alias -keyalg RSA -keysize 2048 -validity 10000 `
        -keystore $KeystoreFile -storepass $storePass -keypass $keyPass -dname $dn
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ keystore 生成失败，检查密码是否正确" -ForegroundColor Red
        exit 1
    }
    Write-Host "   keystore 已生成: $KeystoreFile" -ForegroundColor Green
}

# 导出签名环境变量供 gradle 使用
$env:POLARIS_KEYSTORE_FILE = $KeystoreFile
$env:POLARIS_KEYSTORE_PASSWORD = $storePass
$env:POLARIS_KEY_PASSWORD = $keyPass
$env:POLARIS_KEY_ALIAS = $alias

# ---- 可选：同步移动端版本号 ----
if ($Version) {
    if ($Version -notmatch '^\d+\.\d+\.\d+$') {
        Write-Host "❌ 版本号格式应为 x.y.z (如 10.9.0)" -ForegroundColor Red
        exit 1
    }
    Write-Host "==> 同步移动端版本号 -> $Version"
    $parts = $Version -split '\.'
    # versionCode = 主×1e6 + 次×1e3 + 修（如 10.9.0 → 10009000），与旧版 10008001 格式对齐
    $vc = ([int]$parts[0] * 1000000) + ([int]$parts[1] * 1000) + [int]$parts[2]
    $vc = "$vc"
    $confJson = Join-Path $TauriDir "tauri.conf.json"
    $json = Get-Content $confJson -Raw
    $json = $json -replace '"version":\s*"\d+\.\d+\.\d+"', "`"version`": `"$Version`""
    # 无 BOM 写回（Set-Content -Encoding UTF8 会注入 BOM，serde JSON 解析会失败）
    [System.IO.File]::WriteAllText($confJson, $json, (New-Object System.Text.UTF8Encoding($false)))
    $propsFile = Join-Path $AndroidDir "app\tauri.properties"
    @'
tauri.android.versionName=__V__
tauri.android.versionCode=__VC__
'@ -replace '__V__', $Version -replace '__VC__', $vc | Set-Content $propsFile -Encoding ASCII
    Write-Host "   versionName=$Version  versionCode=$vc"
}

# ---- 可选：清理 ----
if ($Clean) {
    Write-Host "==> 清理 jniLibs 与 gradle build 缓存"
    if (Test-Path (Join-Path $JniDir "libpolaris_mobile_lib.so")) {
        Remove-Item (Join-Path $JniDir "libpolaris_mobile_lib.so") -Force
    }
    $buildDir = Join-Path $AndroidDir "app\build"
    if (Test-Path $buildDir) { Remove-Item $buildDir -Recurse -Force }
}

# ---- [1] 前端构建 ----
if (-not $NoFrontend) {
    Write-Host "==> [1] 构建最新前端 (pnpm build + 同步 polaris-mobile/dist)"
    Push-Location $MobileDir
    try {
        node build-dist.mjs
        if ($LASTEXITCODE -ne 0) { Write-Host "❌ 前端构建失败" -ForegroundColor Red; exit 1 }
    } finally { Pop-Location }
} else {
    Write-Host "==> [1] 跳过前端构建（-NoFrontend）" -ForegroundColor Yellow
}

# ---- [2] 重编 .so ----
Write-Host "==> [2] 重编译 libpolaris_mobile_lib.so (内嵌最新 dist)"
Push-Location $TauriDir
try {
    (Get-Item build.rs).LastWriteTime = Get-Date
    cargo build --target aarch64-linux-android --release
    if ($LASTEXITCODE -ne 0) { Write-Host "❌ cargo build 失败" -ForegroundColor Red; exit 1 }
} finally { Pop-Location }

# ---- [3] 拷贝 .so ----
Write-Host "==> [3] 拷贝 .so → jniLibs"
$soSrc = Join-Path $TargetDir "libpolaris_mobile_lib.so"
if (-not (Test-Path $soSrc)) {
    Write-Host "❌ 未找到 .so: $soSrc" -ForegroundColor Red; exit 1
}
Copy-Item $soSrc -Destination $JniDir -Force
$soJniHash = (Get-FileHash (Join-Path $JniDir "libpolaris_mobile_lib.so") -Algorithm SHA256).Hash
Write-Host "   jniLibs hash: $soJniHash"

# ---- [4] gradle assemble ----
Write-Host "==> [4] gradle :app:assembleArm64Release (release 签名)"
Push-Location $AndroidDir
try {
    .\gradlew.bat :app:assembleArm64Release --rerun-tasks
    if ($LASTEXITCODE -ne 0) { Write-Host "❌ gradle 构建失败" -ForegroundColor Red; exit 1 }
} finally { Pop-Location }

# ---- [5] 验证 ----
Write-Host "==> [5] 验证"
$buildTools = Get-ChildItem (Join-Path $env:ANDROID_HOME "build-tools") -Directory | Sort-Object Name -Descending | Select-Object -First 1
if (-not $buildTools) { $buildTools = Get-ChildItem "D:\Android\Sdk\build-tools" -Directory | Sort-Object Name -Descending | Select-Object -First 1 }
$apksigner = Join-Path $buildTools.FullName "apksigner.bat"
$aapt = Join-Path $buildTools.FullName "aapt.exe"

$certs = & $apksigner verify --print-certs $ApkPath 2>$null
$certs | Where-Object { $_ -match "SHA-256" } | ForEach-Object { Write-Host "   签名: $_" }

$badging = & $aapt dump badging $ApkPath 2>$null
$badging | Where-Object { $_ -match "versionName=" } | ForEach-Object { Write-Host "   版本: $_" }

# APK 内 .so hash 对比（jar xf 对 Windows 路径分隔符敏感，改用 System.IO.Compression）
$apkSoCheck = Join-Path $env:TEMP "polaris-apk-so-check"
Remove-Item $apkSoCheck -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $apkSoCheck -Force | Out-Null
try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($ApkPath)
    $entry = $zip.Entries | Where-Object { $_.FullName -eq "lib/arm64-v8a/libpolaris_mobile_lib.so" }
    if ($entry) {
        $outFile = Join-Path $apkSoCheck "libpolaris_mobile_lib.so"
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $outFile, $true)
    }
    $zip.Dispose()
} catch {
    Write-Host "   ⚠ 提取 APK 内 .so 失败: $($_.Exception.Message)" -ForegroundColor Yellow
}
$soApkFile = Join-Path $apkSoCheck "libpolaris_mobile_lib.so"
if (Test-Path $soApkFile) {
    $soApkHash = (Get-FileHash $soApkFile -Algorithm SHA256).Hash
    Remove-Item $apkSoCheck -Recurse -Force -ErrorAction SilentlyContinue
}
if ($soApkHash -eq $soJniHash) {
    Write-Host "   .so 一致性: OK ($soJniHash)" -ForegroundColor Green
} else {
    Write-Host "   ⚠ .so hash 不一致! APK=$soApkHash  jniLibs=$soJniHash" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "✅ 打包完成: $ApkPath" -ForegroundColor Green

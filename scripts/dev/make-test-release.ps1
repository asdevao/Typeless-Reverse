# 打一个"离线测试包"给别人试：把当前这台机器上实测能跑的运行目录（versions\<当前版本>）
# 按发布布局（scripts/release/release-layout.mjs）摆好，配上 install.ps1，压成一个 zip 发出去。
# 收到的人解压后双击 安装.bat 就装进 %USERPROFILE%\.speakmore，跟正式安装走的是同一个安装脚本。
#
# 包里只有程序：app\（代码、依赖、编好的小帮手）和 runtime\（Electron）。
# 你的 key、设置、录音、模型缓存都在 .speakmore 根下，不在这个目录里，天然不会被打进去。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev\make-test-release.ps1
# 产物：dist\test-release\Utterly-测试包.zip

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Home0 = Join-Path $env:USERPROFILE ".speakmore"

# 用的是哪一个版本：current 里记着
$Current = (Get-Content -Raw -Encoding UTF8 (Join-Path $Home0 "current")).Trim()
$Version = $Current -replace '-\d+$', ""          # 0.9.4-utterly-1 → 0.9.4
$Running = Join-Path $Home0 "versions\$Current"
if (-not (Test-Path (Join-Path $Running "app"))) { throw "运行目录不存在：$Running" }

$Out = Join-Path $RepoRoot "dist\test-release"
$Layout = Join-Path $Out "release"                # 发布布局：install.ps1 + latest + v<版本>/
$VersionDir = Join-Path $Layout "v$Version"
$Archive = "speakmore-win32-x64.zip"

Write-Host "打包 $Current → $Out"
Remove-Item -Recurse -Force $Out -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $VersionDir | Out-Null

# 程序目录拷出来，剔掉运行时缓存（Electron 的 Cache 之类谁都不需要）
$Stage = Join-Path $env:TEMP ("utterly-pack-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force -Path (Join-Path $Stage "app") | Out-Null
robocopy (Join-Path $Running "app") (Join-Path $Stage "app") /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "复制 app 失败（robocopy 退出码 $LASTEXITCODE）" }
foreach ($junk in @("Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "logs")) {
  Remove-Item -Recurse -Force (Join-Path $Stage "app\$junk") -ErrorAction SilentlyContinue
}
# 小帮手是编译产物，指纹也要带上（不然别人机器上会去现编，而他们没有 Go）
if (-not (Test-Path (Join-Path $Stage "app\build\key-helper.exe"))) { throw "包里没有编好的小帮手（app\build\key-helper.exe）" }

# runtime 原样拷（Electron，360 多兆）
robocopy (Join-Path $Running "runtime") (Join-Path $Stage "runtime") /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "复制 runtime 失败（robocopy 退出码 $LASTEXITCODE）" }

# 压成发布布局要的那个 zip
$Zip = Join-Path $VersionDir $Archive
Compress-Archive -Path (Join-Path $Stage "*") -DestinationPath $Zip -Force

# 校验文件（sha256，格式同 shasum -a 256）、latest、安装脚本
$Hash = (Get-FileHash $Zip -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -Encoding ASCII -Path "$Zip.sha256" -Value "$Hash  $Archive"
Set-Content -Encoding ASCII -Path (Join-Path $Layout "latest") -Value "v$Version"
Copy-Item (Join-Path $RepoRoot "install.ps1") $Layout

Remove-Item -Recurse -Force $Stage -ErrorAction SilentlyContinue

# 最后压成一个发给别人的包：安装脚本 + 布局 + 一个双击就装的 bat
$Bat = Join-Path $Out "安装.bat"
Set-Content -Encoding UTF8 -Path $Bat -Value @"
@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "SPEAKMORE_INSTALL_BASE=%~dp0release"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0release\install.ps1"
pause
"@
$Final = Join-Path $Out "Utterly-测试包-win64.zip"
Compress-Archive -Path (Join-Path $Out "release"), $Bat -DestinationPath $Final -Force
Write-Host ""
Write-Host "完成：$Final"
Write-Host "发给别人的话：发这一个 zip 就行。解压后双击「安装.bat」。"

# Codex 메모 설치·업데이트
# 사용법 (PowerShell):  irm https://raw.githubusercontent.com/plushg0724-web/codex-memo-public/main/install.ps1 | iex
# - Python, Node.js 가 없으면 winget 으로 설치
# - 최신 릴리스를 %LOCALAPPDATA%\Programs\CodexMemo 에 받고 필요한 패키지 설치
# - 바탕화면·시작 메뉴 바로가기를 만들고 실행
# 메모·설정은 %LOCALAPPDATA%\CodexMemo 에 있어 다시 설치해도 그대로 유지된다.

param([string]$SourceDir)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Repo = 'plushg0724-web/codex-memo-public'
$AppDir = Join-Path $env:LOCALAPPDATA 'Programs\CodexMemo'

function Say($text) { Write-Host "  $text" -ForegroundColor Cyan }

function Find-Pythonw {
    $candidates = @()
    $cmd = Get-Command pythonw.exe -ErrorAction SilentlyContinue
    if ($cmd) { $candidates += $cmd.Source }
    $candidates += Get-ChildItem "$env:LOCALAPPDATA\Programs\Python\Python3*\pythonw.exe", "$env:ProgramFiles\Python3*\pythonw.exe" `
        -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | ForEach-Object FullName
    # Microsoft Store 의 python 바로가기(설치 안내용)는 제외
    $candidates | Where-Object { $_ -and $_ -notlike '*\WindowsApps\*' } | Select-Object -First 1
}

function Find-Node {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $exe = Join-Path $env:ProgramFiles 'nodejs\node.exe'
    if (Test-Path $exe) { return $exe }
    return $null
}

function Install-WithWinget($id, $name) {
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
        throw "$name 이(가) 없고 winget 도 없습니다. $name 을(를) 직접 설치한 뒤 다시 실행해 주세요."
    }
    Say "$name 설치 중… (몇 분 걸릴 수 있습니다)"
    winget install -e --id $id --silent --accept-package-agreements --accept-source-agreements | Out-Null
}

Write-Host "`nCodex 메모 설치" -ForegroundColor Yellow

# 1) Python, Node.js
$pyw = Find-Pythonw
if (-not $pyw) { Install-WithWinget 'Python.Python.3.12' 'Python'; $pyw = Find-Pythonw }
if (-not $pyw) { throw 'Python 설치를 확인하지 못했습니다. 창을 닫고 설치 명령을 다시 실행해 주세요.' }
$py = $pyw -replace 'pythonw\.exe$', 'python.exe'
if (-not (Find-Node)) { Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js' }
if (-not (Find-Node)) { throw 'Node.js 설치를 확인하지 못했습니다. 창을 닫고 설치 명령을 다시 실행해 주세요.' }
Say "Python: $py"
Say "Node.js: $(Find-Node)"

# 2) 빌드된 배포 파일 준비. 로컬 압축 해제 폴더도 바로 설치할 수 있다.
$tmp = $null
try {
    if ($SourceDir) {
        $sourcePath = (Resolve-Path -LiteralPath $SourceDir).Path
    } else {
        $release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'codex-memo' }
        Say "최신 버전: $($release.tag_name)"
        $asset = $release.assets | Where-Object { $_.name -eq 'CodexMemo-Windows.zip' } | Select-Object -First 1
        $downloadUrl = if ($asset) { $asset.browser_download_url } else { $release.zipball_url }
        $tmp = Join-Path $env:TEMP "codex-memo-$([guid]::NewGuid())"
        New-Item -ItemType Directory -Path $tmp | Out-Null
        $zip = Join-Path $tmp 'release.zip'
        Invoke-WebRequest $downloadUrl -OutFile $zip -Headers @{ 'User-Agent' = 'codex-memo' }
        Expand-Archive -LiteralPath $zip -DestinationPath $tmp
        $folders = @(Get-ChildItem -LiteralPath $tmp -Directory)
        if ($folders.Count -ne 1) { throw '설치 압축의 최상위 폴더를 확인하세요.' }
        $sourcePath = $folders[0].FullName
    }
    foreach ($required in @('codex_memo.py', 'VERSION', 'requirements.txt', 'labels\backend.cjs')) {
        if (-not (Test-Path -LiteralPath (Join-Path $sourcePath $required) -PathType Leaf)) { throw "설치 파일이 없습니다: $required" }
    }
    $entry = Get-Content -LiteralPath (Join-Path $sourcePath 'labels\backend.cjs') -Raw
    if ($entry -match 'dist/node/backend') {
        foreach ($module in @('backend', 'appserver', 'backup', 'backup-files', 'backup-format', 'backup-space', 'settings-store', 'protocol', 'backup-types', 'vocabulary-analysis', 'vocabulary-service')) {
            if (-not (Test-Path -LiteralPath (Join-Path $sourcePath "dist\node\$module.cjs") -PathType Leaf)) {
                throw '빌드된 Node 프로그램이 없습니다. CodexMemo-Windows.zip 배포 파일을 사용하세요. 개발자는 npm ci 후 npm run build를 실행하세요.'
            }
        }
    }
    Say '필요한 Python 패키지 설치 중…'
    & $py -m pip install --user -q --disable-pip-version-check -r (Join-Path $sourcePath 'requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw '패키지 설치에 실패했습니다.' }
    Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe'" |
        Where-Object { $_.CommandLine -like '*codex_memo.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    New-Item -ItemType Directory -Path $AppDir -Force | Out-Null
    if ([IO.Path]::GetFullPath($sourcePath).TrimEnd('\') -ne [IO.Path]::GetFullPath($AppDir).TrimEnd('\')) {
        Copy-Item (Join-Path $sourcePath '*') $AppDir -Recurse -Force
    }
} finally {
    if ($tmp) {
        $resolvedTmp = [IO.Path]::GetFullPath($tmp)
        $tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
        if ($resolvedTmp.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolvedTmp -Leaf) -like 'codex-memo-*') {
            Remove-Item -LiteralPath $resolvedTmp -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
Say "설치 위치: $AppDir"

# 5) 바로가기
$shell = New-Object -ComObject WScript.Shell
$targets = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex 메모.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'Codex 메모.lnk')
)
foreach ($lnk in $targets) {
    $s = $shell.CreateShortcut($lnk)
    $s.TargetPath = $pyw
    $s.Arguments = "`"$(Join-Path $AppDir 'codex_memo.py')`""
    $s.WorkingDirectory = $AppDir
    $s.IconLocation = "$(Join-Path $AppDir 'codex_memo.ico'),0"
    $s.Description = 'Codex 를 메모·단어장·라벨 기능과 함께 실행'
    $s.Save()
}
Say '바탕화면과 시작 메뉴에 "Codex 메모" 바로가기를 만들었습니다.'

# 6) 실행
Start-Process $pyw -WindowStyle Hidden -ArgumentList "`"$(Join-Path $AppDir 'codex_memo.py')`"" -WorkingDirectory $AppDir
Write-Host "`n설치 완료. 트레이 아이콘이 나타나면 Codex 가 메모 모드로 다시 시작됩니다.`n" -ForegroundColor Green

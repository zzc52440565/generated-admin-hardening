# 捷码项目本机环境诊断（Windows / PowerShell 5.1，只读）。
#
# 只查本机事实、判定组件状态、给出下一步动作；不安装、不修复、不读取任何真实口令。
# 输出 NDJSON（一行一条记录：type=platform / type=component / type=summary），
# 字段与 diagnose-macos.sh 同构，便于同一套 plan/verify 复用。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File diagnose-windows.ps1 -Components java,maven,mysql -Json
#   powershell -NoProfile -File diagnose-windows.ps1 -Components java,mysql -Project C:\abs\path -JavaMajor 17
#
# 退出码：0=全部 ok；1=存在非 ok 组件；2=参数或平台错误。

[CmdletBinding()]
param(
    [string]$Components = '',
    [string]$Project = '',
    [int]$JavaMajor = 0,
    [int]$NodeMajor = 0,
    [int]$MysqlPort = 3306,
    [int]$PostgresPort = 5432,
    [int]$RedisPort = 6379,
    [int]$TomcatPort = 8080,
    [switch]$Json,
    [switch]$Human,
    [switch]$Help
)

$ErrorActionPreference = 'Continue'
$script:Records = New-Object System.Collections.ArrayList
$script:Human = New-Object System.Collections.ArrayList
$script:BadStates = 0
$script:Supported = @('java','maven','gradle','node','npm','yarn','pnpm','git','python','go',
    'mysql','postgresql','redis','sqlite','sqlserver','oracle','tomcat','msbuild','dotnet','wxdevtools')

function Show-Usage {
    Write-Output '用法: diagnose-windows.ps1 -Components <列表> [-Project <绝对路径>] [-JavaMajor n] [-NodeMajor n] [-Json]'
    Write-Output '组件: java maven gradle node npm yarn pnpm git python go mysql postgresql redis sqlite sqlserver oracle tomcat msbuild dotnet wxdevtools'
}

function Fail([string]$Message) {
    Write-Error $Message
    exit 2
}

if ($Help) { Show-Usage; exit 0 }
if ($PSVersionTable.PSEdition -eq 'Core' -and -not ($env:OS -eq 'Windows_NT')) {
    Fail '本脚本只支持 Windows；macOS 请用 diagnose-macos.sh'
}
if (-not ($env:OS -eq 'Windows_NT')) {
    Fail '本脚本只支持 Windows；macOS 请用 diagnose-macos.sh'
}
if ([string]::IsNullOrWhiteSpace($Components)) { Show-Usage; exit 2 }
if ($Project -ne '') {
    if (-not [IO.Path]::IsPathRooted($Project)) { Fail 'Project 必须是绝对路径' }
    if (-not (Test-Path -LiteralPath $Project -PathType Container)) { Fail "项目目录不存在: $Project" }
}

# ---------------------------------------------------------------------------
# 平台事实
# ---------------------------------------------------------------------------

$osVersion = [Environment]::OSVersion.Version.ToString()
$arch = $env:PROCESSOR_ARCHITECTURE
$markerPattern = 'WorkBuddy|Visual Studio Code|Cursor|Windsurf|Electron|Claude|antigravity|codebuddy|trae|app\.asar'

function Expand-PathEntry([string]$Entry) {
    if ([string]::IsNullOrWhiteSpace($Entry)) { return '' }
    $value = $Entry.Trim().Trim('"')
    $value = [Environment]::ExpandEnvironmentVariables($value)
    if ($value -match '%') { return '' }
    return $value.TrimEnd('\')
}

function Get-SplitPath([string]$Raw) {
    $result = New-Object System.Collections.ArrayList
    foreach ($part in ($Raw -split ';')) {
        $expanded = Expand-PathEntry $part
        if ($expanded -eq '') { continue }
        if (-not ($result -contains $expanded)) { [void]$result.Add($expanded) }
    }
    return $result
}

# 持久化 PATH = 注册表 Machine + User（这才是用户开新终端看到的）
$machinePathRaw = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$userPathRaw = [Environment]::GetEnvironmentVariable('Path', 'User')
$persistentPath = Get-SplitPath ($machinePathRaw + ';' + $userPathRaw)
$processPath = Get-SplitPath ([string]$env:Path)

$processOnly = New-Object System.Collections.ArrayList
$injected = New-Object System.Collections.ArrayList
foreach ($entry in $processPath) {
    if (-not ($persistentPath -contains $entry)) {
        if (-not ($processOnly -contains $entry)) { [void]$processOnly.Add($entry) }
        if ($entry -match $markerPattern) {
            if (-not ($injected -contains $entry)) { [void]$injected.Add($entry) }
        }
    }
}

function Test-PersistentPath([string]$Directory) {
    if ([string]::IsNullOrWhiteSpace($Directory)) { return $false }
    $normalized = $Directory.TrimEnd('\')
    foreach ($entry in $persistentPath) {
        if ($entry -eq $normalized) { return $true }
    }
    return $false
}

function Test-InjectedPath([string]$Directory) {
    if ([string]::IsNullOrWhiteSpace($Directory)) { return $false }
    $normalized = $Directory.TrimEnd('\')
    foreach ($entry in $injected) {
        if ($entry -eq $normalized) { return $true }
    }
    return $false
}

function Get-Major([string]$Raw) {
    if ([string]::IsNullOrWhiteSpace($Raw)) { return $null }
    $match = [regex]::Match($Raw, '(\d+)(?:\.(\d+))?')
    if (-not $match.Success) { return $null }
    if ($match.Groups[1].Value -eq '1' -and $match.Groups[2].Success) {
        return [int]$match.Groups[2].Value
    }
    return [int]$match.Groups[1].Value
}

function Test-LocalPort([int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $pending = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $pending.AsyncWaitHandle.WaitOne(1500)) { return $false }
        $client.EndConnect($pending)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

function Get-CommandPath([string]$Name) {
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $cmd) { return '' }
    return [string]$cmd.Source
}

function Invoke-Version([string]$Path, [string[]]$Arguments) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
    try {
        $output = (& $Path @Arguments 2>&1 | Out-String)
        return [pscustomobject]@{
            Text = $output.Trim()
            First = (($output.Trim() -split "`r?`n") | Select-Object -First 1)
            ExitCode = $LASTEXITCODE
        }
    } catch {
        return [pscustomobject]@{ Text = ''; First = ''; ExitCode = -1 }
    }
}

# ---------------------------------------------------------------------------
# 记录载体
# ---------------------------------------------------------------------------

function New-ProbeState {
    return [ordered]@{
        state = 'ok'
        version = $null
        major = $null
        requiredMajor = $null
        resolvedPath = $null
        candidates = New-Object System.Collections.ArrayList
        inPersistentPath = $null
        processOnlyPath = $false
        injected = New-Object System.Collections.ArrayList
        faults = New-Object System.Collections.ArrayList
        notes = New-Object System.Collections.ArrayList
        evidence = $null
        nextAction = $null
        forbidden = $null
        extra = [ordered]@{}
    }
}

function Add-Fault($State, [string]$Code, [string]$Detail) {
    [void]$State.faults.Add([ordered]@{ code = $Code; detail = $Detail })
}

function Add-Note($State, [string]$Text) {
    if (-not [string]::IsNullOrWhiteSpace($Text)) { [void]$State.notes.Add($Text) }
}

function Emit-Component([string]$Name, $State) {
    $record = [ordered]@{ type = 'component'; component = $Name }
    $record.state = $State.state
    $record.version = $State.version
    $record.major = $State.major
    $record.requiredMajor = $State.requiredMajor
    $record.resolvedPath = $State.resolvedPath
    $record.candidates = @($State.candidates)
    $record.inPersistentPath = $State.inPersistentPath
    $record.processOnlyPath = $State.processOnlyPath
    $record.injected = @($State.injected)
    $record.faults = @($State.faults)
    $record.notes = @($State.notes)
    $record.evidence = $State.evidence
    $record.nextAction = $State.nextAction
    $record.forbidden = $State.forbidden
    foreach ($key in $State.extra.Keys) { $record[$key] = $State.extra[$key] }
    [void]$script:Records.Add($record)

    $line = '[{0,-22}] {1,-12}' -f $State.state, $Name
    if ($State.version) { $line = $line + ' ' + $State.version }
    if ($State.resolvedPath) { $line = $line + ' @ ' + $State.resolvedPath }
    if ($State.nextAction) { $line = $line + ' -> ' + $State.nextAction }
    [void]$script:Human.Add($line)
    if ($State.state -ne 'ok') { $script:BadStates = $script:BadStates + 1 }
}

function Set-Resolved($State, [string]$Path, [string]$VersionText) {
    $State.resolvedPath = $Path
    $State.version = $VersionText
    $State.major = Get-Major $VersionText
    $directory = Split-Path -Parent $Path
    $State.inPersistentPath = Test-PersistentPath $directory
    if ($State.inPersistentPath) {
        $State.processOnlyPath = $false
    } else {
        $State.processOnlyPath = $true
        if (Test-InjectedPath $directory) { [void]$State.injected.Add($Path) }
    }
}

function Test-InjectedOnly($State) {
    if ($State.injected.Count -gt 0) {
        $State.state = 'path-invisible'
        Add-Note $State '只在 WorkBuddy/IDE 注入的进程 PATH 中可见；注册表 Machine+User 的持久化 PATH 里没有它'
        $State.nextAction = '用新终端（按持久化 PATH）复查，再决定是否安装'
        $State.forbidden = '不要把宿主注入的运行时当成用户已安装'
        return $true
    }
    return $false
}

function Find-SiblingPaths([string]$Root) {
    if ([string]::IsNullOrWhiteSpace($Root)) { return @() }
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return @() }
    $found = New-Object System.Collections.ArrayList
    foreach ($dir in (Get-ChildItem -LiteralPath $Root -Directory -ErrorAction SilentlyContinue)) {
        $bin = Join-Path $dir.FullName 'bin'
        if (Test-Path -LiteralPath $bin -PathType Container) { [void]$found.Add($bin) }
        [void]$found.Add($dir.FullName)
    }
    return $found
}

# ---------------------------------------------------------------------------
# 组件探测
# ---------------------------------------------------------------------------

function Probe-Java([int]$RequiredMajor) {
    $state = New-ProbeState
    $state.requiredMajor = $RequiredMajor
    $javaCmd = Get-CommandPath 'java.exe'
    $candidates = New-Object System.Collections.ArrayList
    foreach ($root in @((Join-Path $env:ProgramFiles 'Java'), (Join-Path $env:ProgramFiles 'Eclipse Adoptium'),
            (Join-Path $env:ProgramFiles 'Microsoft'), (Join-Path $env:ProgramFiles 'Amazon Corretto'),
            'C:\Program Files\Java', (Join-Path $env:LOCALAPPDATA 'Programs'))) {
        foreach ($path in (Find-SiblingPaths $root)) {
            $bin = Join-Path $path 'bin\java.exe'
            if (Test-Path -LiteralPath $bin -PathType Leaf) {
                if (-not ($candidates -contains (Split-Path -Parent $bin))) { [void]$candidates.Add((Split-Path -Parent $bin)) }
            }
        }
    }
    foreach ($entry in $persistentPath) {
        $bin = Join-Path $entry 'java.exe'
        if (Test-Path -LiteralPath $bin -PathType Leaf) {
            if (-not ($candidates -contains $entry)) { [void]$candidates.Add($entry) }
        }
    }
    foreach ($candidate in $candidates) { [void]$state.candidates.Add($candidate) }

    if ($env:JAVA_HOME -and -not (Test-Path -LiteralPath $env:JAVA_HOME -PathType Container)) {
        Add-Fault $state 'java-home-dangling' 'JAVA_HOME 指向不存在的目录，Maven/Gradle/Tomcat 会因此失败'
    }

    if ($javaCmd -eq '') {
        if ($state.candidates.Count -gt 0) {
            $state.state = 'path-invisible'
            Add-Note $state ('本机已有 JDK 目录，但 java 不在 PATH: ' + $state.candidates[0])
            $state.nextAction = '把该 JDK 的 bin 加入本项目/用户 PATH 或设置 JAVA_HOME；不要重装'
            return $state
        }
        $state.state = 'missing'
        $state.nextAction = '安装 JDK（Temurin/Adoptium 官方包或 winget）到独立目录'
        $state.forbidden = '不要用 irm|iex 之类的远程脚本管道安装'
        return $state
    }

    $ver = Invoke-Version $javaCmd @('-version')
    $state.resolvedPath = $javaCmd
    $state.evidence = $ver.First
    $text = $ver.Text
    $match = [regex]::Match($text, 'version\s+"?([^"\s]+)"?')
    if ($match.Success) { $state.version = $match.Groups[1].Value } else { $state.version = $ver.First }
    $state.major = Get-Major $text
    $directory = Split-Path -Parent $javaCmd
    $state.inPersistentPath = Test-PersistentPath $directory
    if ($state.inPersistentPath) { $state.processOnlyPath = $false } else {
        $state.processOnlyPath = $true
        if (Test-InjectedPath $directory) { [void]$state.injected.Add($javaCmd) }
    }

    # javapath 是 Oracle 的转发壳，不算第二份 JDK
    if ($javaCmd -match 'javapath') {
        Add-Note $state ('java 解析到 Oracle 转发壳 ' + $javaCmd + '，与 JDK 本体是同一版本，不算重复安装')
    }
    $javacPath = Join-Path $directory 'javac.exe'
    if (-not (Test-Path -LiteralPath $javacPath -PathType Leaf)) {
        Add-Fault $state 'java-resolved-without-javac' ('解析到的 java（' + $javaCmd + '）同目录没有 javac.exe，疑似包装脚本或占位壳')
        Add-Note $state '能打印版本不等于能编译；构建会失败'
    }
    if (Test-InjectedOnly $state) { return $state }
    if ($RequiredMajor -gt 0 -and $state.major -ne $null -and $state.major -lt $RequiredMajor) {
        $state.state = 'version-incompatible'
        $state.nextAction = '并行安装满足要求的 JDK 到独立目录，用项目级 JAVA_HOME 指向它；不要卸载旧版本'
        $state.forbidden = '不要覆盖机器上已有的 JDK，不要改系统默认 java'
        return $state
    }
    $state.state = 'ok'
    if ($state.candidates.Count -gt 1) {
        Add-Note $state ('本机共存 ' + $state.candidates.Count + ' 个 JDK 目录；多版本共存不是故障')
    }
    $state.nextAction = 'java -version 通过仍不够；需要用项目源码真实编译一次'
    return $state
}

function Find-PrefixInstall([string]$Executable) {
    # 独立前缀里的安装（不在 PATH 时也应能被发现，用于区分 missing 与 path-invisible）
    $roots = @((Join-Path $env:LOCALAPPDATA 'jiema-env'), (Join-Path $env:USERPROFILE '.local\jiema-env'))
    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
        foreach ($dir in (Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
            $candidate = Join-Path $dir.FullName ('bin\' + $Executable)
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
        }
    }
    return ''
}

function Probe-Tool([string]$Executable, [string]$VersionArg, [int]$RequiredMajor) {
    $state = New-ProbeState
    $state.requiredMajor = $RequiredMajor
    $path = Get-CommandPath $Executable
    if ($path -eq '') {
        $prefixHit = Find-PrefixInstall $Executable
        if ($prefixHit -ne '') {
            $state.state = 'path-invisible'
            $state.resolvedPath = $prefixHit
            [void]$state.candidates.Add($prefixHit)
            Add-Note $state ('已存在于独立前缀但不在 PATH：' + $prefixHit)
            $state.nextAction = '用项目级环境脚本把这个 bin 目录加入 PATH；不改系统 PATH'
            $state.forbidden = '不要为了让它可见而重装或改全局 PATH'
            return $state
        }
    }
    if ($path -eq '') {
        $state.state = 'missing'
        $state.nextAction = ('确认本项目确实需要 ' + $Executable + '；需要时按 references/install-recipes.md 装到独立目录')
        $state.forbidden = '不要因为缺一个工具就批量安装其它组件'
        return $state
    }
    $ver = Invoke-Version $path @($VersionArg)
    Set-Resolved $state $path $ver.First
    $state.evidence = $ver.First
    if ($ver.ExitCode -ne 0) {
        $state.state = 'data-corrupt'
        Add-Note $state ($Executable + ' 存在但执行失败（退出码 ' + $ver.ExitCode + '）')
        $state.nextAction = '保留原始报错，确认安装目录是否损坏'
        return $state
    }
    if (Test-InjectedOnly $state) { return $state }
    if ($RequiredMajor -gt 0 -and $state.major -ne $null -and $state.major -lt $RequiredMajor) {
        $state.state = 'version-incompatible'
        $state.nextAction = '并行安装满足要求的版本到独立目录并调整项目 PATH；不要卸载旧版本'
        return $state
    }
    $state.state = 'ok'
    $state.nextAction = '命令可用不等于项目可用；仍需实际构建或运行验证'
    return $state
}

function Probe-Python {
    $state = New-ProbeState
    $path = Get-CommandPath 'python.exe'
    if ($path -ne '' -and (Test-Path -LiteralPath $path)) {
        $info = Get-Item -LiteralPath $path
        if ($info.Length -eq 0) {
            Add-Note $state 'WindowsApps 里的 python.exe 是 0 字节商店跳转壳，不是解释器，已排除'
            $path = ''
        }
    }
    if ($path -eq '') {
        $state.state = 'missing'
        $state.nextAction = '安装 Python 3.x（python.org 官方安装器或 winget），并确认勾选 Add to PATH'
        Add-Note $state 'Windows 上 python3 常被 0 字节占位符拦截；请明确使用 python 而不是 python3'
        return $state
    }
    $ver = Invoke-Version $path @('--version')
    Set-Resolved $state $path $ver.First
    $state.evidence = $ver.First
    if (Test-InjectedOnly $state) { return $state }
    $state.state = 'ok'
    $state.nextAction = 'python --version 与 pip --version 必须同源，并真实跑通项目脚本'
    return $state
}

function Probe-Database([string]$Name, [string]$Executable, [int]$Port, [string]$ServicePattern, [string]$Flavor) {
    $state = New-ProbeState
    $state.extra['port'] = $Port
    $clientPath = Get-CommandPath $Executable
    $listening = Test-LocalPort $Port
    $state.extra['listening'] = $listening
    $service = $null
    if ($ServicePattern -ne '') {
        $service = Get-Service -Name $ServicePattern -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($service) { $state.extra['service'] = $service.Name; $state.extra['serviceStatus'] = [string]$service.Status }
    }
    if ($clientPath -ne '') {
        $ver = Invoke-Version $clientPath @('--version')
        Set-Resolved $state $clientPath $ver.First
        $state.evidence = $ver.First
        [void]$state.candidates.Add('client:' + $clientPath)
    }
    if ($listening) {
        if ($clientPath -ne '') {
            $probePath = Join-Path (Split-Path -Parent $clientPath) 'mysqladmin.exe'
            if (Test-Path -LiteralPath $probePath -PathType Leaf) {
                $probe = Invoke-Version $probePath @('ping','--connect-timeout=3','--protocol=TCP','-h','127.0.0.1','-P',[string]$Port)
                $state.extra['probe'] = $probe.First
                $isAlive = $probe.First -match 'alive|denied|password'
                if (-not $isAlive -and -not [string]::IsNullOrWhiteSpace($probe.First)) {
                    $state.state = 'connect-failed'
                    Add-Note $state ('端口在监听但客户端连不上：' + $probe.First)
                    $state.nextAction = '查监听地址/协议、防火墙与端口占用进程；确认是不是目标数据库'
                    $state.forbidden = '不要用改密或重建数据目录来试着解决连接问题'
                    return $state
                }
            }
        }
        $state.state = 'ok'
        Add-Note $state ('127.0.0.1:' + $Port + ' 在监听；已有实例优先复用，不再另装一套抢端口')
        if ($clientPath -eq '') {
            Add-Note $state ('没有 ' + $Executable + ' 客户端，只影响命令行排查，不影响 JDBC/ADO 连接')
        }
        $state.nextAction = '用应用账号真实连接一次目标库（口令走安全输入，不进命令行）'
        $state.forbidden = '禁止修改已有实例的管理员口令、禁止重建已有数据目录'
        return $state
    }
    if ($service -and $service.Status -ne 'Running') {
        $isAdmin = $false
        try {
            $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
            $principal = New-Object Security.Principal.WindowsPrincipal($identity)
            $isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        } catch {
            $isAdmin = $false
        }
        if ($isAdmin) {
            $state.state = 'service-stopped'
            Add-Note $state ('服务 ' + $service.Name + ' 状态为 ' + $service.Status)
            $state.nextAction = '先看服务日志与事件日志再启动'
        } else {
            $state.state = 'needs-elevation'
            Add-Note $state ('服务 ' + $service.Name + ' 状态为 ' + $service.Status + '，但当前不是管理员会话，无法启动系统服务')
            $state.nextAction = '由用户用管理员权限启动该服务，或改成独立目录下的前台开发实例'
        }
        $state.forbidden = '不要重建数据目录、不要改管理员口令来“试试看”'
        return $state
    }
    if ($clientPath -ne '') {
        $state.state = 'service-stopped'
        Add-Note $state ('只有客户端，本机 ' + $Port + ' 未监听；也可能项目连的是远程实例')
        $state.nextAction = '先确认连接串指向本机还是远程；需要本机实例时按 provision 脚本建独立开发实例'
        return $state
    }
    $state.state = 'missing'
    $state.nextAction = '确认组件确实需要：本机开发库需客户端+独立实例；连远程库时只需客户端'
    return $state
}

function Probe-Tomcat([int]$Port) {
    $state = New-ProbeState
    $home = $env:CATALINA_HOME
    if ((-not $home) -or (-not (Test-Path -LiteralPath (Join-Path $home 'bin\catalina.bat')))) {
        $prefixTomcat = Find-PrefixInstall 'catalina.bat'
        if ($prefixTomcat -ne '') {
            $state.state = 'path-invisible'
            $state.resolvedPath = $prefixTomcat
            [void]$state.candidates.Add($prefixTomcat)
            Add-Note $state ('独立前缀里发现 Tomcat，但 CATALINA_HOME 未设置：' + $prefixTomcat)
            $state.nextAction = '构建/启动时临时设置 CATALINA_HOME 指向该目录，不必改全局环境'
            return $state
        }
    }
    if ($home -and (Test-Path -LiteralPath (Join-Path $home 'bin\catalina.bat'))) {
        $state.resolvedPath = (Join-Path $home 'bin\catalina.bat')
        if (Test-LocalPort $Port) {
            $state.state = 'ok'
            Add-Note $state ('CATALINA_HOME 可用且 ' + $Port + ' 在监听；仍需部署真实 WAR 后 HTTP 200 才算通过')
            $state.nextAction = '部署项目 WAR 后请求真实 URL 校验状态码与页面内容'
        } else {
            $state.state = 'service-stopped'
            Add-Note $state ('CATALINA_HOME 存在但 ' + $Port + ' 未监听')
            $state.nextAction = '按需启动（独立目录 startup.bat），启动动作需单独授权'
        }
        return $state
    }
    $state.state = 'missing'
    $state.nextAction = '仅当项目是外部 WAR 部署时才需要 Tomcat；可执行 JAR 不需要'
    $state.forbidden = '不要为不需要的项目装 Tomcat'
    return $state
}

function Probe-MSBuild {
    $state = New-ProbeState
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $msbuildPath = Get-CommandPath 'msbuild.exe'
    if ($msbuildPath -ne '') {
        Set-Resolved $state $msbuildPath '安装路径已发现'
        $state.state = 'ok'
        Add-Note $state 'MSBuild 在 PATH；仍需构建实际 .csproj 并核对目标 .NET Framework'
        $state.nextAction = '执行 msbuild 构建项目并检查输出'
        return $state
    }
    if (Test-Path -LiteralPath $vswhere -PathType Leaf) {
        $state.state = 'path-invisible'
        $state.resolvedPath = $vswhere
        Add-Note $state '发现 Visual Studio Installer（vswhere），但 msbuild 不在 PATH'
        $state.nextAction = '用 vswhere 定位 MSBuild 的绝对路径，或安装/补齐 Visual Studio Build Tools 的 .NET 桌面开发组件'
        return $state
    }
    $state.state = 'needs-elevation'
    $state.nextAction = '安装 Visual Studio Build Tools 的 .NET 桌面开发组件需要管理员权限，必须由用户单独授权并亲自执行'
    $state.forbidden = '不要关掉 UAC、不要静默提权、不要改 ExecutionPolicy'
    return $state
}

# ---------------------------------------------------------------------------
# 主循环
# ---------------------------------------------------------------------------

foreach ($itemRaw in ($Components -split ',')) {
    $item = $itemRaw.Trim().ToLowerInvariant()
    if ($item -eq '') { continue }
    if ($script:Supported -notcontains $item) { Fail ('不支持的组件: ' + $item) }
    switch ($item) {
        'java' { Emit-Component $item (Probe-Java $JavaMajor) }
        'node' { Emit-Component $item (Probe-Tool 'node.exe' '--version' $NodeMajor) }
        'npm' { Emit-Component $item (Probe-Tool 'npm.cmd' '--version' 0) }
        'yarn' { Emit-Component $item (Probe-Tool 'yarn.cmd' '--version' 0) }
        'pnpm' { Emit-Component $item (Probe-Tool 'pnpm.cmd' '--version' 0) }
        'git' { Emit-Component $item (Probe-Tool 'git.exe' '--version' 0) }
        'go' { Emit-Component $item (Probe-Tool 'go.exe' 'version' 0) }
        'python' { Emit-Component $item (Probe-Python) }
        'maven' {
            $mavenState = (Probe-Tool 'mvn.cmd' '-version' 0)
            if ($mavenState.state -eq 'missing' -and $Project -ne '' -and (Test-Path -LiteralPath (Join-Path $Project 'mvnw.cmd'))) {
                $mavenState.state = 'ok'
                $mavenState.resolvedPath = (Join-Path $Project 'mvnw.cmd')
                Add-Note $mavenState '项目自带 mvnw.cmd，可优先用包装器构建'
                $mavenState.nextAction = '用 mvnw.cmd -B validate 试构建；包装器下载失败时再考虑独立目录安装 Maven'
            } elseif ($mavenState.state -eq 'data-corrupt') {
                Add-Fault $mavenState 'maven-broken' 'mvn 启动失败，常见原因是 JAVA_HOME 无效'
                $mavenState.state = 'needs-user-input'
                $mavenState.nextAction = '先修 JAVA_HOME（指向存在的 JDK），再复验 mvn -v；是否修改用户环境变量需用户确认'
            }
            Emit-Component $item $mavenState
        }
        'gradle' {
            $gradleState = (Probe-Tool 'gradle.bat' '-version' 0)
            if ($gradleState.state -eq 'missing' -and $Project -ne '' -and (Test-Path -LiteralPath (Join-Path $Project 'gradlew.bat'))) {
                $gradleState.state = 'ok'
                $gradleState.resolvedPath = (Join-Path $Project 'gradlew.bat')
                Add-Note $gradleState '项目自带 gradlew.bat，优先用包装器'
                $gradleState.nextAction = '用 gradlew.bat -v 与真实构建验证'
            }
            Emit-Component $item $gradleState
        }
        'mysql' { Emit-Component $item (Probe-Database 'mysql' 'mysql.exe' $MysqlPort 'MySQL*' 'mysql') }
        'postgresql' { Emit-Component $item (Probe-Database 'postgresql' 'psql.exe' $PostgresPort 'postgresql*' 'postgres') }
        'redis' {
            $redisState = New-ProbeState
            $redisState.state = 'unsupported-on-this-os'
            Add-Note $redisState 'Windows 没有官方原生 Redis 构建；Memurai 或 WSL 属于第三方方案'
            $redisState.nextAction = '与用户确认：改用第三方兼容实现、WSL，或不用 Redis'
            $redisState.forbidden = '不要静默安装第三方移植版或偷偷引入容器'
            Emit-Component $item $redisState
        }
        'sqlite' {
            $sqliteState = New-ProbeState
            if ((Get-CommandPath 'sqlite3.exe') -ne '') {
                $sqliteState = (Probe-Tool 'sqlite3.exe' '--version' 0)
                Add-Note $sqliteState 'SQLite 无独立服务；必须由项目驱动真实打开数据文件验证'
            } else {
                $sqliteState.state = 'ok'
                Add-Note $sqliteState 'SQLite 随驱动提供，无需独立服务；仍须用项目驱动打开数据文件实测'
            }
            Emit-Component $item $sqliteState
        }
        'sqlserver' {
            $state = New-ProbeState
            $service = Get-Service -Name 'MSSQL*' -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $service) {
                $state.state = 'service-stopped'
                Add-Note $state '未发现本机 SQL Server 服务；可使用用户确认的远程实例'
                $state.nextAction = '确认要本机实例还是远程实例；本机安装需要管理员权限并单独授权'
            } elseif ($service.Status -ne 'Running') {
                $state.state = 'service-stopped'
                Add-Note $state ('服务 ' + $service.Name + ' 状态为 ' + $service.Status)
                $state.nextAction = '先看事件日志再启动服务'
            } else {
                $state.state = 'ok'
                Add-Note $state ('服务 ' + $service.Name + ' 运行中；仍须实际鉴权连接与建表读写')
                $state.nextAction = '用应用账号连接并做一次真实读写'
            }
            Emit-Component $item $state
        }
        'oracle' {
            $state = New-ProbeState
            $state.state = 'needs-user-input'
            Add-Note $state 'Oracle 需要官方账号下载安装介质，无法自动获取'
            $state.nextAction = '由用户提供官方安装包与本机实例信息'
            Emit-Component $item $state
        }
        'tomcat' { Emit-Component $item (Probe-Tomcat $TomcatPort) }
        'msbuild' { Emit-Component $item (Probe-MSBuild) }
        'dotnet' {
            $state = (Probe-Tool 'dotnet.exe' '--version' 0)
            if ($state.state -eq 'ok') {
                Add-Note $state 'dotnet CLI 可用不代表能跑 .NET Framework 桌面程序'
                $state.nextAction = '确认目标框架：net48 需要 .NET Framework 运行时；net5.0+ 用 dotnet CLI'
            }
            Emit-Component $item $state
        }
        'wxdevtools' {
            $state = New-ProbeState
            $found = @(
                (Join-Path ${env:ProgramFiles(x86)} 'Tencent\微信web开发者工具\cli.bat'),
                (Join-Path $env:ProgramFiles 'Tencent\微信web开发者工具\cli.bat')
            ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
            if ($found) {
                $state.state = 'ok'
                $state.resolvedPath = $found
                Add-Note $state '发现微信开发者工具 CLI；仍需真实打开并编译小程序'
                $state.nextAction = '导入项目并实际编译/预览一次'
            } else {
                $state.state = 'missing'
                Add-Note $state '小程序目标才需要微信开发者工具；需要图形界面登录'
                $state.nextAction = '从官方下载安装，并由用户登录扫码'
            }
            Emit-Component $item $state
        }
        default { Fail ('不支持的组件: ' + $item) }
    }
}

$platform = [ordered]@{}
$platform.type = 'platform'
$platform.schemaVersion = 1
$platform.platform = 'windows'
$platform.os = $osVersion
$platform.osBuild = ''
$platform.arch = $arch
$platform.project = $Project
$platform.persistentPath = @($persistentPath)
$platform.persistentPathSources = @('registry:Machine', 'registry:User')
$platform.processPath = @($processPath)
$platform.processOnlyPath = @($processOnly)
$platform.injectedPath = @($injected)
$platform.home = $env:USERPROFILE

$summary = [ordered]@{}
$summary.type = 'summary'
$summary.schemaVersion = 1
$summary.platform = 'windows'
$summary.componentCount = $script:Records.Count
$summary.nonOkCount = $script:BadStates
$summary.nextStep = '按组件状态生成计划：一次只处理一个组件，逐项取得授权'

if ($Human) {
    Write-Output ('Windows ' + $osVersion + ' (' + $arch + ')  项目: ' + $Project)
    Write-Output ('持久化 PATH 来自注册表 Machine+User；仅进程可见(注入): ' + (($injected -join '; ')))
    Write-Output ''
    foreach ($line in $script:Human) { Write-Output $line }
    Write-Output ''
    Write-Output ('非 ok 组件: ' + $script:BadStates)
} else {
    Write-Output ($platform | ConvertTo-Json -Compress -Depth 6)
    foreach ($record in $script:Records) { Write-Output ($record | ConvertTo-Json -Compress -Depth 6) }
    Write-Output ($summary | ConvertTo-Json -Compress -Depth 6)
}

if ($script:BadStates -gt 0) { exit 1 }
exit 0

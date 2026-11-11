# PC 부품 최저가 모니터 (Windows 기본 PowerShell 용, 설치할 것 없음)
#   run.bat        지금 한 번 조회
#   install.bat    6시간마다 자동 실행 등록 (작업 스케줄러)
#   uninstall.bat  자동 실행 해제
# 기준가는 같은 폴더의 state.txt 에 저장된다. 처음 실행하면 그때 가격이 기준가가 되고,
# 이후 기준가보다 내려가면 알림 창을 띄우고 기준가를 새 최저가로 낮춘다. 기록은 log.txt.
param([switch]$Install, [switch]$Uninstall, [switch]$Quiet)

$ErrorActionPreference = 'Stop'
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$StateFile = Join-Path $Dir 'state.txt'
$LogFile = Join-Path $Dir 'log.txt'
$TaskName = 'PCPartsPriceMonitor'

if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host '자동 실행을 해제했습니다.'
    exit 0
}
if ($Install) {
    $arg = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Quiet' -f $MyInvocation.MyCommand.Path
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(360) -RepetitionInterval (New-TimeSpan -Hours 6)
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
    Write-Host "6시간마다 자동 실행되도록 등록했습니다. (작업 스케줄러 이름: $TaskName, 첫 실행은 6시간 뒤)"
    exit 0
}

# 부품ID = 표시 이름, 다나와 상품코드 목록
$Parts = [ordered]@{
    cpu  = @('CPU 7800X3D', '19627934 19627808')
    mb   = @('메인보드 GIGABYTE B850M AORUS ELITE WIFI6E ICE', '73892000 73892423')
    ram  = @('RAM KingBank DDR5 16Gx2 화이트', '124480105 124480038')
    gpu  = @('GPU RX 9070 XT 화이트', '77381780 99892346 77318285 96981881 99288146 99128543 124480888')
    case = @('케이스 CH160 PLUS 화이트', '97117673')
    psu  = @('파워 SFX 화이트 750W+ 골드', '100695704 98409965 113761283 100695731')
}
$UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
$SL = [System.Text.RegularExpressions.RegexOptions]::Singleline
$Tmp = Join-Path $env:TEMP 'pcparts_page.html'

function Get-Page($pcode) {
    $url = 'https://prod.danawa.com/info/?pcode=' + $pcode
    $partial = $null
    for ($i = 0; $i -lt 3; $i++) {
        if (Test-Path $Tmp) { Remove-Item $Tmp -Force }
        & curl.exe -s -L -m 40 -A $UA -o $Tmp $url
        if ($LASTEXITCODE -eq 0 -and (Test-Path $Tmp)) {
            $body = [System.IO.File]::ReadAllText($Tmp, [System.Text.Encoding]::UTF8)
            if ($body.Contains('ld+json')) {
                if ($body.Contains('<li class="list-item">')) { return $body }
                $partial = $body
            }
        }
        Start-Sleep -Seconds (2 * $i + 2)
    }
    return $partial
}

function Get-Text($s) {
    $t = [regex]::Replace($s, '<[^>]+>', ' ')
    $t = [System.Net.WebUtility]::HtmlDecode($t)
    return ([regex]::Replace($t, '\s+', ' ')).Trim()
}

function Get-Num($s) { return [int]([regex]::Replace($s, '\D', '')) }

# 상품 페이지에서 (가격, 종류, 판매처·조건) 목록을 뽑는다.
function Get-Offers($page) {
    $out = New-Object System.Collections.ArrayList
    $low = 0
    $m = [regex]::Match($page, '"lowPrice"\s*:\s*"?(\d+)')
    if ($m.Success) {
        $low = [int]$m.Groups[1].Value
        [void]$out.Add([pscustomobject]@{ Price = $low; Kind = '다나와최저가'; Mall = '' })
    }
    foreach ($li in [regex]::Matches($page, '<li class="list-item">(.*?)</li>', $SL)) {
        $h = $li.Groups[1].Value
        $p = [regex]::Match($h, 'text__num">([\d,]+)<')
        if (-not $p.Success) { $p = [regex]::Match($h, 'text__discount-price">([\d,]+)') }
        if (-not $p.Success) { continue }
        $mall = ''
        $mm = [regex]::Match($h, "alt='([^']*)'")
        if ($mm.Success) { $mall = [System.Net.WebUtility]::HtmlDecode($mm.Groups[1].Value) }
        $t = Get-Text $h
        if ($h.Contains('box__membership-price')) {
            if ($t.Contains('멤버십')) { $kind = 'N+멤버십혜택가' } else { $kind = '카드혜택가' }
        } elseif ($h.Contains('badge__cash')) { $kind = '현금가' } else { $kind = '판매가' }
        $c = [regex]::Match($t, '\S+카드 결제 시')
        if ($c.Success) { $mall = ($mall + ' ' + $c.Value).Trim() }
        [void]$out.Add([pscustomobject]@{ Price = (Get-Num $p.Groups[1].Value); Kind = $kind; Mall = $mall })
    }
    $m = [regex]::Match($page, '현금최저가:\s*([\d,]+)원')
    if ($m.Success) { [void]$out.Add([pscustomobject]@{ Price = (Get-Num $m.Groups[1].Value); Kind = '현금가'; Mall = '' }) }
    # 다나와 최저가의 60% 미만은 오등록으로 보고 버린다.
    return @($out | Where-Object { $_.Price -ge $low * 0.6 })
}

# 기준가 읽기: "cpu 335200/357580 mb ..." 형식
$old = @{}
$first = -not (Test-Path $StateFile)
if (-not $first) {
    $raw = [System.IO.File]::ReadAllText($StateFile)
    foreach ($m in [regex]::Matches($raw, '(\w+) (\d+)/(\d+)')) {
        $old[$m.Groups[1].Value] = @([int]$m.Groups[2].Value, [int]$m.Groups[3].Value)
    }
}
$new = @{}
foreach ($k in $old.Keys) { $new[$k] = @($old[$k][0], $old[$k][1]) }

$lines = New-Object System.Collections.ArrayList
$alerts = New-Object System.Collections.ArrayList
$fails = New-Object System.Collections.ArrayList
$titles = @('전체최저(현금포함)', '카드·혜택최저(현금제외)')

foreach ($id in $Parts.Keys) {
    $label = $Parts[$id][0]
    $rows = New-Object System.Collections.ArrayList
    foreach ($pc in $Parts[$id][1].Split(' ')) {
        $page = Get-Page $pc
        if (-not $page) { [void]$fails.Add($pc); continue }
        $name = $pc
        $n = [regex]::Match($page, 'og:title" content="(?:\[다나와\] )?([^"]*)')
        if ($n.Success) { $name = [System.Net.WebUtility]::HtmlDecode($n.Groups[1].Value) }
        foreach ($o in (Get-Offers $page)) {
            [void]$rows.Add([pscustomobject]@{ Price = $o.Price; Kind = $o.Kind; Mall = $o.Mall; Name = $name; Code = $pc })
        }
        Start-Sleep -Milliseconds 1500
    }
    $sets = @(@($rows | Sort-Object Price), @($rows | Where-Object { $_.Kind -ne '현금가' } | Sort-Object Price))
    for ($i = 0; $i -lt 2; $i++) {
        $rs = $sets[$i]
        if ($rs.Count -eq 0) { [void]$fails.Add("${id}:$($titles[$i])"); continue }
        $b = $rs[0]
        $base = 0
        if ($old.ContainsKey($id)) { $base = $old[$id][$i] }
        $line = '{0} / {1}: {2:N0}원 [{3}] {4} {5} (기준 {6:N0}원, {7:+#,0;-#,0;0}원) https://prod.danawa.com/info/?pcode={8}' -f `
            $label, $titles[$i], $b.Price, $b.Kind, $b.Name, $b.Mall, $base, ($b.Price - $base), $b.Code
        [void]$lines.Add($line)
        if ($base -eq 0 -or $b.Price -lt $base) {
            if (-not $new.ContainsKey($id)) { $new[$id] = @(0, 0) }
            $new[$id][$i] = $b.Price
            if ($base -ne 0) {
                [void]$alerts.Add(('{0} / {1}: {2:N0}원 → {3:N0}원 ({4:N0}원) [{5}] {6} {7}' -f `
                    $label, $titles[$i], $base, $b.Price, ($b.Price - $base), $b.Kind, $b.Name, $b.Mall))
            }
        }
    }
}

$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
$report = New-Object System.Collections.ArrayList
[void]$report.Add("[$stamp] PC 부품 최저가")
foreach ($l in $lines) { [void]$report.Add($l) }
if ($lines.Count -eq 0) {
    [void]$report.Add('조회 실패: 가격을 하나도 가져오지 못했습니다. (다나와 접속 차단 또는 네트워크 문제)')
} elseif ($first) {
    [void]$report.Add('처음 실행이라 지금 가격을 기준가로 저장했습니다.')
} elseif ($alerts.Count -gt 0) {
    [void]$report.Add('*** 가격 하락 ***')
    foreach ($a in $alerts) { [void]$report.Add('ALERT ' + $a) }
} else {
    [void]$report.Add('변동 없음 (기준가보다 내려간 부품 없음)')
}
if ($fails.Count -gt 0 -and $lines.Count -gt 0) { [void]$report.Add('일부 조회 실패: ' + ($fails -join ' ')) }

# 기준가 저장 (조회된 것이 있을 때만)
if ($lines.Count -gt 0) {
    $items = foreach ($id in $Parts.Keys) { if ($new.ContainsKey($id)) { '{0} {1}/{2}' -f $id, $new[$id][0], $new[$id][1] } }
    [System.IO.File]::WriteAllText($StateFile, ($items -join ' '))
    [void]$report.Add('기준가: ' + ($items -join ' '))
}

$text = ($report -join "`r`n")
[System.IO.File]::AppendAllText($LogFile, $text + "`r`n`r`n", (New-Object System.Text.UTF8Encoding($true)))
if (-not $Quiet) { Write-Host $text }

if ($alerts.Count -gt 0) {
    Add-Type -AssemblyName System.Windows.Forms
    $msg = ($alerts -join "`r`n`r`n") + "`r`n`r`n자세한 내용은 log.txt 를 보세요."
    $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
    [void][System.Windows.Forms.MessageBox]::Show($owner, $msg, 'PC 부품 가격 하락', 'OK', 'Information')
}

param([Parameter(Mandatory = $true)][string]$Path)

Add-Type -AssemblyName System.IO.Compression.FileSystem

$archive = [IO.Compression.ZipFile]::OpenRead($Path)
try {
    $rows = @()
    foreach ($entry in $archive.Entries | Where-Object { $_.FullName -like 'raw/*_c.txt' }) {
        $reader = [IO.StreamReader]::new($entry.Open())
        try { $requestText = $reader.ReadToEnd() } finally { $reader.Dispose() }
        $lines = $requestText -split "`r?`n"
        $firstLine = $lines[0]
        if ($firstLine -notmatch '^(POST|GET) https://sff\.jd\.com/api') { continue }

        $api = if ($firstLine -match '[?&]api=([^& ]+)') {
            [Uri]::UnescapeDataString($matches[1])
        } else { '' }
        if ($api -notmatch 'queryValidProductList|querySkuList') { continue }

        $headers = @{}
        foreach ($line in $lines[1..([Math]::Min(60, $lines.Count - 1))]) {
            if ([string]::IsNullOrEmpty($line)) { break }
            $separator = $line.IndexOf(':')
            if ($separator -gt 0) {
                $headers[$line.Substring(0, $separator).Trim().ToLowerInvariant()] =
                    $line.Substring($separator + 1).Trim()
            }
        }

        $dsmValue = if ($headers.ContainsKey('dsm-eid')) { $headers['dsm-eid'] } else { '' }
        $dsmFingerprint = ''
        if ($dsmValue) {
            $sha = [Security.Cryptography.SHA256]::Create()
            try {
                $bytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($dsmValue))
                $dsmFingerprint = [BitConverter]::ToString($bytes).Replace('-', '').Substring(0, 12)
            } finally { $sha.Dispose() }
        }
        $cookieValue = if ($headers.ContainsKey('cookie')) { $headers['cookie'] } else { '' }
        $cookieFingerprint = ''
        if ($cookieValue) {
            $sha = [Security.Cryptography.SHA256]::Create()
            try {
                $bytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($cookieValue))
                $cookieFingerprint = [BitConverter]::ToString($bytes).Replace('-', '').Substring(0, 12)
            } finally { $sha.Dispose() }
        }

        $metadataName = $entry.FullName -replace '_c\.txt$', '_m.xml'
        $metadataEntry = $archive.GetEntry($metadataName)
        $metadataReader = [IO.StreamReader]::new($metadataEntry.Open())
        try { [xml]$metadata = $metadataReader.ReadToEnd() } finally { $metadataReader.Dispose() }
        $flags = @{}
        foreach ($flag in $metadata.Session.SessionFlags.SessionFlag) { $flags[$flag.N] = $flag.V }
        $timer = $metadata.Session.SessionTimers

        $responseEntry = $archive.GetEntry(($entry.FullName -replace '_c\.txt$', '_s.txt'))
        $responseReader = [IO.StreamReader]::new($responseEntry.Open())
        try { $responseText = $responseReader.ReadToEnd() } finally { $responseReader.Dispose() }
        $responseLines = $responseText -split "`r?`n"
        $responseHeaders = @{}
        foreach ($line in $responseLines[1..([Math]::Min(30, $responseLines.Count - 1))]) {
            if ([string]::IsNullOrEmpty($line)) { break }
            $separator = $line.IndexOf(':')
            if ($separator -gt 0) {
                $responseHeaders[$line.Substring(0, $separator).Trim().ToLowerInvariant()] =
                    $line.Substring($separator + 1).Trim()
            }
        }

        $rows += [pscustomobject]@{
            Seq = $rows.Count + 1
            Api = if ($api -match 'queryValidProductList') { 'SPU' } else { 'SKU' }
            Begin = [datetimeoffset]$timer.ClientBeginRequest
            End = [datetimeoffset]$timer.ClientDoneResponse
            Process = $flags['x-processinfo']
            ClientPort = $flags['x-clientport']
            EgressPort = $flags['x-EgressPort']
            Dsm = $dsmFingerprint
            Cookie = $cookieFingerprint
            H5stPresent = [bool]$headers['h5st']
            Protocol = ($firstLine -split ' ')[-1]
            ResponseConnection = $responseHeaders['connection']
            ResponseKeepAlive = $responseHeaders['keep-alive']
        }
    }

    "COUNT=$($rows.Count) SPU=$(($rows | Where-Object Api -eq 'SPU').Count) SKU=$(($rows | Where-Object Api -eq 'SKU').Count)"
    if (-not $rows.Count) { return }

    "START=$($rows[0].Begin.ToString('yyyy-MM-dd HH:mm:ss.fff zzz')) END=$($rows[-1].Begin.ToString('yyyy-MM-dd HH:mm:ss.fff zzz')) DURATION_SEC=$([Math]::Round(($rows[-1].Begin - $rows[0].Begin).TotalSeconds, 3))"
    "PROTOCOLS=$((($rows.Protocol | Sort-Object -Unique) -join ',')) H5ST_PRESENT=$(($rows | Where-Object H5stPresent).Count)/$($rows.Count)"
    'PROCESSES'
    $rows | Group-Object Process | Select-Object Name, Count | Format-Table -AutoSize

    $dsmChanges = $rows | Where-Object {
        $_.Seq -eq 1 -or $_.Dsm -ne $rows[$_.Seq - 2].Dsm
    } | ForEach-Object { "$($_.Seq):$($_.Dsm)" }
    "DSM_UNIQUE=$(($rows.Dsm | Sort-Object -Unique).Count) CHANGES=$($dsmChanges -join ',')"
    $cookieChanges = $rows | Where-Object {
        $_.Seq -eq 1 -or $_.Cookie -ne $rows[$_.Seq - 2].Cookie
    } | ForEach-Object { "$($_.Seq):$($_.Cookie)" }
    "COOKIE_UNIQUE=$(($rows.Cookie | Sort-Object -Unique).Count) CHANGES=$($cookieChanges -join ',')"

    "CLIENTPORT_UNIQUE=$(($rows.ClientPort | Sort-Object -Unique).Count) EGRESSPORT_UNIQUE=$(($rows.EgressPort | Sort-Object -Unique).Count)"
    $portChanges = $rows | Where-Object {
        $_.Seq -eq 1 -or
        $_.ClientPort -ne $rows[$_.Seq - 2].ClientPort -or
        $_.EgressPort -ne $rows[$_.Seq - 2].EgressPort
    } | ForEach-Object { "$($_.Seq):c$($_.ClientPort)/e$($_.EgressPort)" }
    "PORT_CHANGES=$($portChanges -join ',')"
    "SPU_POSITIONS=$((($rows | Where-Object Api -eq 'SPU' | ForEach-Object Seq) -join ','))"

    $gaps = for ($index = 1; $index -lt $rows.Count; $index++) {
        [pscustomobject]@{
            At = $index + 1
            GapMs = [Math]::Round(($rows[$index].Begin - $rows[$index - 1].End).TotalMilliseconds, 1)
            Prev = $rows[$index - 1].Api
            Next = $rows[$index].Api
        }
    }
    $sortedGaps = $gaps.GapMs | Sort-Object
    "GAP_MS min=$($sortedGaps[0]) median=$($sortedGaps[[int]($sortedGaps.Count / 2)]) p95=$($sortedGaps[[int]([Math]::Floor($sortedGaps.Count * .95))]) max=$($sortedGaps[-1])"
    'GAPS_OVER_1000'
    $gaps | Where-Object GapMs -gt 1000 | Select-Object At, GapMs, Prev, Next | Format-Table -AutoSize
    'FIRST_LAST'
    $rows | Select-Object -First 4 Seq, Api, Begin, ClientPort, EgressPort, Dsm
    $rows | Select-Object -Last 8 Seq, Api, Begin, ClientPort, EgressPort, Dsm
    'CONNECTION_BOUNDARIES'
    $rows | Where-Object { $_.Seq -in 1, 98, 99, 100, 101, 102, 198, 199, 200, 201, 202, 398, 399, 400, 401, 402 } |
        Select-Object Seq, Api, ClientPort, EgressPort, ResponseConnection, ResponseKeepAlive | Format-Table -AutoSize
} finally {
    $archive.Dispose()
}

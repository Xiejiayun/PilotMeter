param(
    [Parameter(Mandatory = $true)][ValidateSet('ExtractNode', 'Zip', 'Compile')][string]$Mode,
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination,
    [string]$NodeDirectory,
    [string]$Configuration,
    [string]$Payload,
    [string]$FileManifest,
    [string]$ApplicationManifest
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
switch ($Mode) {
    'ExtractNode' {
        $archive = [IO.Compression.ZipFile]::OpenRead($Source)
        try {
            foreach ($pair in @(@('node.exe', 'runtime\node.exe'), @('LICENSE', 'NODE-LICENSE.txt'))) {
                $entry = $archive.GetEntry("$NodeDirectory/$($pair[0])")
                if (-not $entry) { throw "Official Node archive is missing $($pair[0])" }
                $target = Join-Path $Destination $pair[1]
                [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
            }
        } finally { $archive.Dispose() }
    }
    'Zip' {
        $archive = [IO.Compression.ZipFile]::Open($Destination, [IO.Compression.ZipArchiveMode]::Create)
        try {
            $prefix = [IO.Path]::GetFullPath($Source).TrimEnd('\') + '\'
            foreach ($file in [IO.Directory]::EnumerateFiles($prefix, '*', [IO.SearchOption]::AllDirectories)) {
                $relative = $file.Substring($prefix.Length).Replace('\', '/')
                [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file, $relative, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
            }
        } finally { $archive.Dispose() }
    }
    'Compile' {
        $framework = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319'
        $compiler = Join-Path $framework 'csc.exe'
        if (-not (Test-Path -LiteralPath $compiler)) { throw 'The Windows .NET Framework compiler was not found.' }
        $nativeChild = Join-Path ([IO.Path]::GetDirectoryName($Source)) 'NativeChild.cs'
        & $compiler /nologo /target:exe /platform:x64 /optimize+ "/out:$Destination" "/win32manifest:$ApplicationManifest" "/reference:$framework\System.IO.Compression.dll" "/reference:$framework\System.IO.Compression.FileSystem.dll" "/resource:$Payload,PilotMeter.Payload" "/resource:$FileManifest,PilotMeter.Manifest" $Source $nativeChild $Configuration
        if ($LASTEXITCODE -ne 0) { throw "EXE compilation failed: $LASTEXITCODE" }
    }
}

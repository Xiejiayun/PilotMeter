param(
    [Parameter(Mandatory = $true)][ValidateSet('ExtractNode', 'ExtractWebView2', 'Zip', 'Compile', 'CompileDesktop')][string]$Mode,
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination,
    [string]$NodeDirectory,
    [string]$Configuration,
    [string]$Payload,
    [string]$FileManifest,
    [string]$ApplicationManifest,
    [string]$ApplicationIcon,
    [string]$WebViewDirectory
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
switch ($Mode) {
    'ExtractWebView2' {
        $archive = [IO.Compression.ZipFile]::OpenRead($Source)
        try {
            foreach ($pair in @(@('lib/net462/Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.Core.dll'), @('lib/net462/Microsoft.Web.WebView2.WinForms.dll', 'Microsoft.Web.WebView2.WinForms.dll'), @('runtimes/win-x64/native/WebView2Loader.dll', 'WebView2Loader.dll'), @('LICENSE.txt', 'WEBVIEW2-LICENSE.txt'))) {
                $entry = $archive.GetEntry($pair[0])
                if (-not $entry) { throw "Official WebView2 SDK is missing $($pair[0])" }
                $target = Join-Path $Destination $pair[1]
                [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
            }
        } finally { $archive.Dispose() }
    }
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
        & $compiler /nologo /target:winexe /platform:x64 /optimize+ "/out:$Destination" "/win32manifest:$ApplicationManifest" "/win32icon:$ApplicationIcon" /reference:System.Windows.Forms.dll "/reference:$framework\System.IO.Compression.dll" "/reference:$framework\System.IO.Compression.FileSystem.dll" "/resource:$Payload,PilotMeter.Payload" "/resource:$FileManifest,PilotMeter.Manifest" $Source $nativeChild $Configuration
        if ($LASTEXITCODE -ne 0) { throw "EXE compilation failed: $LASTEXITCODE" }
    }
    'CompileDesktop' {
        $framework = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319'
        $compiler = Join-Path $framework 'csc.exe'
        if (-not (Test-Path -LiteralPath $compiler)) { throw 'The Windows .NET Framework compiler was not found.' }
        $widget = Join-Path ([IO.Path]::GetDirectoryName($Source)) 'DesktopWidget.cs'
        $brand = Join-Path ([IO.Path]::GetDirectoryName($Source)) 'DesktopBrand.cs'
        $nativeWindow = Join-Path ([IO.Path]::GetDirectoryName($Source)) 'DesktopMainWindow.cs'
        $webWindow = Join-Path ([IO.Path]::GetDirectoryName($Source)) 'DesktopWebWindow.cs'
        $sessionLaunch = Join-Path ([IO.Path]::GetDirectoryName($Source)) 'DesktopSessionLaunch.cs'
        $nativeApi = Join-Path ([IO.Path]::GetDirectoryName($Source)) 'DesktopNativeApi.cs'
        $dashboardViews = Join-Path ([IO.Path]::GetDirectoryName($Source)) 'DesktopDashboardViews.cs'
        $pets = Join-Path ([IO.Path]::GetDirectoryName($Source)) 'DesktopPets.cs'
        $petDirectory = Join-Path ([IO.Path]::GetDirectoryName($Source)) '../../docs/design/pets'
        $petNames = @('pilot', 'cat', 'shiba', 'penguin', 'slime', 'robot', 'cloud', 'sprout', 'jellyfish', 'dragon')
        $petResources = for ($index = 0; $index -lt $petNames.Count; $index++) {
            $petId = '{0:D2}' -f ($index + 1)
            $petFile = [IO.Path]::GetFullPath((Join-Path $petDirectory ("pet-$petId-" + $petNames[$index] + '.png')))
            if (-not (Test-Path -LiteralPath $petFile -PathType Leaf)) { throw "Missing pet image: $petId" }
            "/resource:$petFile,PilotMeter.Pets.$petId"
        }
        if (-not $WebViewDirectory) { throw 'The pinned WebView2 SDK directory is required.' }
        & $compiler /nologo /target:winexe /platform:x64 /optimize+ "/out:$Destination" "/win32manifest:$ApplicationManifest" "/win32icon:$ApplicationIcon" "/resource:$ApplicationIcon,PilotMeter.Icon" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Net.Http.dll /reference:System.Web.Extensions.dll "/reference:$WebViewDirectory\Microsoft.Web.WebView2.Core.dll" "/reference:$WebViewDirectory\Microsoft.Web.WebView2.WinForms.dll" @petResources $Source $widget $brand $nativeWindow $nativeApi $dashboardViews $pets $webWindow $sessionLaunch $Configuration
        if ($LASTEXITCODE -ne 0) { throw "Desktop compilation failed: $LASTEXITCODE" }
    }
}

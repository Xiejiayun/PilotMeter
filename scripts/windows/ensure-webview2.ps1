param([switch]$CI)
$ErrorActionPreference = 'Stop'
if (-not $CI) { throw 'This helper is for the isolated CI runner only. Install WebView2 from the Microsoft download page on a user device.' }
if ($env:CI -ne 'true' -and $env:GITHUB_ACTIONS -ne 'true') { throw 'WebView2 automatic installation is restricted to CI.' }
$runtimeRoots = @((Join-Path ${env:ProgramFiles(x86)} 'Microsoft\EdgeWebView\Application'), (Join-Path $env:LOCALAPPDATA 'Microsoft\EdgeWebView\Application'))
foreach ($runtimeRoot in $runtimeRoots) {
    if (Test-Path -LiteralPath $runtimeRoot) {
        $runtime = Get-ChildItem -LiteralPath $runtimeRoot -Filter msedgewebview2.exe -Recurse -File | Select-Object -First 1
        if ($runtime) { Write-Output "Microsoft Edge WebView2 runtime already installed: $($runtime.VersionInfo.FileVersion)"; exit 0 }
    }
}
$ownedDirectory = Join-Path $env:TEMP ('pilotmeter-webview2-install-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($ownedDirectory) | Out-Null
$installer = Join-Path $ownedDirectory 'MicrosoftEdgeWebview2Setup.exe'
Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $installer
$signature = Get-AuthenticodeSignature -LiteralPath $installer
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(?:^|, )O=Microsoft Corporation(?:,|$)') { throw 'The downloaded WebView2 installer is not signed by Microsoft Corporation.' }
$setup = Start-Process -FilePath $installer -ArgumentList '/silent', '/install' -WindowStyle Hidden -PassThru -Wait
if ($setup.ExitCode -ne 0) { throw "Microsoft WebView2 installation failed: $($setup.ExitCode)" }
Write-Output 'Microsoft Edge WebView2 Evergreen installation completed; the native host test will verify it can render.'

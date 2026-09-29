import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Official, immutable NuGet SDK package. Only the x64 loader and .NET Framework
// bindings ship; the Microsoft-maintained Evergreen runtime remains separate.
export const webView2Version = '1.0.3537.50';
export const webView2Sha256 = '5ea526bbd728adda0da4d31219267e96460494a427e4894c4e09d9f320f4b9aa';
export const webView2Files = ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function command(program, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { output += bytes; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('WebView2 SDK preparation failed: ' + output.slice(-4096))));
  });
}

export async function prepareWebView2Sdk(workspace, destination) {
  const cache = join(workspace, 'build', 'windows');
  await mkdir(cache, { recursive: true });
  const archive = join(cache, `microsoft.web.webview2.${webView2Version}.nupkg`);
  let bytes;
  try { bytes = await readFile(archive); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!bytes || digest(bytes) !== webView2Sha256) {
    // NuGet v2 redirects to Microsoft's official CDN. Windows curl supports the
    // system TLS policy on hosts where the v3 endpoint negotiates poorly.
    const downloaded = archive + '.download';
    await command(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe'), [
      '--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https',
      '--max-time', '120', '--output', downloaded,
      `https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/${webView2Version}`,
    ]);
    bytes = await readFile(downloaded);
    if (digest(bytes) !== webView2Sha256) throw new Error('Official WebView2 SDK SHA-256 mismatch. No binaries were extracted.');
    await writeFile(archive, bytes);
  }
  await mkdir(destination, { recursive: true });
  await command(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(workspace, 'scripts', 'windows', 'package.ps1'),
    '-Mode', 'ExtractWebView2', '-Source', archive, '-Destination', destination,
  ]);
  return webView2Files.map(name => join(destination, name));
}

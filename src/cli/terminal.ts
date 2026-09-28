import { execFile, spawn } from 'node:child_process';
import { instanceAt, request, type Instance } from '../daemon/client.js';
import type { Summary } from '../shared/types.js';

// A stalled filesystem operation cannot reliably be aborted inside this process.
// Isolate cache reads so the deadline kills the reader, including its pending I/O.
const CACHE_READER = String.raw`
  const { openSync, fstatSync, readSync, closeSync } = require('node:fs');
  const { join } = require('node:path');
  function read(name, limit) {
    let fd;
    try {
      fd = openSync(join(process.argv[1], name), 'r');
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > limit) throw new Error('Invalid cache size or type');
      const buffer = Buffer.allocUnsafe(limit + 1);
      let size = 0;
      while (size <= limit) {
        const count = readSync(fd, buffer, size, limit + 1 - size, null);
        if (!count) break;
        size += count;
      }
      if (size > limit) throw new Error('Cache grew past its limit');
      return JSON.parse(buffer.toString('utf8', 0, size));
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  const snapshot = read('status.json', 65536);
  const instance = read('instance.json', 8192);
  process.stdout.write(JSON.stringify([snapshot, instance ? { url: instance.url } : null]));
`;
function safe(value: string): string { return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' '); }
function fitColumns(text: string, columns: number): string {
  const budget = Math.max(1, columns - 2); let width = 0; let result = '';
  for (const char of text) {
    const point = char.codePointAt(0)!;
    const size = /\p{Mark}/u.test(char) ? 0 : point >= 0x1100 && (point <= 0x115f || point >= 0x2329 && point <= 0x232a || point >= 0x2e80 && point <= 0xa4cf || point >= 0xac00 && point <= 0xd7a3 || point >= 0xf900 && point <= 0xfaff || point >= 0xfe10 && point <= 0xfe6f || point >= 0xff00 && point <= 0xff60 || point >= 0x1f300) ? 2 : 1;
    if (width + size > budget) return result + '…';
    result += char; width += size;
  }
  return result;
}
export function statusText(summary: Summary): string {
  const d = summary.display;
  const value = d.percentage !== null ? `${d.percentage}%` : d.used === null ? '尚无已知用量' : `${d.used} ${d.unit}`;
  return safe(`${summary.demo ? '[虚构演示] ' : ''}PilotMeter · ${d.label} ${value} · ${summary.local.sessionCount} 个会话${summary.local.unknownCalls ? ` · ${summary.local.unknownCalls} 次用量未知` : ''}${summary.local.pendingCalls ? ` · ${summary.local.pendingCalls} 次待分类` : ''}${d.reason ? ` · ${d.reason}` : ''}`);
}
export function terminalLink(url: string, tty = process.stdout.isTTY): string {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(url)) throw new Error('Invalid local dashboard URL.');
  const supported = tty && !process.env.NO_COLOR && !process.env.PILOTMETER_NO_OSC8 && (process.env.WT_SESSION || ['iTerm.app', 'WezTerm', 'vscode'].includes(process.env.TERM_PROGRAM || ''));
  return supported ? `\u001b]8;;${url}\u0007查看详情 ↗\u001b]8;;\u0007 ${url}` : url;
}
export async function openBrowser(url: string): Promise<void> {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(url)) throw new Error('Invalid local dashboard URL.');
  if (process.env.SSH_CONNECTION || process.env.WSL_DISTRO_NAME) { console.log(`${url}（远程环境：请为此 loopback 端口配置转发后打开）`); return; }
  const [command, args] = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command as string, args as string[], { windowsHide: true, detached: true, stdio: 'ignore' });
    child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
  });
}
export async function cachedStatus(dir: string): Promise<string> {
  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(process.execPath, ['--input-type=commonjs', '-e', CACHE_READER, dir], {
        windowsHide: true, timeout: 250, killSignal: 'SIGKILL', maxBuffer: 80 * 1024,
        encoding: 'utf8',
      }, (error, stdout) => { if (error) reject(error); else resolve(stdout); });
    });
    const [snapshot, instance] = JSON.parse(output) as [Summary | null, Pick<Instance, 'url'> | null];
    if (!snapshot) return 'PilotMeter · 尚无本地快照';
    if (snapshot.period !== new Date().toISOString().slice(0, 7)) return `PilotMeter · 当前 UTC 月暂无快照 · 缓存来自 ${safe(snapshot.period)}，不计为本月用量`;
    const stale = !instance || Date.now() - Date.parse(snapshot.updatedAt) > 60_000;
    return `${statusText(snapshot)}${stale ? ' · 缓存可能陈旧' : ''}${instance && /^http:\/\/127\.0\.0\.1:\d+$/.test(instance.url) ? ` · ${instance.url}` : ''}`;
  } catch { return 'PilotMeter · 本地快照暂不可用'; }
}
export async function watch(dir: string): Promise<void> {
  let active = true;
  let timer: NodeJS.Timeout | undefined;
  let busy = false;
  let current: Instance | null = null;
  let displayedUrl: string | null = null;
  const tty = !!(process.stdin.isTTY && process.stdout.isTTY);
  const redraw = async () => {
    if (!active || busy) return; busy = true;
    try {
      current = await instanceAt(dir);
      const text = current ? statusText(await request<Summary>(current, '/api/summary')) : 'PilotMeter 已离线 · 显示缓存：' + await cachedStatus(dir);
      if (!active) return;
      if (current && current.url !== displayedUrl) {
        if (tty) process.stdout.write('\r\u001b[2K');
        console.log(terminalLink(current.url, tty));
        displayedUrl = current.url;
      }
      if (tty) process.stdout.write(`\r\u001b[2K${fitColumns(text, process.stdout.columns || 80)}`); else console.log(text);
    } catch { if (tty && active) process.stdout.write('\r\u001b[2KPilotMeter 连接中断，稍后重试'); }
    finally { busy = false; }
  };
  if (tty) console.log('[o] 打开详情  [q] 退出观察（服务继续运行）');
  await redraw();
  if (!tty) return;
  await new Promise<void>(resolve => {
    const wasRaw = process.stdin.isRaw;
    const done = () => {
      if (!active) return; active = false; clearInterval(timer);
      process.stdin.setRawMode(wasRaw); process.stdin.off('data', input); process.stdin.pause();
      process.off('SIGINT', done); process.off('SIGTERM', done); process.stdout.write('\n'); resolve();
    };
    const input = (chunk: Buffer) => {
      const key = chunk.toString().toLowerCase();
      if (key.includes('q') || key.includes('\u0003')) done();
      else if (key.includes('o') && current) {
        const url = current.url;
        void openBrowser(url).catch(() => { process.stdout.write(`\n请手动打开 ${url}\n`); });
      }
    };
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', input);
    process.once('SIGINT', done); process.once('SIGTERM', done);
    timer = setInterval(() => { void redraw(); }, 2000);
  });
}

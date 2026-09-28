#!/usr/bin/env node
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 24 || (major === 24 && minor < 14)) {
  console.error('PilotMeter requires Node.js 24.14 or newer.');
  process.exitCode = 1;
} else {
  import('../dist/cli/main.js').catch(error => { console.error(`PilotMeter: ${error.message}`); process.exitCode = 1; });
}

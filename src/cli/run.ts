import crossSpawn from 'cross-spawn';
import type { Instance } from '../daemon/client.js';
export function telemetryEnvironment(base: NodeJS.ProcessEnv, instance: Instance, replace = false): NodeJS.ProcessEnv {
  const conflicts = Object.keys(base).filter(key => /^(OTEL_EXPORTER_OTLP(?:_|$)|COPILOT_OTEL_|OTEL_(?:TRACES|METRICS|LOGS)_EXPORTER$|OTEL_SDK_DISABLED$)/.test(key) && base[key]);
  if (conflicts.length && !replace) throw new Error(`Existing telemetry settings: ${conflicts.join(', ')}. Use run --replace-telemetry -- <args> to select PilotMeter for this child process.`);
  const env = { ...base };
  delete env.PILOTMETER_GITHUB_TOKEN;
  for (const key of Object.keys(env)) if (/^(OTEL_EXPORTER_OTLP(?:_|$)|COPILOT_OTEL_)/.test(key)) delete env[key];
  return { ...env, COPILOT_OTEL_ENABLED: 'true', COPILOT_OTEL_EXPORTER_TYPE: 'otlp-http', OTEL_EXPORTER_OTLP_ENDPOINT: instance.url, OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json', OTEL_EXPORTER_OTLP_HEADERS: `x-pilotmeter-token=${instance.collectorToken}`, OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'false', OTEL_SDK_DISABLED: 'false', OTEL_TRACES_EXPORTER: 'otlp', OTEL_METRICS_EXPORTER: 'none', OTEL_LOGS_EXPORTER: 'none' };
}
export async function runCopilot(instance: Instance, args: string[], replace = false, command = 'copilot'): Promise<number> {
  const env = telemetryEnvironment(process.env, instance, replace);
  return new Promise((resolve, reject) => {
    const child = crossSpawn(command, args, { env, stdio: 'inherit', windowsHide: false });
    // Both processes share the foreground terminal, which delivers Ctrl+C to the child.
    const interrupted = () => {};
    process.on('SIGINT', interrupted);
    const terminate = () => { child.kill('SIGTERM'); };
    process.once('SIGTERM', terminate);
    const clean = () => { process.off('SIGINT', interrupted); process.off('SIGTERM', terminate); };
    child.once('error', error => { clean(); reject(error); });
    child.once('exit', (code, signal) => { clean(); resolve(code ?? (signal === 'SIGINT' ? 130 : 1)); });
  });
}

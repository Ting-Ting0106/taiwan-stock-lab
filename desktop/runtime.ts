import { createServer } from 'node:net';
import { join } from 'node:path';
export interface DesktopHealth { application: 'taiwan-stock-lab'; version: string; instanceId: string; running: boolean }
export function ownedHealth(value: unknown, instanceId: string, version: string): value is DesktopHealth {
  if (!value || typeof value !== 'object') return false;
  const health = value as Partial<DesktopHealth>;
  return health.application === 'taiwan-stock-lab' && health.instanceId === instanceId && health.version === version && typeof health.running === 'boolean';
}
export const desktopPorts = (preferred?: number) => [...new Set([...(preferred ? [preferred] : []), 3100, ...Array.from({ length: 29 }, (_, i) => 3102 + i)])];
export async function findFreePort(candidates: number[]) {
  for (const port of candidates) {
    const available = await new Promise<number | undefined>(resolve => {
      const server = createServer();
      server.once('error', () => resolve(undefined));
      server.listen(port, '127.0.0.1', () => {
        const address = server.address(), actual = address && typeof address === 'object' ? address.port : undefined;
        server.close(() => resolve(actual));
      });
    });
    if (available !== undefined) return available;
  }
  throw new Error('沒有可用的本機接埠，請關閉其他桌面版本後再試。');
}
export function desktopPaths(appPath: string, resources: string, userData: string, packaged: boolean) {
  return { data: join(userData, 'data'), server: packaged ? join(resources, 'server', 'server.cjs') : join(appPath, '.desktop', 'server.cjs'), web: packaged ? join(resources, 'web') : join(appPath, 'dist'), icon: join(appPath, '.desktop', 'icon.png') };
}
export function backendEnvironment(parent: NodeJS.ProcessEnv, port: number, data: string, web: string, instanceId: string): NodeJS.ProcessEnv {
  const env = { ...parent };
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'OPENAI_API_KEY', 'OPENAI_ADMIN_KEY']) delete env[key];
  return { ...env, PORT: String(port), DATA_DIR: data, STATIC_DIR: web, DESKTOP_INSTANCE_ID: instanceId };
}
export async function readHealth(base: string) {
  const response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(1000) });
  if (!response.ok) throw new Error('服務尚未就緒');
  const text = await response.text();
  if (text.length > 4096) throw new Error('本機服務回覆不符');
  return JSON.parse(text) as unknown;
}
export async function waitForServer(base: string, instanceId: string, version: string, alive: () => boolean, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline && alive()) {
    try { const health = await readHealth(base); if (ownedHealth(health, instanceId, version)) return health; } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('本機服務未能啟動，請查看個人資料資料夾內的 desktop.log。');
}

export function navigationTarget(url: string, base: string): 'app' | 'login' | 'external' | 'blocked' {
  try {
    const target = new URL(url), local = new URL(base);
    if (target.username || target.password) return 'blocked';
    if (target.origin === local.origin) {
      if (target.pathname === '/auth/desktop-launch') return /^[A-Za-z0-9_-]{43}$/.test(target.searchParams.get('ticket') ?? '') && [...target.searchParams.keys()].length === 1 ? 'login' : 'blocked';
      if (target.pathname.startsWith('/auth/')) return 'blocked';
      return 'app';
    }
    return ['https:', 'http:'].includes(target.protocol) ? 'external' : 'blocked';
  } catch { return 'blocked'; }
}

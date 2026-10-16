import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readdir, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { AccountUsage, UsageWindow } from '../shared/model';

const windowSchema = z.object({ usedPercent: z.number().finite().min(0).max(100), windowDurationMins: z.number().int().positive().nullish(), resetsAt: z.number().finite().nonnegative().nullish() });
const bucketSchema = z.object({ limitId: z.string().nullish(), limitName: z.string().nullish(), planType: z.string().nullish(), primary: windowSchema.nullish(), secondary: windowSchema.nullish(), credits: z.object({ balance: z.string().nullable(), unlimited: z.boolean(), hasCredits: z.boolean() }).nullish() });
const limitsSchema = z.object({ rateLimits: bucketSchema.nullish(), rateLimitsByLimitId: z.record(bucketSchema).nullish() });
const accountSchema = z.object({ account: z.object({ type: z.string(), email: z.string().nullish(), planType: z.string().nullish() }).nullable() });

export async function resolveCodexExecutable(environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  const isFile = async (path: string) => { try { return (await stat(path)).isFile(); } catch { return false; } };
  if (environment.CODEX_EXECUTABLE) {
    if (!isAbsolute(environment.CODEX_EXECUTABLE) || !await isFile(environment.CODEX_EXECUTABLE)) throw new Error('CODEX_EXECUTABLE 必須指向存在的官方 Codex 執行檔絕對路徑。');
    return environment.CODEX_EXECUTABLE;
  }
  for (const directory of (environment.PATH ?? environment.Path ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(directory.replace(/^"|"$/g, ''), process.platform === 'win32' ? 'codex.exe' : 'codex');
    if (isAbsolute(candidate) && await isFile(candidate)) return candidate;
  }
  // The desktop app's CLI may not be in the user's PowerShell PATH.
  if (process.platform === 'win32' && environment.LOCALAPPDATA) {
    const root = join(environment.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    try {
      const candidates = await Promise.all((await readdir(root, { withFileTypes: true })).filter(d => d.isDirectory()).map(async d => {
        const path = join(root, d.name, 'codex.exe');
        try { const info = await stat(path); return info.isFile() ? { path, modified: info.mtimeMs } : undefined; } catch { return undefined; }
      }));
      const found = candidates.filter((c): c is { path: string; modified: number } => Boolean(c)).sort((a, b) => b.modified - a.modified)[0];
      if (found) return found.path;
    } catch { /* A standard CLI on PATH or CODEX_EXECUTABLE may be used instead. */ }
  }
  throw new Error('找不到官方 Codex CLI，請安裝官方 Codex，或設定 CODEX_EXECUTABLE 為執行檔絕對路徑。');
}

export function normalizeUsage(accountResult: unknown, limitResult: unknown, now = new Date()): AccountUsage {
  const account = accountSchema.parse(accountResult).account;
  const base = { source: 'codex-app-server' as const, checkedAt: now.toISOString(), windows: [] as UsageWindow[] };
  if (!account || account.type !== 'chatgpt') return { ...base, status: 'signed_out', error: '本機 Codex 尚未以 ChatGPT 帳號登入，請先在官方 Codex 完成登入。' };
  const limits = limitsSchema.parse(limitResult);
  const entries = Object.entries(limits.rateLimitsByLimitId ?? {});
  const buckets = entries.length ? entries : limits.rateLimits ? [[limits.rateLimits.limitId ?? 'codex', limits.rateLimits] as const] : [];
  const windows: UsageWindow[] = [];
  let credits: AccountUsage['credits'];
  for (const [id, bucket] of buckets) {
    if (bucket.credits) credits ??= bucket.credits;
    for (const key of ['primary', 'secondary'] as const) {
      const window = bucket[key]; if (!window) continue;
      const reset = window.resetsAt == null ? null : new Date(window.resetsAt * 1000);
      windows.push({ id: `${id}:${key}`, name: bucket.limitName ?? bucket.limitId ?? id, usedPercent: window.usedPercent, remainingPercent: Math.round((100 - window.usedPercent) * 100) / 100, durationMinutes: window.windowDurationMins ?? null, resetsAt: reset && !isNaN(+reset) ? reset.toISOString() : null });
    }
  }
  return { ...base, status: windows.length || credits ? 'available' : 'unavailable', account: account.email ?? undefined, plan: account.planType ?? undefined, windows, credits, ...(!windows.length && !credits ? { error: '官方未回傳可顯示的額度週期，不能視為剩餘 100%。' } : {}) };
}

// Only the documented account reads are sent. Never start a thread, turn, login,
// logout or credit/reset operation, and never read auth.json or AiUsage data.
export async function readCodexUsage(): Promise<AccountUsage> {
  const executable = await resolveCodexExecutable();
  const environment = { ...process.env };
  delete environment.OPENAI_API_KEY;
  const child = spawn(executable, ['app-server', '--listen', 'stdio://'], { env: environment, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let id = 0, closed = false, totalBytes = 0;
  const fail = (error: Error) => { closed = true; for (const task of pending.values()) task.reject(error); pending.clear(); };
  child.on('error', () => fail(new Error('無法啟動官方 Codex CLI，請確認已安裝且可由終端執行 codex。')));
  child.on('exit', () => fail(new Error('官方 Codex 用量服務已結束，請稍後重試。')));
  child.stderr.resume(); // Do not log CLI diagnostics or credentials.
  child.stdin.on('error', () => fail(new Error('無法連線到本機 Codex 用量服務。')));
  child.stdout.on('data', chunk => { totalBytes += chunk.length; if (totalBytes > 2_000_000) { fail(new Error('用量服務回覆超過大小限制。')); child.kill(); } });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', line => {
    try {
      const message = JSON.parse(line);
      if (message.method && message.id !== undefined) {
        child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Read-only usage client does not handle server requests' } }) + '\n'); return;
      }
      const task = pending.get(message.id); if (!task) return;
      pending.delete(message.id);
      if (message.error) task.reject(new Error('官方 Codex 無法提供此帳號用量；請確認登入狀態、方案與 CLI 版本。'));
      else task.resolve(message.result);
    } catch { fail(new Error('用量服務回覆格式無法辨識，請更新官方 Codex CLI。')); }
  });
  const timeout = setTimeout(() => { fail(new Error('讀取帳號用量逾時，請確認網路後重試。')); child.kill(); }, 25000);
  function rpc(method: string, params?: unknown): Promise<unknown> {
    if (closed) return Promise.reject(new Error('本機 Codex 用量服務無法連線。'));
    return new Promise((resolve, reject) => {
      const requestId = ++id; pending.set(requestId, { resolve, reject });
      child.stdin.write(JSON.stringify({ id: requestId, method, ...(params === undefined ? {} : { params }) }) + '\n');
    });
  }
  try {
    await rpc('initialize', { clientInfo: { name: 'taiwan_stock_usage', title: '每日台股研究室・唯讀用量', version: '0.3.0' } });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    const account = await rpc('account/read', { refreshToken: false });
    const info = accountSchema.parse(account).account;
    if (!info || info.type !== 'chatgpt') return normalizeUsage(account, {});
    const limits = await rpc('account/rateLimits/read');
    return normalizeUsage(account, limits);
  } finally { clearTimeout(timeout); lines.close(); child.stdin.end(); child.kill(); }
}

export class UsageMonitor {
  private cached: AccountUsage = { status: 'idle', source: 'codex-app-server', windows: [] };
  private pending?: Promise<AccountUsage>;
  private reader: () => Promise<AccountUsage>;
  constructor(reader = readCodexUsage) { this.reader = reader; }
  async get(refresh = false) {
    // No CLI is started until the user explicitly asks to display account usage.
    if (!refresh && this.cached.status === 'idle') return this.cached;
    if (this.pending) return this.pending;
    if (this.cached.checkedAt && Date.now() - Date.parse(this.cached.checkedAt) < 60000) return this.cached;
    this.pending = (async () => {
      try { this.cached = await this.reader(); }
      catch (e) { this.cached = { status: 'unavailable', source: 'codex-app-server', checkedAt: new Date().toISOString(), windows: [], error: e instanceof z.ZodError ? '官方用量資料格式與預期不同，尚無可顯示的真實數值。' : e instanceof Error ? e.message : '讀取用量失敗' }; }
      return this.cached;
    })().finally(() => { this.pending = undefined; });
    return this.pending;
  }
}

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import type { Schedule } from '../shared/model';

// This test process uses only a temporary directory and synthetic credentials.
const original = process.cwd(), temporary = await mkdtemp(join(tmpdir(), 'stock-workflow-'));
process.chdir(temporary);
const { read, mutate, defaultSchedule } = await import('./store.ts');
const { ChatGPTAuth, BrowserLoginBridge } = await import('./auth.ts');
const { sessionVault } = await import('./session-vault.ts');
function memoryVault() {
  let saved: unknown;
  return { async load() { return structuredClone(saved); }, async save(value: unknown) { saved = structuredClone(value); }, async clear() { saved = undefined; } };
}
const { scheduleDecision, taipeiClock, QueryJobs: LiveQueryJobs } = await import('./jobs.ts');
class QueryJobs extends LiveQueryJobs {
  constructor(auth: InstanceType<typeof ChatGPTAuth>, execute?: ConstructorParameters<typeof LiveQueryJobs>[1], check?: ConstructorParameters<typeof LiveQueryJobs>[3]) {
    super(auth, execute, async () => ({ version: 'market-evidence-0.1.0', collectedAt: new Date().toISOString(), mode: 'after_hours', quality: 'unavailable', screening: 'incomplete', universeCount: 0, poolCount: 0, technicalCount: 0, markets: [], stocks: [], sources: [], limitations: ['合成測試，不連線行情'] }), check ?? (async now => ({date:taipeiClock(now ?? new Date()).date,state:'open',reason:'合成開市驗證',checkedAt:new Date().toISOString(),sources:[]})));
  }
}
const { parseResponseStream, verifyWebSources, UnverifiedResponseError } = await import('./ai.ts');
const { normalizeUsage, UsageMonitor, resolveCodexExecutable } = await import('./usage.ts');
after(async () => {
  process.chdir(original);
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
  assert.ok(basename(temporary).startsWith('stock-workflow-'));
  await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});
const encoder = new TextEncoder();
function stream(events: object[]) { return new ReadableStream<Uint8Array>({ start(controller) { for (const e of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\r\n\r\n`)); controller.close(); } }); }

test('完整串流保存內容與安全引用，不接受中斷串流', async () => {
  const result = await parseResponseStream(stream([
    { type: 'response.output_text.delta', delta: '部分文字' },
    { type: 'response.completed', response: { output: [{ content: [{ type: 'output_text', text: '完整結果', annotations: [{ type: 'url_citation', url: 'https://www.twse.com.tw/', title: '證交所' }, { type: 'url_citation', url: 'javascript:alert(1)', title: '不安全引用' }] }] }] } },
  ]));
  assert.equal(result.output, '完整結果'); assert.equal(result.sources.length, 1);
  await assert.rejects(parseResponseStream(stream([{ type: 'response.output_text.delta', delta: '部分' }])), /中斷/);
});
test('串流在分段 CRLF 與多位元中文字下仍可讀取', async () => {
  const bytes = encoder.encode(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ content: [{ type: 'output_text', text: '台股' }] }] } })}\r\n\r\n`);
  const body = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
  assert.equal((await parseResponseStream(body)).output, '台股');
});
test('串流開始後額度耗盡也必須算失敗', async () => {
  await assert.rejects(parseResponseStream(stream([{ type: 'response.output_text.delta', delta: '部分文字' }, { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }])), /額度不足/);
});

test('前段引用不因精簡 completed 遺失，來源去重且不接受純文字網址', async () => {
  for (const event of [
    { type: 'response.output_text.annotation.added', annotation: { type: 'url_citation', url: 'https://www.twse.com.tw/' } },
    { type: 'response.content_part.done', part: { annotations: [{ type: 'url_citation', url: 'https://www.twse.com.tw/' }] } },
    { type: 'response.output_item.done', item: { content: [{ annotations: [{ type: 'url_citation', url: 'https://www.twse.com.tw/' }] }] } },
  ]) {
    const result = await parseResponseStream(stream([event, event, { type: 'response.output_text.delta', delta: '合成回覆' }, { type: 'response.completed', response: {} }]));
    assert.equal(verifyWebSources(result).sources.length, 1);
  }
  const result = await parseResponseStream(stream([
    { type: 'response.web_search_call.completed', item_id: 'search1' },
    { type: 'response.output_item.done', item: { id: 'search1', type: 'web_search_call', action: { sources: [{ url: 'https://www.twse.com.tw/' }, { url: 'javascript:alert(1)' }] } } },
    { type: 'response.output_text.delta', delta: '合成文字 https://www.twse.com.tw/' },
    { type: 'response.completed', response: {} },
  ]));
  assert.equal(result.searchCalls, 1); assert.equal(result.searchSources?.length, 1);
  assert.throws(() => verifyWebSources(result), UnverifiedResponseError);
  assert.throws(() => verifyWebSources({ output: '無搜尋', sources: [] }), /未收到搜尋工具紀錄/);
});
test('台北時區、週末、每日去重與五分鐘錯過規則', () => {
  const schedule: Schedule = { ...defaultSchedule(), enabled: true, model: 'test-model' };
  assert.equal(taipeiClock(new Date('2026-10-15T04:00:00Z')).minutes, 720);
  assert.equal(scheduleDecision(schedule, new Date('2026-10-15T03:59:00Z')), 'wait');
  assert.equal(scheduleDecision(schedule, new Date('2026-10-15T04:00:00Z')), 'due');
  assert.equal(scheduleDecision(schedule, new Date('2026-10-15T04:05:00Z')), 'missed');
  assert.equal(scheduleDecision(schedule, new Date('2026-10-17T04:00:00Z')), 'wait');
  assert.equal(scheduleDecision({ ...schedule, lastAttemptDate: '2026-10-15' }, new Date('2026-10-15T04:00:00Z')), 'wait');
});

const { publicKey, privateKey } = await generateKeyPair('RS256');
const key = { ...await exportJWK(publicKey), kid: 'synthetic-key', alg: 'RS256', use: 'sig' };
let expectedNonce = '', expiry = 3600, refreshCount = 0, wrongNonce = false;
const mockFetch: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : input.toString();
  if (url.endsWith('/.well-known/openid-configuration')) return Response.json({ issuer: 'https://auth.openai.com', authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize', token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json', revocation_endpoint: 'https://auth.openai.com/revoke' });
  if (url.endsWith('/jwks.json')) return Response.json({ keys: [key] });
  if (url.endsWith('/revoke')) return new Response(null, { status: 200 });
  if (url.endsWith('/oauth/token')) {
    const params = new URLSearchParams(String(init?.body));
    if (params.get('grant_type') === 'refresh_token') { refreshCount++; await new Promise(r => setTimeout(r, 15)); }
    const token = await new SignJWT({ nonce: wrongNonce ? 'wrong-nonce' : expectedNonce, email: 'synthetic@example.invalid' }).setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key' }).setIssuer('https://auth.openai.com').setSubject('synthetic-subject').setAudience('oaiapp_synthetic').setIssuedAt().setExpirationTime('5m').sign(privateKey);
    return Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: expiry, scope: 'openid chatgpt.tokens.use.direct', id_token: token });
  }
  throw new Error('Unexpected mock URL');
};
async function connect(auth: InstanceType<typeof ChatGPTAuth>) {
  const start = await auth.start('http://127.0.0.1:3100/auth/callback');
  const url = new URL(start.url); expectedNonce = url.searchParams.get('nonce')!;
  const callback = new URLSearchParams({ state: url.searchParams.get('state')!, code: 'synthetic-code', client_id: 'oaiapp_synthetic' });
  await auth.callback(callback, start.browser);
  return { start, callback };
}
test('OAuth 驗簽、瀏覽器綁定、一次性 state 與不落盤憑證', async () => {
  const auth = new ChatGPTAuth(mockFetch, memoryVault());
  const start = await auth.start('http://127.0.0.1:3100/auth/callback');
  const url = new URL(start.url); expectedNonce = url.searchParams.get('nonce')!;
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  const params = new URLSearchParams({ state: url.searchParams.get('state')!, code: 'synthetic-code', client_id: 'oaiapp_synthetic' });
  await assert.rejects(auth.callback(params, 'wrong-browser'), /失效/);
  await auth.callback(params, start.browser);
  assert.equal((await auth.status()).planEnabled, true);
  await assert.rejects(auth.callback(params, start.browser), /失效/);
  const saved = JSON.stringify(await read());
  assert.ok(!saved.includes('synthetic-access')); assert.ok(!saved.includes('synthetic-refresh')); assert.ok(!saved.includes('id_token'));
  await auth.logout(); assert.equal((await auth.status()).connected, false);
});
test('OAuth nonce 不符不能登入；沒有登入不能發出 AI 請求', async () => {
  const auth = new ChatGPTAuth(mockFetch, memoryVault()); wrongNonce = true;
  try { await assert.rejects(connect(auth), /驗證不符/); } finally { wrongNonce = false; }
  assert.equal((await auth.status()).connected, false);
  await assert.rejects(auth.access(), /先使用 ChatGPT 登入/);
});

test('安全保存登入可跨服務還原、續期；登出後不再還原', async () => {
  const vault = sessionVault(join(temporary, 'credential-test'));
  const first = new ChatGPTAuth(mockFetch, vault);
  expiry = 30;
  try {
    await connect(first);
    const { readFile } = await import('node:fs/promises');
    const encrypted = await readFile(join(temporary, 'credential-test', 'session.dpapi'));
    assert.ok(!encrypted.includes(Buffer.from('synthetic-access')));
    assert.ok(!encrypted.includes(Buffer.from('synthetic-refresh')));
    expiry = 3600;
    const restored = new ChatGPTAuth(mockFetch, vault);
    const status = await restored.status();
    assert.equal(status.connected, true); assert.equal(status.profileId, 'oaiapp_synthetic');
    assert.equal(await restored.access(), 'synthetic-access');
    await restored.logout();
    assert.equal((await new ChatGPTAuth(mockFetch, vault).status()).connected, false);
  } finally { expiry = 3600; await vault.clear(); }
});

test('損壞的登入保存不可冒充已連線', async () => {
  const auth = new ChatGPTAuth(mockFetch, { async load() { throw new Error('corrupt'); }, async save() {}, async clear() {} });
  const status = await auth.status();
  assert.equal(status.connected, false); assert.match(status.persistenceError!, /重新登入/);
});
test('並行續期只送一次，登出不保留可用憑證', async () => {
  const auth = new ChatGPTAuth(mockFetch, memoryVault()); expiry = 1; refreshCount = 0;
  try { await connect(auth); expiry = 3600; await Promise.all([auth.access(), auth.access(), auth.access()]); assert.equal(refreshCount, 1); }
  finally { expiry = 3600; await auth.logout(); }
  await assert.rejects(auth.access(), /先使用 ChatGPT 登入/);
});
test('排程持久去重、帳號綁定、錯過時間不補跑', async () => {
  const auth = new ChatGPTAuth(mockFetch, memoryVault()); await connect(auth);
  let count = 0;
  const jobs = new QueryJobs(auth, async () => { count++; return { output: '合成驗證結果', sources: [] }; });
  await mutate(db => { db.schedule = { ...defaultSchedule(), enabled: true, model: 'test-model', ownerProfileId: 'oaiapp_synthetic' }; });
  await jobs.tick(new Date('2026-10-15T04:00:00Z')); await jobs.tick(new Date('2026-10-15T04:01:00Z'));
  assert.equal(count, 1); assert.equal((await read()).queries.at(-1)?.status, 'succeeded');
  await jobs.tick(new Date('2026-10-16T04:06:00Z'));
  assert.equal(count, 1); assert.equal((await read()).queries.at(-1)?.status, 'missed');
  await mutate(db => { db.schedule.ownerProfileId = 'oaiapp_other'; });
  await jobs.tick(new Date('2026-10-19T04:00:00Z'));
  assert.equal(count, 1); assert.equal((await read()).queries.at(-1)?.status, 'failed');
  await auth.logout();
});
test('缺引用保存未驗證回覆與搜尋紀錄，狀態仍失敗', async () => {
  const auth = new ChatGPTAuth(mockFetch, memoryVault()); await connect(auth);
  const draft = { output: '合成未驗證內容', sources: [], searchSources: [{ title: '證交所', url: 'https://www.twse.com.tw/' }], searchCalls: 1 };
  const jobs = new QueryJobs(auth, async () => { throw new UnverifiedResponseError(draft); });
  await mutate(db => { db.schedule = { ...defaultSchedule(), enabled: true, model: 'test', ownerProfileId: 'oaiapp_synthetic' }; });
  await jobs.tick(new Date('2026-10-20T04:00:00Z'));
  const saved = (await read()).queries.at(-1)!;
  assert.equal(saved.status, 'failed'); assert.equal(saved.output, draft.output);
  assert.deepEqual(saved.searchSources, draft.searchSources); assert.equal(saved.searchCalls, 1);
  await auth.logout();
});

test('重新啟動將未完成查詢標記中斷，不重送請求', async () => {
  const auth = new ChatGPTAuth(mockFetch, memoryVault()), jobs = new QueryJobs(auth);
  await mutate(db => { db.schedule.enabled = false; db.queries.push({ id: 'unfinished', prompt: 'test', model: 'test', webSearch: false, includeResearch: false, createdAt: new Date().toISOString(), trigger: 'manual', status: 'running', sources: [] }); });
  await jobs.start(); jobs.stop();
  assert.equal((await read()).queries.find(q => q.id === 'unfinished')?.status, 'interrupted');
});
test('HTTP 拒絕外站變更、未授權查詢及非法排程，可保存停用設定', async () => {
  const child = spawn(process.execPath, [join(original, 'server/index.ts')], { cwd: temporary, env: { ...process.env, PORT: '3111' }, windowsHide: true, stdio: 'ignore' });
  try {
    let ready = false;
    for (let i = 0; i < 200; i++) { try { if ((await fetch('http://127.0.0.1:3111/api/state')).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 50)); }
    assert.ok(ready, 'isolated backend did not start');
    async function post(path: string, body: unknown, origin?: string) { return fetch('http://127.0.0.1:3111/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) }); }
    assert.equal((await post('paper/settings',{enabled:false},'https://external.invalid')).status,403);
    assert.equal((await post('paper/settings',{enabled:false})).status,200);
    assert.equal((await read()).paper?.enabled,false);
    assert.equal((await read()).paper?.cash,100000);
    const request = { prompt: 'test', model: 'test', webSearch: false, includeResearch: false };
    assert.equal((await post('queries', request, 'https://external.invalid')).status, 403);
    assert.equal((await post('queries', request)).status, 400);
    assert.equal((await post('schedule', { ...defaultSchedule(), enabled: true, model: 'test' })).status, 400);
    assert.equal((await post('schedule', { ...defaultSchedule(), time: '25:00' })).status, 400);
    assert.equal((await post('schedule', { ...defaultSchedule(), weekdays: [0] })).status, 400);
    const saved = await post('schedule', { ...defaultSchedule(), time: '12:30' });
    assert.equal(saved.status, 200); assert.equal((await saved.json()).enabled, false);
    assert.equal((await read()).schedule.time, '12:30');
    const state = await fetch('http://127.0.0.1:3111/api/state');
    assert.equal(state.headers.get('cache-control'), 'no-store');
    const data = await state.json(); assert.equal(data.auth.connected, false); assert.equal(data.schedule.time, '12:30');
  } finally { const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill(); await exited; }
});
test('兩個服務的資料、網頁、來源限制與登入 Cookie 分開', async () => {
  await mkdir(join(temporary, 'dist'), { recursive: true });
  await mkdir(join(temporary, 'dist-codex'), { recursive: true });
  await writeFile(join(temporary, 'dist/index.html'), '<html>user-preview-test</html>');
  await writeFile(join(temporary, 'dist-codex/index.html'), '<html>codex-preview-test</html>');
  const children = [3112, 3113].map((port, index) => {
    const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port) }; delete env.DATA_DIR;
    return spawn(process.execPath, [join(original, 'server/index.ts'), ...(index ? ['--codex'] : [])], { cwd: temporary, env, windowsHide: true, stdio: 'ignore' });
  });
  try {
    for (const port of [3112, 3113]) {
      let ready = false;
      for (let i = 0; i < 200; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/state`)).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 50)); }
      assert.ok(ready, `backend ${port} did not start`);
    }
    const state = async (port: number) => (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    const user = await state(3112), codex = await state(3113);
    assert.equal(user.instance.role, 'user'); assert.equal(codex.instance.role, 'codex');
    assert.equal(user.instance.dataDirectory, join(temporary, 'data')); assert.equal(codex.instance.dataDirectory, join(temporary, 'data/codex'));
    assert.equal(await (await fetch('http://127.0.0.1:3112/')).text(), '<html>user-preview-test</html>');
    assert.equal(await (await fetch('http://127.0.0.1:3113/')).text(), '<html>codex-preview-test</html>');
    const trade = { code: '9999', buyDate: '2026-10-14', buyPrice: 100, quantity: 1, fees: 0, note: 'isolated two-instance test' };
    const result = await fetch('http://127.0.0.1:3112/api/trades', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(trade) });
    assert.equal(result.status, 200); assert.equal((await state(3112)).trades.length, user.trades.length + 1); assert.equal((await state(3113)).trades.length, 0);
    const crossPort = await fetch('http://127.0.0.1:3112/api/trades', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:3113' }, body: JSON.stringify(trade) });
    assert.equal(crossPort.status, 403);
    for (const port of [3112, 3113]) {
      const callback = await fetch(`http://127.0.0.1:${port}/auth/callback?state=synthetic-invalid`, { redirect: 'manual' });
      assert.equal(callback.status, 302);
      assert.ok(callback.headers.get('set-cookie')?.startsWith(`stock_oauth_${port}=`));
    }
  } finally {
    await Promise.all(children.map(child => new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; } child.once('exit', () => resolve()); child.kill(); })));
  }
});
test('用量依實際週期與 reset 秒數顯示，缺少週期不補 100%', () => {
  const account = { account: { type: 'chatgpt', email: 'synthetic@example.invalid', planType: 'plus' } };
  const result = normalizeUsage(account, { rateLimits: { primary: { usedPercent: 99 } }, rateLimitsByLimitId: { codex: { primary: { usedPercent: 25, windowDurationMins: 10080, resetsAt: 1800000000 }, secondary: null } } });
  assert.equal(result.windows.length, 1); assert.equal(result.windows[0].remainingPercent, 75); assert.equal(result.windows[0].durationMinutes, 10080); assert.equal(result.windows[0].resetsAt, new Date(1800000000000).toISOString());
  const empty = normalizeUsage(account, {}); assert.equal(empty.status, 'unavailable'); assert.deepEqual(empty.windows, []);
});
test('未登入、API 金鑰帳號及非法比例不能顯示為可用餘額', () => {
  assert.equal(normalizeUsage({ account: null }, {}).status, 'signed_out');
  assert.equal(normalizeUsage({ account: { type: 'apiKey' } }, {}).status, 'signed_out');
  assert.throws(() => normalizeUsage({ account: { type: 'chatgpt' } }, { rateLimits: { primary: { usedPercent: 120 } } }));
});
test('未操作不啟動用量查詢，並行更新共用請求與一分鐘快取', async () => {
  let count = 0;
  const monitor = new UsageMonitor(async () => { count++; await new Promise(r => setTimeout(r, 15)); return { status: 'available', source: 'codex-app-server', checkedAt: new Date().toISOString(), windows: [] }; });
  assert.equal((await monitor.get()).status, 'idle'); assert.equal(count, 0);
  await Promise.all([monitor.get(true), monitor.get(true), monitor.get(true)]); assert.equal(count, 1);
  await monitor.get(); assert.equal(count, 1);
});
test('用量更新失敗清除先前帳號數值，不把過期資料當成即時', async () => {
  let count = 0;
  const monitor = new UsageMonitor(async () => { if (count++) throw new Error('synthetic offline'); return { status: 'available', source: 'codex-app-server', checkedAt: '2000-01-01T00:00:00Z', account: 'old@example.invalid', windows: [{ id: 'old', name: 'test', usedPercent: 30, remainingPercent: 70, durationMinutes: 300, resetsAt: null }] }; });
  await monitor.get(true); const failed = await monitor.get();
  assert.equal(failed.status, 'unavailable'); assert.deepEqual(failed.windows, []); assert.equal(failed.account, undefined);
});
test('官方 CLI 位置可從指定絕對路徑解析，無效路徑拒絕執行', async () => {
  assert.equal(await resolveCodexExecutable({ CODEX_EXECUTABLE: process.execPath }), process.execPath);
  await assert.rejects(resolveCodexExecutable({ CODEX_EXECUTABLE: 'relative/codex.exe' }), /絕對路徑/);
  await assert.rejects(resolveCodexExecutable({ PATH: '', LOCALAPPDATA: join(temporary, 'no-installation') }), /找不到/);
});

test('工作先保存官方行情並傳入 AI，AI 失敗仍保留資料診斷；關閉網路不抓行情', async () => {
  const auth = new ChatGPTAuth(mockFetch, memoryVault()); await connect(auth);
  const evidence = { version: 'market-evidence-0.1.0' as const, collectedAt: new Date().toISOString(), mode: 'intraday' as const, quality: 'unavailable' as const, screening: 'incomplete' as const, universeCount: 0, poolCount: 0, technicalCount: 0, markets: [], stocks: [], sources: [], limitations: ['合成資料失敗診斷'] };
  let collected = 0, gotEvidence = false;
  const jobs = new LiveQueryJobs(auth, async (_auth, _input, _research, _profile, received) => { gotEvidence = received === evidence; throw new Error('合成 AI 失敗'); }, async () => { collected++; return evidence; }, async now=>({date:taipeiClock(now??new Date()).date,state:'open',reason:'合成開市',checkedAt:new Date().toISOString(),sources:[]}));
  await mutate(db => { db.schedule = { ...defaultSchedule(), enabled: true, model: 'test', ownerProfileId: 'oaiapp_synthetic' }; });
  await jobs.tick(new Date('2026-10-21T04:00:00Z'));
  const failed = (await read()).queries.at(-1)!;
  assert.equal(failed.status, 'failed'); assert.equal(gotEvidence, true); assert.equal(collected, 1);
  assert.deepEqual(failed.marketResearch, evidence);
  await mutate(db => { db.schedule.webSearch = false; });
  await jobs.tick(new Date('2026-10-22T04:00:00Z'));
  assert.equal(collected, 1);
  await auth.logout();
});

test('AI 請求實際包含官方資料包，保留網路引用且不發出其他請求', async () => {
  const { queryAI } = await import('./ai.ts');
  const auth = new ChatGPTAuth(mockFetch, memoryVault()); await connect(auth);
  const evidence = { version: 'market-evidence-0.1.0' as const, collectedAt: new Date().toISOString(), mode: 'after_hours' as const, quality: 'unavailable' as const, screening: 'incomplete' as const, universeCount: 0, poolCount: 0, technicalCount: 0, markets: [], stocks: [], sources: [], limitations: ['合成資料'] };
  const originalFetch = globalThis.fetch;
  let requestBody: any;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/models')) return Response.json({ models: [{ slug: 'test', display_name: '合成模型', visibility: 'list' }] });
    assert.equal(url, 'https://api.openai.com/v1/responses');
    requestBody = JSON.parse(String(init?.body));
    return new Response(stream([{ type: 'response.completed', response: { output: [{ content: [{ type: 'output_text', text: '合成回覆', annotations: [{ type: 'url_citation', title: '證交所', url: 'https://www.twse.com.tw/' }] }] }] } }]));
  };
  try {
    const result = await queryAI(auth, { prompt: '合成問題', model: 'test', webSearch: true, includeResearch: false }, undefined, 'oaiapp_synthetic', evidence);
    assert.deepEqual(JSON.parse(requestBody.input[0].content).officialMarketResearch, evidence);
    assert.match(requestBody.instructions, /跨產業/);
    assert.match(requestBody.instructions, /固定條件分類/);
    assert.match(requestBody.instructions, /重讀失敗不否定已取得資料/);
    assert.deepEqual(result.marketResearch, evidence); assert.equal(result.sources.length, 1);
  } finally { globalThis.fetch = originalFetch; await auth.logout(); }
});

test('桌面登入票證一次性、兩分鐘到期、限量及清除', () => {
 const bridge=new BrowserLoginBridge(),pending={url:'https://auth.openai.com/api/accounts/authorize?state=synthetic',browser:'synthetic-browser'};
 const ticket=bridge.issue(pending,1000);assert.match(ticket,/^[A-Za-z0-9_-]{43}$/);
 assert.deepEqual(bridge.consume(ticket,1001),pending);assert.equal(bridge.consume(ticket,1002),undefined);
 assert.equal(bridge.consume(bridge.issue(pending,1000),121000),undefined);
 assert.throws(()=>bridge.issue({...pending,url:'https://example.invalid/'},1000),/網域/);
 const tickets=Array.from({length:5},()=>bridge.issue(pending,1000));assert.throws(()=>bridge.issue(pending,1001),/過多/);
 bridge.clear();assert.equal(bridge.consume(tickets[0],1002),undefined);assert.ok(bridge.issue(pending,1003));
});
test('桌面瀏覽器交接保留 OAuth 綁定',async()=>{
 const auth=new ChatGPTAuth(mockFetch,memoryVault()),bridge=new BrowserLoginBridge();
 const pending=await auth.start('http://127.0.0.1:3100/auth/callback');
 const url=new URL(pending.url);expectedNonce=url.searchParams.get('nonce')!;
 const transfer=bridge.consume(bridge.issue(pending))!;
 await auth.callback(new URLSearchParams({state:url.searchParams.get('state')!,code:'synthetic-code',client_id:'oaiapp_synthetic'}),transfer.browser);
 assert.equal((await auth.status()).connected,true);await auth.logout();
});

test('休市與開休市未確認均保存略過、每日去重，不讀行情也不呼叫AI',async()=>{
 const auth=new ChatGPTAuth(mockFetch,memoryVault());await connect(auth);let calls=0,collected=0;
 try{for(const state of ['closed','unknown'] as const){
  await mutate(db=>{db.schedule={...defaultSchedule(),enabled:true,model:'test',ownerProfileId:'oaiapp_synthetic'};});
  const jobs=new LiveQueryJobs(auth,async()=>{calls++;return {output:'不應執行',sources:[]};},async()=>{collected++;throw new Error('不應抓行情');},async now=>({date:taipeiClock(now??new Date()).date,state,reason:'合成'+state,checkedAt:new Date().toISOString(),sources:['https://www.twse.com.tw/']}));
  const count=(await read()).queries.length;await jobs.tick(new Date('2026-10-16T04:00:00Z'));await jobs.tick(new Date('2026-10-16T04:01:00Z'));
  const db=await read();assert.equal(db.queries.length,count+1);assert.equal(db.queries.at(-1)?.status,state==='closed'?'market_closed':'market_unknown');assert.equal(db.queries.at(-1)?.marketResearch,undefined);assert.equal(db.queries.at(-1)?.marketCheck?.state,state);assert.equal(db.schedule.lastAttemptDate,'2026-10-16');
 }}finally{await auth.logout();}
 assert.equal(calls,0);assert.equal(collected,0);
});

import { initialPaper } from './paper.ts';
import express from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { read, mutate } from './store.ts';
import { select, VERSION } from './strategy.ts';
import { ChatGPTAuth, BrowserLoginBridge } from './auth.ts';
import { listModels } from './ai.ts';
import { QueryJobs } from './jobs.ts';
import { instance, port, base, dataDirectory, staticDirectory, devOrigin, oauthCookie } from './config.ts';
import { UsageMonitor } from './usage.ts';
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  if (req.hostname !== '127.0.0.1') { res.status(403).json({ error: '請使用 127.0.0.1 的本機網址開啟' }); return; }
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (req.path.startsWith('/api') || req.path.startsWith('/auth')) res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'POST') {
    const origin = req.headers.origin;
    if ((origin && ![base, devOrigin].includes(origin)) || !req.is('application/json')) { res.status(403).json({ error: '請由此版本的本機工具操作，不接受其他網站或版本的變更請求' }); return; }
  }
  next();
});
app.use(express.json({ limit: '30mb' }));
const auth = new ChatGPTAuth(), jobs = new QueryJobs(auth);
const usage = new UsageMonitor();
const desktopMode = Boolean(process.env.DESKTOP_INSTANCE_ID);
const loginBridge = new BrowserLoginBridge();
const setLoginCookie = (res: express.Response, browser: string) => res.cookie(oauthCookie, browser, { httpOnly: true, sameSite: 'lax', path: '/auth/callback', maxAge: 600000 });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => { const d = new Date(s + 'T00:00:00Z'); return !isNaN(+d) && d.toISOString().slice(0, 10) === s; }, '日期不存在');
const price = z.number().finite().positive();
const bar = z.object({ code: z.string().regex(/^\d{4}$/), name: z.string().min(1).max(100), market: z.enum(['TWSE', 'TPEX']), date, open: price, high: price, low: price, close: price, volume: z.number().finite().nonnegative() }).refine(b => b.high >= Math.max(b.open, b.close, b.low) && b.low <= Math.min(b.open, b.close), 'OHLC 高低價不合理');
const wrap = (fn: express.RequestHandler): express.RequestHandler => (req, res, next) => { Promise.resolve(fn(req, res, next)).catch(next); };
app.get('/api/health', (_req, res) => { res.json({ application: 'taiwan-stock-lab', version: '0.10.0', instanceId: process.env.DESKTOP_INSTANCE_ID ?? '', running: jobs.running }); });
app.get('/api/state', wrap(async (_req, res) => {
  const db = await read(); res.json({ version: '0.10.0', instance: { role: instance, port, dataDirectory }, bars: db.bars.length, dates: [...new Set(db.bars.map(b => b.date))].sort().reverse(), trades: db.trades, runs: db.runs.slice(-30).reverse(), noonEnabled: false, auth: await auth.status(), queries: db.queries.slice(-50).reverse(), schedule: db.schedule, paper: db.paper ?? initialPaper() });
}));
app.post('/api/auth/start', wrap(async (req, res) => {
  const { profileId } = z.object({ profileId: z.string().max(200).optional() }).parse(req.body);
  const pending = await auth.start(`${base}/auth/callback`, profileId);
  if (desktopMode) { const ticket = loginBridge.issue(pending); res.json({ url: base + '/auth/desktop-launch?ticket=' + ticket }); }
  else { setLoginCookie(res, pending.browser); res.json({ url: pending.url }); }
}));
app.get('/auth/desktop-launch', (req, res) => {
  const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : '';
  const pending = desktopMode && /^[A-Za-z0-9_-]{43}$/.test(ticket) ? loginBridge.consume(ticket) : undefined;
  if (!pending) { res.status(400).type('text/plain').send('登入連結已失效，請回到桌面工具重新登入。'); return; }
  setLoginCookie(res, pending.browser); res.redirect(pending.url);
});
app.get('/auth/callback', wrap(async (req, res) => {
  // Bind the OAuth response to the initiating browser; never return credentials to JS.
  const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(`${oauthCookie}=`))?.slice(oauthCookie.length + 1);
  res.clearCookie(oauthCookie, { path: '/auth/callback' });
  try {
    await auth.callback(new URL(req.originalUrl, base).searchParams, cookie); loginBridge.clear();
    if (desktopMode) { parentPort?.postMessage({ type: 'auth-completed', ok: true }); res.type('text/plain').send('登入完成。請回到「每日台股研究室」桌面視窗；此分頁可以關閉。'); }
    else res.redirect('/?login=success');
  } catch (e) {
    if (desktopMode) { parentPort?.postMessage({ type: 'auth-completed', ok: false }); res.status(400).type('text/plain').send('登入未完成：' + (e instanceof Error ? e.message : '請回桌面工具重試')); }
    else res.redirect('/?login=error&reason=' + encodeURIComponent(e instanceof Error ? e.message : '登入未完成'));
  }
}));
app.post('/api/auth/logout', wrap(async (_req, res) => {
  loginBridge.clear();
  await mutate(db => { db.schedule.enabled = false; });
  res.json(await auth.logout());
}));
app.get('/api/models', wrap(async (_req, res) => { res.json(await listModels(auth)); }));
app.get('/api/usage', wrap(async (_req, res) => { res.json(await usage.get()); }));
app.post('/api/usage/refresh', wrap(async (_req, res) => { res.json(await usage.get(true)); }));
app.post('/api/paper/settings', wrap(async (req,res)=>{const {enabled}=z.object({enabled:z.boolean()}).parse(req.body);const paper=await mutate(db=>{db.paper??=initialPaper();db.paper.enabled=enabled;return db.paper;});res.json(paper);}));
const queryInput = z.object({ trendMode:z.boolean().optional(), paperTrade: z.boolean().optional(), prompt: z.string().trim().min(1).max(4000), model: z.string().min(1).max(200), webSearch: z.boolean(), includeResearch: z.boolean() });
app.post('/api/queries', wrap(async (req, res) => { const job = await jobs.manual(queryInput.parse(req.body)); res.status(202).json(job); }));
app.post('/api/schedule', wrap(async (req, res) => {
  const input = queryInput.extend({ model: z.string().max(200), enabled: z.boolean(), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), weekdays: z.array(z.number().int().min(1).max(5)).min(1).max(5) }).parse(req.body);
  if(input.paperTrade&&input.time!=='12:00')throw new Error('正式虛擬趨勢交易固定12:00分析，次交易日11:00檢驗');
  const account = await auth.status();
  if (input.enabled) {
    if (!account.connected || !account.planEnabled) throw new Error('啟用排程前，請先登入並授權使用 ChatGPT 額度');
    const models = await listModels(auth);
    if (!models.some(m => m.id === input.model)) throw new Error('排程模型不在此帳號的可用清單');
    if (account.profileId !== (await auth.status()).profileId) throw new Error('帳號已切換，請重新儲存');
  }
  const schedule = await mutate(db => { db.schedule = { ...input, weekdays: [...new Set(input.weekdays)].sort(), ownerProfileId: account.profileId, lastAttemptDate: db.schedule.lastAttemptDate }; return db.schedule; });
  res.json(schedule);
}));
app.post('/api/import', wrap(async (req, res) => {
  const rows = z.array(bar).min(1).max(100000).parse(req.body);
  const result = await mutate(db => {
    const map = new Map(db.bars.map(b => [`${b.market}:${b.code}:${b.date}`, b]));
    let added = 0, skipped = 0;
    for (const b of rows) { const key = `${b.market}:${b.code}:${b.date}`; const old = map.get(key); if (old) { if (JSON.stringify(old) !== JSON.stringify(b)) throw new Error(`資料衝突：${key}，既有行情不允許覆寫`); skipped++; } else { map.set(key, b); added++; } }
    db.bars = [...map.values()]; return { added, skipped };
  }); res.json(result);
}));
app.post('/api/analyze', wrap(async (req, res) => {
  const input = z.object({ date }).parse(req.body);
  const run = await mutate(db => {
    if (!db.bars.some(b => b.date === input.date)) throw new Error('指定日期沒有行情');
    const run = { id: randomUUID(), createdAt: new Date().toISOString(), date: input.date, strategy: VERSION, mode: 'EOD_RESEARCH' as const, ...select(db.bars, input.date) };
    db.runs.push(run); return run;
  }); res.json(run);
}));
app.post('/api/trades', wrap(async (req, res) => {
  const input = z.object({ code: z.string().regex(/^\d{4}$/), buyDate: date, buyPrice: price, quantity: z.number().int().positive(), sellDate: date.optional(), sellPrice: price.optional(), fees: z.number().finite().nonnegative(), note: z.string().max(2000).default('') }).refine(t => Boolean(t.sellDate) === Boolean(t.sellPrice), '賣出日期及價格需同時填寫').refine(t => !t.sellDate || t.sellDate > t.buyDate, '禁止當沖，賣出日期需晚於買進日期').parse(req.body);
  const trade = { id: randomUUID(), ...input }; await mutate(db => db.trades.push(trade)); res.json(trade);
}));
app.use('/api', (_req, res) => { res.status(404).json({ error: 'API 不存在' }); });
app.use(express.static(staticDirectory));
app.get('/', (_req, res) => { res.sendFile(resolve(staticDirectory, 'index.html')); });
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(400).json({ error: err instanceof Error ? err.message : '處理失敗' }); });
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`每日台股研究室（${instance === 'codex' ? 'Codex 預覽' : '你的專用版本'}）：${base}`);
  console.log(`資料位置：${dataDirectory}`);
  void jobs.start().catch(() => { console.error('排程初始化失敗，請檢查本機資料'); });
});
server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(error.code === 'EADDRINUSE' ? `${base} 已有服務在執行，請直接開啟該網址，或先停止該服務。你的版本使用 npm start；Codex 預覽使用 npm run start:codex。` : `服務啟動失敗：${error.message}`);
  process.exitCode = 1;
});
let stopping = false;
function stop() { if (stopping) return; stopping = true; jobs.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 7000).unref(); }
const parentPort = (process as typeof process & { parentPort?: { postMessage: (value: unknown) => void; on: (event: string, listener: (event: { data?: { type?: string } }) => void) => void } }).parentPort;
parentPort?.on('message', event => { if (event.data?.type === 'shutdown') stop(); });
process.on('SIGINT', stop); process.on('SIGTERM', stop);

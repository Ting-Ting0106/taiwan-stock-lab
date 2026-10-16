import { classifyCandidates } from './screening.ts';
import type { Bar } from '../shared/model';
import type { MarketResearch, MarketStock, MarketSource, MarketIndicators } from '../shared/market';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { dataDirectory } from './config.ts';

const endpoints = {
  TWSE: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
  TPEX: 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',
  listed: 'https://openapi.twse.com.tw/v1/opendata/t187ap03_L',
  otc: 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O',
};
const industryNames: Record<string, string> = { '01': '水泥', '02': '食品', '03': '塑膠', '04': '紡織', '05': '電機機械', '06': '電器電纜', '10': '鋼鐵', '15': '航運', '17': '金融保險', '22': '生技醫療', '24': '半導體', '25': '電腦週邊', '26': '光電', '27': '通信網路', '28': '電子零組件', '29': '資訊服務', '31': '其他電子' };
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
export function numeric(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim().replace(/,/g, '');
  if (!/^[+-]?\d+(\.\d+)?$/.test(text)) return null;
  const n = Number(text); return Number.isFinite(n) ? n : null;
}
export function marketDate(value: unknown): string {
  const text = String(value ?? '').replace(/\//g, '');
  if (!/^\d{7,8}$/.test(text)) throw new Error('來源日期格式不符');
  const year = text.length === 7 ? Number(text.slice(0, 3)) + 1911 : Number(text.slice(0, 4));
  const result = year + '-' + text.slice(-4, -2) + '-' + text.slice(-2);
  if (new Date(result + 'T00:00:00Z').toISOString().slice(0, 10) !== result) throw new Error('來源日期不存在');
  return result;
}
export function taipeiNow(now: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (key: string) => parts.find(p => p.type === key)!.value;
  return { date: get('year') + '-' + get('month') + '-' + get('day'), minutes: Number(get('hour')) * 60 + Number(get('minute')), weekday: new Date(get('year') + '-' + get('month') + '-' + get('day') + 'T00:00:00Z').getUTCDay() };
}
function validOHLC(row: { open: number; high: number; low: number; close: number; volume: number }) {
  return [row.open, row.high, row.low, row.close].every(n => n > 0 && Number.isFinite(n)) && Number.isFinite(row.volume) && row.volume >= 0 && row.high >= Math.max(row.open, row.close, row.low) && row.low <= Math.min(row.open, row.close);
}
export function parseSnapshot(payload: unknown, market: 'TWSE' | 'TPEX', companies: unknown, today: string): MarketStock[] {
  if (!Array.isArray(payload) || !Array.isArray(companies)) throw new Error('行情或公司分類不是陣列');
  const metadata = new Map<string, string>();
  for (const item of companies) {
    const code = market === 'TWSE' ? item['公司代號'] : item.SecuritiesCompanyCode;
    const sector = market === 'TWSE' ? item['產業別'] : item.SecuritiesIndustryCode;
    if (/^[1-9]\d{3}$/.test(String(code)) && /^\d{2}$/.test(String(sector))) metadata.set(String(code), String(sector));
  }
  if (!metadata.size) throw new Error('沒有可驗證的普通股產業分類');
  const stocks: MarketStock[] = [], seen = new Set<string>();
  for (const item of payload) {
    const code = String(market === 'TWSE' ? item.Code : item.SecuritiesCompanyCode);
    if (!metadata.has(code)) continue; // Exclude warrants, ETFs and unclassified instruments.
    try {
      const date = marketDate(item.Date);
      if (date > today) continue;
      const row = { open: numeric(market === 'TWSE' ? item.OpeningPrice : item.Open) ?? NaN, high: numeric(market === 'TWSE' ? item.HighestPrice : item.High) ?? NaN, low: numeric(market === 'TWSE' ? item.LowestPrice : item.Low) ?? NaN, close: numeric(market === 'TWSE' ? item.ClosingPrice : item.Close) ?? NaN, volume: numeric(market === 'TWSE' ? item.TradeVolume : item.TradingShares) ?? NaN };
      if (!validOHLC(row) || seen.has(code)) continue;
      const change = numeric(item.Change), previous = change === null ? null : row.close - change;
      const sector = metadata.get(code)!;
      stocks.push({ ...row, code, name: String(market === 'TWSE' ? item.Name : item.CompanyName).slice(0, 100), market, industry: sector + ' ' + (industryNames[sector] ?? '官方產業分類'), date, changePercent: previous !== null && previous > 0 && change !== null ? change / previous * 100 : null, historyCount: 0, signals: [], sources: [endpoints[market]], issues: [] });
      seen.add(code);
    } catch { /* Invalid row is excluded rather than repaired with inferred numbers. */ }
  }
  if (!stocks.length) throw new Error('沒有有效的普通股 OHLC 與成交股數');
  // A snapshot must not mix trading dates.
  const latest = stocks.reduce((d, s) => s.date > d ? s.date : d, '');
  return stocks.filter(s => s.date === latest);
}
export function choosePool(stocks: MarketStock[], prompt: string, limit = 12) {
  const explicit = stocks.filter(s => prompt.includes(s.name) || new RegExp('(^|[^0-9])' + s.code + '([^0-9]|$)').test(prompt.replace(/\b20\d{2}\b/g, '')));
  const rankedByStrength = stocks.filter(s => s.volume >= 1_000_000 && s.close * s.volume >= 50_000_000)
    .sort((a, b) => (b.changePercent ?? -100) - (a.changePercent ?? -100) || b.close * b.volume - a.close * a.volume || a.code.localeCompare(b.code));
  const ranked = [...explicit, ...rankedByStrength.filter(s => !explicit.includes(s))];
  const pool: MarketStock[] = [], sectors = new Map<string, number>();
  for (const stock of ranked) {
    if ((sectors.get(stock.industry) ?? 0) >= 2) continue;
    pool.push(stock); sectors.set(stock.industry, (sectors.get(stock.industry) ?? 0) + 1);
    if (pool.length >= limit) break;
  }
  // Ensure both verified markets participate when their eligible rows are available.
  for (const market of ['TWSE', 'TPEX'] as const) {
    if (!pool.some(s => s.market === market)) {
      const other = ranked.find(s => s.market === market && !pool.includes(s) && (sectors.get(s.industry) ?? 0) < 2);
      if (other) { if (pool.length >= limit) pool.pop(); pool.push(other); }
    }
  }
  return pool;
}
export function parseHistory(payload: any, stock: MarketStock, month: string, cutoff: string): Bar[] {
  const table = stock.market === 'TWSE' ? payload : payload?.tables?.[0];
  const fields: unknown = table?.fields;
  if (stock.market === 'TWSE' && payload?.stat !== 'OK') throw new Error('歷史行情狀態非 OK');
  if (!Array.isArray(fields) || !Array.isArray(table?.data)) throw new Error('歷史行情欄位或資料不符');
  const normalized = fields.map(f => String(f).replace(/\s/g, ''));
  const expected = stock.market === 'TWSE' ? ['日期', '成交股數', '成交金額', '開盤價', '最高價', '最低價', '收盤價'] : ['日期', '成交張數', '成交仟元', '開盤', '最高', '最低', '收盤'];
  if (!expected.every((f, i) => normalized[i] === f)) throw new Error('歷史行情欄位順序或單位已變更');
  const bars: Bar[] = [];
  for (const values of table.data) {
    const date = marketDate(values[0]);
    if (date.slice(0, 7) !== month) throw new Error('歷史行情回傳月份不符');
    if (date > cutoff) continue;
    const row: Bar = { code: stock.code, name: stock.name, market: stock.market, date, open: numeric(values[3]) ?? NaN, high: numeric(values[4]) ?? NaN, low: numeric(values[5]) ?? NaN, close: numeric(values[6]) ?? NaN, volume: (numeric(values[1]) ?? NaN) * (stock.market === 'TPEX' ? 1000 : 1) };
    if (!validOHLC(row)) throw new Error('歷史行情包含無效 OHLC 或成交量');
    bars.push(row);
  }
  return bars;
}
export function indicators(bars: Bar[]): MarketIndicators | undefined {
  if (bars.length < 60 || bars.some((b, i) => !validOHLC(b) || (i > 0 && b.date <= bars[i - 1].date))) return undefined;
  let k = 50, d = 50, fast = bars[0].close, slow = fast, signal = 0, dif = 0;
  bars.forEach((bar, i) => {
    fast += (bar.close - fast) * 2 / 13; slow += (bar.close - slow) * 2 / 27; dif = fast - slow; signal += (dif - signal) * 2 / 10;
    if (i >= 8) {
      const recent = bars.slice(i - 8, i + 1), low = Math.min(...recent.map(b => b.low)), high = Math.max(...recent.map(b => b.high));
      const rsv = high === low ? 50 : (bar.close - low) / (high - low) * 100;
      k = k * 2 / 3 + rsv / 3; d = d * 2 / 3 + k / 3;
    }
  });
  const volume = mean(bars.slice(-21, -1).map(b => b.volume));
  return { ma5: mean(bars.slice(-5).map(b => b.close)), ma10: mean(bars.slice(-10).map(b => b.close)), ma20: mean(bars.slice(-20).map(b => b.close)), ma60: mean(bars.slice(-60).map(b => b.close)), k, d, dif, signal, histogram: (dif - signal) * 2, volumeRatio: volume > 0 ? bars.at(-1)!.volume / volume : null };
}
export function parseQuotes(payload: any, stocks: MarketStock[], now: Date) {
  if (payload?.rtcode !== '0000' || !Array.isArray(payload.msgArray)) throw new Error('盤中行情回覆不完整');
  for (const stock of stocks) {
    const item = payload.msgArray.find((q: any) => q.c === stock.code && q.ex === (stock.market === 'TWSE' ? 'tse' : 'otc'));
    if (!item) { stock.issues.push('未回傳此股盤中報價'); continue; }
    const direct = numeric(item.z), price = direct !== null && direct > 0 ? direct : numeric(item.trade?.z);
    const time = direct !== null && direct > 0 ? item.t : item.trade?.t;
    if (price === null || price <= 0 || !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(String(time))) { stock.issues.push('無有效最近成交價或時間'); continue; }
    try {
      const date = marketDate(item.d), at = date + 'T' + time + '+08:00', age = +now - Date.parse(at);
      stock.quote = { price, at, kind: direct !== null && direct > 0 ? 'last' : 'recent-trade', fresh: date === taipeiNow(now).date && age >= -5000 && age <= 15 * 60000, bid: (numeric(String(item.b ?? '').split('_')[0]) ?? 0) > 0 ? numeric(String(item.b).split('_')[0]) : null, ask: (numeric(String(item.a ?? '').split('_')[0]) ?? 0) > 0 ? numeric(String(item.a).split('_')[0]) : null };
      const snapshotAt = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(String(item.t)) ? date + 'T' + item.t + '+08:00' : undefined;
      const open = numeric(item.o), high = numeric(item.h), low = numeric(item.l), volume = numeric(item.v);
      if (snapshotAt && date === taipeiNow(now).date && open !== null && high !== null && low !== null && volume !== null && open > 0 && low > 0 && high >= open && low <= open && high >= price && low <= price && high >= low && volume > 0) {
        Object.assign(stock.quote, { snapshotAt, open, high, low, cumulativeVolume: volume, volumeUnit: 'source-unverified' });
      } else stock.issues.push('盤中開高低或累計成交量缺漏／無效');
      if (stock.quote.bid === null || stock.quote.ask === null) stock.issues.push('缺有效最佳買價或賣價，可能無對手盤，不代表可成交');
      if (stock.quote.bid !== null && stock.quote.ask !== null && stock.quote.bid > stock.quote.ask) stock.issues.push('買賣價交錯，須重新確認報價');
      if (!stock.quote.fresh) stock.issues.push('報價非當日或超過 15 分鐘，不可作目前可買證據');
    } catch { stock.issues.push('盤中報價日期錯誤'); }
  }
}
type CacheValue = { expires: number; fetchedAt?: string; payload: unknown };
export class MarketCollector {
  private cache = new Map<string, CacheValue>();
  private loaded?: Promise<void>;
  private fetcher: typeof fetch;
  private cacheFile?: string;
  private pause: number;
  private limit: number;
  constructor(options: { fetcher?: typeof fetch; cacheFile?: string | null; pauseMs?: number; poolLimit?: number } = {}) {
    this.fetcher = options.fetcher ?? fetch; this.cacheFile = options.cacheFile === null ? undefined : options.cacheFile ?? resolve(dataDirectory, 'market-cache.json');
    this.pause = options.pauseMs ?? 400; this.limit = options.poolLimit ?? 12;
  }
  private async load() {
    this.loaded ??= (async () => {
      if (!this.cacheFile) return;
      try {
        const raw = await readFile(this.cacheFile, 'utf8'); if (raw.length > 25_000_000) return;
        for (const [url, entry] of Object.entries(JSON.parse(raw) as Record<string, CacheValue>)) {
          if (this.cache.size >= 250) break;
          if (entry?.expires > Date.now() && this.allowed(url)) this.cache.set(url, entry);
        }
      } catch { /* Missing or invalid noncredential cache is refetched. */ }
    })();
    await this.loaded;
  }
  private allowed(url: string) {
    const origin = new URL(url).origin;
    return ['https://openapi.twse.com.tw', 'https://www.twse.com.tw', 'https://www.tpex.org.tw', 'https://mis.twse.com.tw'].includes(origin);
  }
  async collect(prompt: string, now = new Date()): Promise<MarketResearch> {
    const startedAt = Date.now();
    await this.load();
    const clock = taipeiNow(now), intraday = clock.weekday >= 1 && clock.weekday <= 5 && clock.minutes >= 540 && clock.minutes < 810;
    const report: MarketResearch = { version: 'market-evidence-0.2.0', collectedAt: now.toISOString(), mode: intraday ? 'intraday' : 'after_hours', quality: 'unavailable', screening: 'incomplete', universeCount: 0, poolCount: 0, technicalCount: 0, markets: [], stocks: [], sources: [], limitations: [
      '初選只依最新官方收盤價量與產業分類，日線指標深入計算最多 12 檔；不是全市場技術掃描或買進推薦。',
      '歷史序列以官方各月份回傳資料為準，尚未透過交易日曆逐日核對缺日；不能當成完整回測資料集。',
      'MA 為日收盤簡單均線；KD(9,3,3) 初始 K/D=50；MACD EMA(12,26,9) 以首筆收盤初始化，柱狀=(DIF-訊號線)×2；至少 60 根，未還原除權息，結果可能與網站不同。',
      '上櫃月報成交張數×1000 為股，原表精度限千股，量比同用月報口徑；不與不同來源成交量拼接。',
      '盤中附最近成交、最佳買賣價、開高低及來源累計量；累計量 v 的單位尚未獨立核對，不換算、不混入日線量比。不假造內外盤，不宣稱已確認交易限制或可成交。',
      '報價 15 分鐘內僅表示新鮮度，不保證即時、下單價格或成交。交易日仍需核對公告。',
    ] };
    const deadline = AbortSignal.timeout(150000);
    const get = async (url: string, ttl: number): Promise<unknown> => {
      const source: MarketSource = { url, fetchedAt: new Date().toISOString(), status: 'ok' }; report.sources.push(source);
      try {
        if (!this.allowed(url)) throw new Error('不允許的資料來源');
        const cached = this.cache.get(url);
        if (cached && cached.expires > Date.now()) { source.fetchedAt = cached.fetchedAt ?? source.fetchedAt; return cached.payload; }
        const response = await this.fetcher(url, { signal: AbortSignal.any([deadline, AbortSignal.timeout(15000)]), redirect: 'error', headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const raw = await response.text(); if (raw.length > 10_000_000) throw new Error('來源超過大小限制');
        let payload: unknown;
        try { payload = JSON.parse(raw); } catch { throw new Error('來源未回傳 JSON（可能是存取限制或格式變更）'); }
        if (ttl > 0) this.cache.set(url, { expires: Date.now() + ttl, fetchedAt: source.fetchedAt, payload });
        return payload;
      } catch (e) {
        source.status = 'error'; source.error = e instanceof Error ? e.message.slice(0, 180) : '資料取得失敗'; throw new Error(source.error);
      }
    };
    const available: MarketStock[] = [];
    await Promise.all((['TWSE', 'TPEX'] as const).map(async market => {
      try {
        const [snapshot, companies] = await Promise.allSettled([get(endpoints[market], 5 * 60000), get(market === 'TWSE' ? endpoints.listed : endpoints.otc, 24 * 3600000)]);
        if (snapshot.status === 'rejected') throw snapshot.reason;
        if (companies.status === 'rejected') throw companies.reason;
        const rows = parseSnapshot(snapshot.value, market, companies.value, clock.date).filter(s => !intraday || s.date < clock.date);
        if (!rows.length) throw new Error('盤中來源僅有未完成的當日日線，已排除');
        available.push(...rows); report.markets.push({ market, count: rows.length, date: rows[0].date });
      } catch (e) { report.markets.push({ market, count: 0 }); report.limitations.push(market + ' 來源不可用：' + (e instanceof Error ? e.message : '格式錯誤')); }
    }));
    report.universeCount = available.length; report.stocks = choosePool(available, prompt, this.limit); report.poolCount = report.stocks.length;
    const cutoff = intraday || clock.minutes < 870 ? new Date(Date.parse(clock.date + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10) : clock.date;
    const months: string[] = [];
    const date = new Date(clock.date + 'T00:00:00Z');
    for (let i = 0; i < 6; i++) months.push(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
    let cursor = 0;
    const worker = async () => {
      while (cursor < report.stocks.length) {
        const stock = report.stocks[cursor++], bars: Bar[] = [];
        let historyFailed = false;
        for (const month of months) {
          if (deadline.aborted) { stock.issues.push('資料準備超過 150 秒，部分月份未完成'); historyFailed = true; break; }
          const url = stock.market === 'TWSE' ? 'https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=' + month.replace('-', '') + '01&stockNo=' + stock.code : 'https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=' + stock.code + '&date=' + month.replace('-', '/') + '/01&response=json';
          stock.sources.push(url);
          try { bars.push(...parseHistory(await get(url, month === months[0] ? 5 * 60000 : 24 * 3600000), stock, month, cutoff)); }
          catch (e) { this.cache.delete(url); stock.issues.push(month + ' 歷史資料失敗：' + (e instanceof Error ? e.message : '格式錯誤')); historyFailed = true; }
          if (this.pause) await new Promise(resolve => setTimeout(resolve, this.pause));
        }
        bars.sort((a, b) => a.date.localeCompare(b.date)); stock.historyCount = bars.length; stock.historyDate = bars.at(-1)?.date;
        if (historyFailed) { stock.issues.push('月份缺漏，不計算可能失真的指標'); continue; }
        if (bars.at(-1)?.date !== stock.date) { stock.issues.push('歷史末日與收盤快照日期不符，需等待來源同步'); continue; }
        if (Math.abs(bars.at(-1)!.close - stock.close) > 0.005) { stock.issues.push('歷史收盤與快照收盤不一致，暫不計算指標'); continue; }
        stock.indicators = indicators(bars);
        if (!stock.indicators) { stock.issues.push('不足 60 根有效且依日期排序的日 K'); continue; }
        const i = stock.indicators;
        if (stock.close > i.ma20) stock.signals.push('收盤高於 MA20');
        if (i.ma5 > i.ma20) stock.signals.push('MA5 高於 MA20');
        if (i.k > i.d && i.k < 80) stock.signals.push('KD 偏多且 K<80');
        if (i.dif > i.signal) stock.signals.push('DIF 高於訊號線');
        if (i.volumeRatio !== null && i.volumeRatio > 1.2) stock.signals.push('量比>1.2');
        stock.score = stock.signals.length;
      }
    };
    await Promise.all([worker(), worker()]);
    if (intraday && report.stocks.length && !deadline.aborted) {
      const url = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=' + report.stocks.map(s => (s.market === 'TWSE' ? 'tse_' : 'otc_') + s.code + '.tw').join('|') + '&json=1&delay=0';
      try { parseQuotes(await get(url, 0), report.stocks, new Date(+now + Date.now() - startedAt)); for (const stock of report.stocks) stock.sources.push(url); }
      catch (e) { report.limitations.push('盤中行情未取得：' + (e instanceof Error ? e.message : '格式錯誤')); }
    }
    classifyCandidates(report, new Date(+now + Date.now() - startedAt));
    report.technicalCount = report.stocks.filter(s => s.indicators).length;
    report.screening = report.poolCount > 0 && report.technicalCount === report.poolCount ? 'completed' : 'incomplete';
    report.quality = !report.poolCount ? 'unavailable' : report.screening === 'incomplete' || report.markets.some(m => !m.count) ? 'partial' : intraday && report.stocks.every(s => s.quote?.fresh && s.quote.bid !== null && s.quote.ask !== null && s.quote.bid <= s.quote.ask) ? 'intraday_available' : 'eod_only';
    if (report.quality === 'eod_only' && intraday) report.limitations.push('日線已計算但盤中新報價不完整，不代表今日已可下單。');
    if (available.some(s => Date.parse(clock.date) - Date.parse(s.date) > 4 * 86400000)) { report.quality = 'partial'; report.limitations.push('部分市場日線超過四個日曆日，需核對休市或來源延遲。'); }
    for (const [url, entry] of this.cache) if (entry.expires < Date.now()) this.cache.delete(url);
    while (this.cache.size > 250) this.cache.delete(this.cache.keys().next().value!);
    if (this.cacheFile) try {
      await mkdir(resolve(this.cacheFile, '..'), { recursive: true });
      await writeFile(this.cacheFile + '.tmp', JSON.stringify(Object.fromEntries(this.cache)));
      await rename(this.cacheFile + '.tmp', this.cacheFile);
    } catch { report.limitations.push('本機行情快取保存失敗，下次可能重新抓取。'); }
    return report;
  }
}
const collector = new MarketCollector();
export const collectMarketResearch = (prompt: string) => collector.collect(prompt);

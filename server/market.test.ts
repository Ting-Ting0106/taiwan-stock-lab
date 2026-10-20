import { classifyCandidates } from './screening.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarketCollector, indicators, marketDate, numeric, parseSnapshot, parseHistory, parseQuotes, choosePool } from './market.ts';
import type { Bar } from '../shared/model';
import type { MarketStock } from '../shared/market';

function stock(code = '2330', market: 'TWSE' | 'TPEX' = 'TWSE', industry = '24 半導體'): MarketStock {
  return { code, name: code === '2330' ? '台積電' : '測試' + code, market, industry, date: '2026-10-15', open: 100, high: 110, low: 90, close: 100, volume: 1_500_000, changePercent: 1, historyCount: 0, sources: [], issues: [], signals: [] };
}
const bars: Bar[] = Array.from({ length: 60 }, (_, i) => ({ code: '9999', name: '合成', market: 'TWSE', date: new Date(Date.UTC(2026, 6, i + 1)).toISOString().slice(0, 10), open: 100, high: 110, low: 90, close: 100, volume: 1000 }));
test('官方數字與日期拒絕缺漏，KD/MACD/均線有可核對數值', () => {
  assert.equal(numeric('--'), null); assert.equal(numeric(''), null); assert.equal(numeric('1,500'), 1500);
  assert.equal(marketDate('115/10/15'), '2026-10-15'); assert.throws(() => marketDate('1150230'));
  const flat = indicators(bars)!;
  assert.equal(flat.ma60, 100); assert.equal(flat.k, 50); assert.equal(flat.d, 50); assert.equal(flat.dif, 0); assert.equal(flat.signal, 0); assert.equal(flat.histogram, 0); assert.equal(flat.volumeRatio, 1);
  const rising = bars.map((b, i) => ({ ...b, open: 101 + i, close: 101 + i, high: 102 + i, low: 100 + i, volume: i === 59 ? 2000 : 1000 }));
  const result = indicators(rising)!;
  assert.equal(result.ma5, 158); assert.equal(result.ma10, 155.5); assert.equal(result.ma20, 150.5); assert.equal(result.ma60, 130.5); assert.equal(result.volumeRatio, 2);
  const ema = (alpha: number) => 160 - ((1 - alpha) / alpha) * (1 - (1 - alpha) ** 59);
  assert.ok(Math.abs(result.dif - (ema(2 / 13) - ema(2 / 27))) < 1e-9);
  assert.equal(indicators(bars.slice(1)), undefined);
  assert.equal(indicators([...bars.slice(0, -1), bars[0]]), undefined);
});
test('初選跨產業，提到台積電也不只查台積電，不把 ETF 列為普通股', () => {
  const rows: MarketStock[] = Array.from({ length: 18 }, (_, i) => ({ ...stock(String(2300 + i), i % 2 ? 'TPEX' : 'TWSE', String(24 + Math.floor(i / 3))), changePercent: 20 - i }));
  rows.push(stock());
  const pool = choosePool(rows, '不要只看台積電', 12);
  assert.equal(pool.length, 12); assert.ok(pool.some(s => s.code === '2330'));
  assert.ok(new Set(pool.map(s => s.industry)).size >= 5);
  assert.ok(pool.some(s => s.market === 'TPEX'));
  for (const sector of new Set(pool.map(s => s.industry))) assert.ok(pool.filter(s => s.industry === sector).length <= 2);
  const snapshot = parseSnapshot([
    { Date: '1151015', Code: '2330', Name: '台積電', OpeningPrice: '100', HighestPrice: '110', LowestPrice: '90', ClosingPrice: '100', TradeVolume: '1500000', Change: '1' },
    { Date: '1151015', Code: '0050', Name: 'ETF', OpeningPrice: '100', HighestPrice: '110', LowestPrice: '90', ClosingPrice: '100', TradeVolume: '1500000' },
  ], 'TWSE', [{ 公司代號: '2330', 產業別: '24' }], '2026-10-16');
  assert.equal(snapshot.length, 1); assert.equal(snapshot[0].volume, 1_500_000);
});
test('上櫃歷史量由張轉股，欄位改變與錯月份不可靜默接受，當日未完成 K 被排除', () => {
  const payload = { tables: [{ fields: ['日 期', '成交張數', '成交仟元', '開盤', '最高', '最低', '收盤'], data: [['115/10/15', '1,500', '150000', '100', '110', '90', '100'], ['115/10/16', '999', '0', '100', '110', '90', '100']] }] };
  const parsed = parseHistory(payload, stock('6488', 'TPEX'), '2026-10', '2026-10-15');
  assert.equal(parsed.length, 1); assert.equal(parsed[0].volume, 1_500_000);
  assert.throws(() => parseHistory(payload, stock('6488', 'TPEX'), '2026-09', '2026-10-15'), /月份/);
  payload.tables[0].fields[1] = '成交股數';
  assert.throws(() => parseHistory(payload, stock('6488', 'TPEX'), '2026-10', '2026-10-15'), /單位/);
});
test('盤中報價用成交自身時間驗證，空值不補成收盤價', () => {
  const stocks = [stock(), stock('6488', 'TPEX'), stock('9999')];
  parseQuotes({ rtcode: '0000', msgArray: [
    { c: '2330', ex: 'tse', d: '20261016', z: '-', t: '09:50:00', trade: { z: '101', t: '09:48:00' }, b: '100_99_', a: '102_103_' },
    { c: '6488', ex: 'otc', d: '20261015', z: '100', t: '13:30:00' },
    { c: '9999', ex: 'tse', d: '20261016', z: '-', t: '09:50:00' },
  ] }, stocks, new Date('2026-10-16T01:50:00Z'));
  assert.equal(stocks[0].quote?.fresh, true); assert.equal(stocks[0].quote?.kind, 'recent-trade'); assert.match(stocks[0].quote!.at, /09:48:00/);
  assert.equal(stocks[1].quote?.fresh, false); assert.equal(stocks[2].quote, undefined);
});

function fixtureFetcher(failMonth = false) {
  const calls: string[] = [];
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input)); calls.push(url.href);
    if (url.pathname.endsWith('/STOCK_DAY_ALL')) return Response.json([{ Date: '1151015', Code: '2330', Name: '台積電', OpeningPrice: '100', HighestPrice: '110', LowestPrice: '90', ClosingPrice: '100', TradeVolume: '1500000', Change: '1' }]);
    if (url.pathname.endsWith('/tpex_mainboard_daily_close_quotes')) return Response.json([{ Date: '1151015', SecuritiesCompanyCode: '6488', CompanyName: '環球晶', Open: '100', High: '110', Low: '90', Close: '100', TradingShares: '1500000', Change: '1' }]);
    if (url.pathname.endsWith('/t187ap03_L')) return Response.json([{ 公司代號: '2330', 產業別: '24' }]);
    if (url.pathname.endsWith('/mopsfin_t187ap03_O')) return Response.json([{ SecuritiesCompanyCode: '6488', SecuritiesIndustryCode: '24' }]);
    if (url.pathname.endsWith('/getStockInfo.jsp')) return Response.json({ rtcode: '0000', msgArray: ['2330', '6488'].map(c => ({ c, ex: c === '2330' ? 'tse' : 'otc', d: '20261016', z: '101', t: '09:49:59', b: '100_', a: '102_' })) });
    const otc = url.pathname.endsWith('/tradingStock');
    const parameter = url.searchParams.get('date')!;
    const month = Number(otc ? parameter.split('/')[1] : parameter.slice(4, 6));
    if (failMonth && !otc && month === 9) return new Response('unavailable', { status: 503 });
    const fields = otc ? ['日 期', '成交張數', '成交仟元', '開盤', '最高', '最低', '收盤'] : ['日期', '成交股數', '成交金額', '開盤價', '最高價', '最低價', '收盤價'];
    const data = [];
    for (let day = 1; day <= (month === 10 ? 15 : 28); day++) {
      if ([0, 6].includes(new Date(Date.UTC(2026, month - 1, day)).getUTCDay())) continue;
      data.push(['115/' + String(month).padStart(2, '0') + '/' + String(day).padStart(2, '0'), otc ? '1500' : '1500000', '0', '100', '110', '90', '100']);
    }
    return Response.json(otc ? { tables: [{ fields, data }] } : { stat: 'OK', fields, data });
  };
  return { fetcher, calls };
}
test('完整流程不呼叫 OpenAI、快取重用，官方資料與日線計算可供 AI 使用', async () => {
  const { fetcher, calls } = fixtureFetcher();
  const collector = new MarketCollector({ fetcher, cacheFile: null, pauseMs: 0, poolLimit: 2 });
  const now = new Date('2026-10-16T01:50:00Z');
  const report = await collector.collect('跨產業', now);
  assert.equal(report.universeCount, 2); assert.equal(report.technicalCount, 2); assert.equal(report.screening, 'completed'); assert.equal(report.quality, 'intraday_available');
  assert.equal(report.stocks[0].indicators?.volumeRatio, 1); assert.equal(report.stocks[1].indicators?.volumeRatio, 1);
  assert.ok(report.stocks.every(s => s.score === 0)); // Complete evidence does not force buy candidates.
  assert.ok(calls.every(url => !url.includes('openai')));
  const before = calls.length;
  await collector.collect('跨產業', now);
  assert.equal(calls.length, before + 1); // Only the intraday quote is refetched.
});
test('單月 HTTP 失敗保留診斷且不跨缺口計算指標，另一市場仍可處理', async () => {
  const { fetcher } = fixtureFetcher(true);
  const report = await new MarketCollector({ fetcher, cacheFile: null, pauseMs: 0, poolLimit: 2 }).collect('跨產業', new Date('2026-10-16T01:50:00Z'));
  assert.equal(report.quality, 'partial'); assert.equal(report.screening, 'incomplete');
  assert.equal(report.stocks.find(s => s.market === 'TWSE')?.indicators, undefined);
  assert.ok(report.stocks.find(s => s.market === 'TPEX')?.indicators);
  assert.ok(report.sources.some(s => s.status === 'error' && s.error === 'HTTP 503'));
});

test('全部來源失敗有診斷，不回填示例行情或宣稱完成', async () => {
  const report = await new MarketCollector({ cacheFile: null, pauseMs: 0, fetcher: async () => new Response('<html>blocked</html>', { status: 403 }) }).collect('跨產業', new Date('2026-10-16T01:50:00Z'));
  assert.equal(report.quality, 'unavailable'); assert.equal(report.screening, 'incomplete');
  assert.equal(report.poolCount, 0); assert.equal(report.stocks.length, 0);
  assert.ok(report.sources.every(s => s.status === 'error' && s.error === 'HTTP 403'));
});

test('盤中開高低及累計量只接受有效同日資料，不由缺值推估',()=>{
 const stocks=[stock()];const now=new Date('2026-10-16T04:00:00Z');
 parseQuotes({rtcode:'0000',msgArray:[{c:'2330',ex:'tse',d:'20261016',t:'11:59:59',z:'101',b:'100_',a:'102_',o:'100',h:'103',l:'99',v:'3000'}]},stocks,now);
 assert.equal(stocks[0].quote?.open,100);assert.equal(stocks[0].quote?.cumulativeVolume,3000);assert.equal(stocks[0].quote?.volumeUnit,'source-unverified');
 parseQuotes({rtcode:'0000',msgArray:[{c:'2330',ex:'tse',d:'20261016',t:'11:59:59',z:'101',o:'-',h:'103',l:'99',v:'-'}]},stocks,now);assert.equal(stocks[0].quote?.open,undefined);
});
test('固定分類區分條件候選、缺資料、規則排除；最多三檔且不為湊數改門檻',()=>{
 const now=new Date('2026-10-16T04:00:00Z');
 const good=()=>({...stock(),indicators:{ma5:99,ma10:98,ma20:95,ma60:90,k:60,d:50,dif:2,signal:1,histogram:2,volumeRatio:2},score:5,historyDate:'2026-10-15',quote:{price:101,at:'2026-10-16T11:59:59+08:00',kind:'last' as const,fresh:true,bid:100,ask:102,snapshotAt:'2026-10-16T11:59:59+08:00',open:100,high:103,low:99,cumulativeVolume:3000}});
 const stocks:Array<MarketStock>=Array.from({length:4},(_,i)=>({...good(),code:String(2300+i)}));
 stocks.push({...good(),code:'3000',quote:undefined},{...good(),code:'3001',score:3},{...good(),code:'3002',quote:{...good().quote,price:99}},{...good(),code:'3003',indicators:undefined},{...good(),code:'3004',quote:{...good().quote,at:'2026-10-16T09:00:00+08:00'}});
 const report:import('../shared/market').MarketResearch={version:'market-evidence-0.2.0',collectedAt:now.toISOString(),mode:'intraday',quality:'partial',screening:'incomplete',universeCount:9,poolCount:9,technicalCount:8,markets:[],stocks,sources:[],limitations:[]};
 const result=classifyCandidates(report,now);assert.equal(result.conditional,7);assert.equal(result.selected.length,3);assert.equal(result.pending,1);assert.equal(result.excluded,1);assert.equal(result.technicalPassed,7);
 assert.equal(stocks[4].assessment?.status,'conditional');assert.equal(stocks[6].assessment?.status,'conditional');
 report.mode='after_hours';const after=classifyCandidates(report,now);assert.equal(stocks[4].assessment?.status,'conditional');assert.equal(after.selected.length,3);
 stocks.forEach(s=>s.score=0);assert.equal(classifyCandidates(report,now).selected.length,0);
});

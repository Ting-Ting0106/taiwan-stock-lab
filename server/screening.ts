import type { MarketResearch } from '../shared/market';

// Evidence classification, not a probability model or an order instruction.
export function classifyCandidates(report: MarketResearch, now = new Date()) {
 const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
 for (const stock of report.stocks) {
  const reasons: string[] = []; let status: 'conditional' | 'pending' | 'excluded' = 'conditional';
  if (!stock.indicators || stock.score === undefined) { status = 'pending'; reasons.push('日線指標未完成'); }
  else if (stock.score < 4) { status = 'excluded'; reasons.push('日線五條件僅 ' + stock.score + '/5，未達 4 分'); }
  else if (Date.parse(date) - Date.parse(stock.historyDate ?? stock.date) > 4 * 86400000) { status = 'pending'; reasons.push('日線超過四個日曆日，須核對休市或來源延遲'); }
  else if (report.mode === 'intraday') {
   const q = stock.quote;
   const age = q ? +now - Date.parse(q.at) : Infinity;
   if (!q || !q.fresh || !Number.isFinite(age) || age < -5000 || age > 15 * 60000) reasons.push('缺當日 15 分鐘內最近成交');
   if (!q || q.bid === null || q.ask === null || q.bid <= 0 || q.ask <= 0 || q.bid > q.ask) reasons.push('缺有效且未倒掛的最佳買賣價');
   if (!q?.open || !q.high || !q.low || !q.cumulativeVolume || !q.snapshotAt || !q.snapshotAt.startsWith(date + 'T') || !Number.isFinite(Date.parse(q.snapshotAt)) || Date.parse(q.snapshotAt) > +now + 5000 || +now - Date.parse(q.snapshotAt) > 15 * 60000) reasons.push('缺同日有效開高低或累計成交量快照');
   if (reasons.length) status = 'pending';
   else if (q!.price < q!.open! || q!.price < stock.indicators.ma20) { status = 'excluded'; reasons.push('最近成交低於今日開盤價或日線 MA20，未通過盤中轉強條件'); }
   else reasons.push('日線至少 4/5、近期價量完整，最近成交不低於今日開盤及 MA20');
  } else reasons.push('日線至少 4/5；盤後條件式觀察，下次開市須重新確認報價及盤中條件');
  stock.assessment = { status, reasons, selected: false };
 }
 const ranked = report.stocks.filter(s => s.assessment?.status === 'conditional').sort((a,b) => b.score! - a.score! || b.close*b.volume - a.close*a.volume || a.code.localeCompare(b.code));
 ranked.forEach((s,i) => { s.assessment!.rank=i+1;s.assessment!.selected=i<3; });
 report.selection = { version:'next-day-conditions-0.1.0', assessedAt:now.toISOString(), technicalPassed:report.stocks.filter(s=>s.indicators && (s.score??0)>=4).length, conditional:ranked.length, pending:report.stocks.filter(s=>s.assessment?.status==='pending').length, excluded:report.stocks.filter(s=>s.assessment?.status==='excluded').length, selected:ranked.slice(0,3).map(s=>s.market+':'+s.code), limitations:['此為未經回測驗證的固定條件分類，不是隔日上漲機率、買進指令或成交保證。','停牌、處置、重大消息與交易日尚未完整自動核對，買進前仍須確認。','內外盤、委託深度及新聞缺漏獨立列風險，不暗中新增為技術分類門檻。','排名依條件數、前日成交值、代碼；每日量比為日成交量／前20個有效日均量，盤中原始量不混入日線量比。'] };
 return report.selection;
}

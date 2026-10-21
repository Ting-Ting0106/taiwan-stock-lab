import { tradingCalendar } from './calendar.ts';
import { randomUUID, createHash } from 'node:crypto';
import type { Query, Database } from '../shared/model';
import type { MarketStock } from '../shared/market';
import type { PaperAccount, PaperDay, PaperPosition, TrendEvaluation } from '../shared/paper';
import { read, mutate } from './store.ts';
import { parseQuotes, taipeiNow } from './market.ts';
export const initialPaper=():PaperAccount=>({version:'paper-trend-0.2.0',initialCash:100000,cash:100000,enabled:true,positions:[],days:[]});
const money=(n:number)=>Math.round(n*100)/100;
const fee=(n:number,rate:number)=>Math.ceil(n*rate*100)/100;
const positive=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>0;
export type QuoteLoader=(stocks:MarketStock[],now:Date)=>Promise<MarketStock[]>;
export const loadPaperQuotes:QuoteLoader=async(stocks,now)=>{
 if(!stocks.length)return [];
 const started=Date.now(),url='https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch='+stocks.map(s=>(s.market==='TWSE'?'tse_':'otc_')+s.code+'.tw').join('|')+'&json=1&delay=0';
 const r=await fetch(url,{signal:AbortSignal.timeout(15000),redirect:'error'});if(!r.ok)throw Error('模擬參考價 HTTP '+r.status);
 const fresh=stocks.map(s=>({...s,quote:undefined,issues:[],sources:[url]}));
 parseQuotes(await r.json(),fresh,new Date(+now+Date.now()-started));return fresh;
};
function usableReference(stock:MarketStock|undefined,now:Date,maxMinutes=15){
 const q=stock?.quote;if(!q||!positive(q.price))return false;
 const age=+now-Date.parse(q.at);
 return q.at.startsWith(taipeiNow(now).date+'T')&&Number.isFinite(age)&&age>=-5000&&age<=maxMinutes*60000;
}
export function recordPaperDay(db:Database,query:Query,now=new Date(),plannedExitDate?:string){
 if(query.trigger!=='schedule'||!query.paperTrade||query.status!=='succeeded'||!query.marketResearch?.selection)return undefined;
 const requested=taipeiNow(new Date(query.createdAt));
 if(requested.minutes<720||requested.minutes>=725)return undefined;
 const account=db.paper??=initialPaper(),clock=taipeiNow(now);
 if(!account.enabled)return undefined;
 if(account.days.some(d=>d.date===clock.date&&d.origin==='schedule'&&d.mode==='trend_11'))return undefined;
 account.version='paper-trend-0.2.0';
 const report=query.marketResearch;
 const day:PaperDay={mode:'trend_11',origin:'schedule',decision:structuredClone(query.trendDecision),plannedExitDate,id:randomUUID(),date:clock.date,queryId:query.id,strategy:report.selection!.version,publishedAt:query.finishedAt??now.toISOString(),model:query.model,prompt:query.prompt,snapshotHash:createHash('sha256').update(JSON.stringify(report)).digest('hex'),snapshot:structuredClone(report),selected:query.trendDecision?.selected.map(s=>s.market+':'+s.code)??[],state:'recorded',notes:[]};
 account.days.push(day);
 const start=taipeiNow(new Date(query.createdAt));
 if(start.date!==clock.date||start.minutes<720||start.minutes>=725||clock.minutes>=800||report.mode!=='intraday'){day.state='missed';day.notes.push('僅接受12:00正式排程，須在13:20前發布；不回填舊查詢');}
 else if(!query.trendDecision){day.state='data_missing';day.notes.push(query.trendDecisionError??'缺經驗證的AI趨勢名單，不從文字猜測');}
 else if(!day.selected.length){day.state='zero';day.notes.push('AI未選出隔日偏多股票，當日不下注');}
 return day;
}
export function executePaperBuys(account:PaperAccount,dayId:string,stocks:MarketStock[]=[],now=new Date()){
 const day=account.days.find(d=>d.id===dayId);if(!day||day.state!=='recorded')return;
 day.state='processed';const clock=taipeiNow(now);
 if(!account.enabled||clock.date!==day.date||clock.minutes<720||clock.minutes>=800||+now<Date.parse(day.publishedAt)){day.notes.push('暫停或超過正式發布窗口，未回填假想買進');return;}
 for(const key of day.selected.slice(0,3)){
  const original=day.snapshot.stocks.find(s=>s.market+':'+s.code===key),observed=stocks.find(s=>s.market+':'+s.code===key);
  if(!original){day.notes.push(key+'：名單缺原始資料');continue;}
  const reference=usableReference(observed,now)?observed:original;
  const current=usableReference(reference,now),price=current?reference!.quote!.price:original.close;
  if(!positive(price)){day.notes.push(key+'：沒有合法參考價格，不能捏造');continue;}
  const basis:PaperPosition['entryBasis']=reference===observed&&current?'observed':current?'analysis_snapshot':'previous_close';
  if(account.positions.some(p=>!p.closedAt&&p.code===original.code&&p.market===original.market)){day.notes.push(key+'：已有未結算部位，不借款加碼');continue;}
  const slots=3-account.positions.filter(p=>!p.closedAt).length;
  if(slots<=0||account.cash<=0){day.notes.push(key+'：資金或持倉名額不足');continue;}
  const budget=Math.max(0,Math.floor(account.cash*100/slots)-1)/100;
  const quantity=Math.floor(budget/(price*1.002)*1e6)/1e6;
  if(quantity<=0){day.notes.push(key+'：資金不足');continue;}
  const buyFee=fee(price*quantity,0.002),cost=money(price*quantity+buyFee);
  if(cost>account.cash){day.notes.push(key+'：資金不足');continue;}
  account.cash=money(account.cash-cost);
  account.positions.push({mode:'trend_11',entryBasis:basis,entryObservedAt:now.toISOString(),buyQuote:current?structuredClone(reference!.quote):undefined,buySource:reference?.sources.at(-1),plannedExitDate:day.plannedExitDate,calendarSource:day.calendarSource,id:randomUUID(),code:original.code,name:original.name,market:original.market,queryId:day.queryId,openedAt:now.toISOString(),quoteAt:current?reference!.quote!.at:original.date+'T13:30:00+08:00',quantity,buyPrice:price,buyFee,cost,mark:price,markedAt:now.toISOString()});
  day.notes.push(key+'：按'+(basis==='observed'?'觀察參考價':basis==='analysis_snapshot'?'分析快照價':'已知收盤估價')+' '+price+' 假想買進；不等待撮合或進場區間');
 }
}

/** Explicit user correction only; never called by the scheduler. Atomic in memory. */
export function retrospectivelyBuyDay(account:PaperAccount,dayId:string,now=new Date()){
 const day=account.days.find(d=>d.id===dayId);
 if(!day)throw Error('找不到原始名單');
 if(day.retrospective)return;
 if(account.positions.some(p=>p.queryId===day.queryId))throw Error('已有部位，拒絕重複補記');
 if(!day.selected.length||day.selected.length>3||new Set(day.selected).size!==day.selected.length)throw Error('名單不合法');
 if(account.positions.filter(p=>!p.closedAt).length+day.selected.length>3)throw Error('持倉名額不足');
 const rows=day.selected.map(key=>{
  const stock=day.snapshot.stocks.find(s=>s.market+':'+s.code===key);
  if(!stock?.quote||!positive(stock.quote.price)||!Number.isFinite(Date.parse(stock.quote.at))||!stock.quote.at.startsWith(day.date+'T'))throw Error('缺原日快照價格');
  return stock;
 });
 const positions:PaperPosition[]=[];let cash=account.cash;
 for(const [index,stock] of rows.entries()){
  const price=stock.quote!.price,budget=cash/(rows.length-index);
  let quantity=Math.floor(budget/(price*1.002));
  while(quantity>0&&money(price*quantity+fee(price*quantity,.002))>budget)quantity--;
  if(quantity<1)throw Error('資金不足以分配整數股');
  const buyFee=fee(price*quantity,.002),cost=money(price*quantity+buyFee);
  cash=money(cash-cost);
  positions.push({id:randomUUID(),mode:'trend_11',entryBasis:'analysis_snapshot',retrospectiveAt:now.toISOString(),entryObservedAt:now.toISOString(),code:stock.code,name:stock.name,market:stock.market,queryId:day.queryId,openedAt:day.publishedAt,quoteAt:stock.quote!.at,buyQuote:structuredClone(stock.quote),buySource:stock.sources.at(-1),quantity,buyPrice:price,buyFee,cost,mark:price,markedAt:stock.quote!.at,plannedExitDate:day.plannedExitDate,calendarSource:day.calendarSource,issue:'依使用者指示回溯假想買進；不納正式命中率'});
 }
 day.retrospective={recordedAt:now.toISOString(),originalState:day.state,reason:'使用者要求將原未成交三檔按原日快照補記；整數股均分可用資金，保留原未成交紀錄'};
 day.mode='trend_11';day.state='processed';day.notes.push(day.retrospective.reason);
 account.cash=cash;account.positions.push(...positions);
}

function closePosition(account:PaperAccount,p:PaperPosition,price:number,now:Date,stock:MarketStock,reason:string){
 const sellFee=fee(price*p.quantity,0.005),proceeds=money(price*p.quantity-sellFee);
 account.cash=money(account.cash+proceeds);
 Object.assign(p,{sellQuote:structuredClone(stock.quote),sellSource:stock.sources.at(-1),closedAt:now.toISOString(),sellPrice:price,sellFee,proceeds,pnl:money(proceeds-p.cost),exitReason:reason,issue:undefined});
}

/** Checks saved evidence; does not claim independent verification of the provider. */
export function auditPaperDay(day:PaperDay,positions:PaperPosition[]){
 const integrity=createHash('sha256').update(JSON.stringify(day.snapshot)).digest('hex')===day.snapshotHash?'matched':'mismatch';
 const checks=[integrity==='matched'?'原始分析快照雜湊一致，保存內容未變更':'原始分析快照雜湊不一致，需追查保存內容；不代表行情已驗證'];
 const observations:string[]=[],hypotheses:string[]=[];
 for(const p of positions){
  const stock=day.snapshot.stocks.find(s=>s.market===p.market&&s.code===p.code),name=p.code+' '+p.name;
  if(!stock){checks.push(name+'：缺原始分析資料');continue;}
  const i=stock.indicators,q=stock.quote;
  const published=Date.parse(day.publishedAt),daily=Date.parse(stock.date+'T13:30:00+08:00');
  checks.push(name+'：'+(Number.isFinite(daily)&&daily<=published?'日線日期未超過發布時間':'日線日期缺漏或超過發布時間，需追查'));
  if(q)checks.push(name+'：'+(Number.isFinite(Date.parse(q.at))&&Date.parse(q.at)<=published?'原始盤中成交時間未超過發布時間':'原始盤中成交時間異常，需追查'));
  if(i){
   const entries=Object.entries(i).filter(([key])=>key!=='volumeRatio');
   checks.push(name+'：'+(entries.every(([,v])=>Number.isFinite(v))&&i.k>=0&&i.k<=100&&i.d>=0&&i.d<=100?'已保存指標數值與KD範圍檢查通過':'指標缺漏或範圍異常，需追查'));
   if(positive(i.ma20))observations.push(name+'：進場參考價相對原MA20乖離 '+((p.buyPrice/i.ma20-1)*100).toFixed(2)+'%（進場價/MA20−1；非當日更新MA20）');
   if(positive(i.ma5))observations.push(name+'：進場參考價相對原MA5乖離 '+((p.buyPrice/i.ma5-1)*100).toFixed(2)+'%');
   observations.push(name+'：原K '+i.k.toFixed(2)+'、D '+i.d.toFixed(2)+(i.volumeRatio!==null?'，完整日量比 '+i.volumeRatio.toFixed(2):'，完整日量比缺失'));
  }else checks.push(name+'：缺保存指標，不能核對');
  if(stock.changePercent!==null)observations.push(name+'：原最近完整交易日漲跌 '+stock.changePercent.toFixed(2)+'%');
  if(q&&positive(q.high))observations.push(name+'：原快照成交相對盤中高點 '+((q.price/q.high-1)*100).toFixed(2)+'%（非完整日收盤位置）');
  if(p.evaluation)observations.push(name+'：隔日觀察方向 '+({up:'上漲',down:'下跌',flat:'持平'}[p.evaluation.direction])+'，'+(p.retrospectiveAt?'回溯補記':p.evaluation.verdict==='unverified'?'估價或遲到樣本':'正式方向樣本')+'；方向與扣成本損益分開');
  if(p.evaluation?.direction==='down')hypotheses.push(name+'：需比較動能延續失敗、追高回落、市場／族群轉弱及新消息；目前僅觀察到下跌，未確認原因');
 }
 return {version:'snapshot-audit-0.1.0' as const,integrity:integrity as 'matched'|'mismatch',checks,observations,hypotheses,limitations:['快照雜湊與欄位檢查只驗證保存一致性，不證明官方原始資料正確。','未保存完整原始逐日序列，無法在本次檢驗獨立重算全部MA、KD、MACD；需原始日線及計算版本才能核對。','未於11時自動核對市場指數、族群表現、公司公告與新聞，不能斷言下跌因果；下一次AI須補查來源與事件時間。','參考成交可能早於11:00，應同時查看實際報價時間；不是精確11:00成交或真實下單。']};
}

export function buildPaperReviews(account:PaperAccount,now:Date){
 const clock=taipeiNow(now);
 for(const day of account.days.filter(d=>d.mode==='trend_11'&&d.plannedExitDate&&(d.plannedExitDate<clock.date||(d.plannedExitDate===clock.date&&clock.minutes>=660)))){
  if(day.review?.status==='completed')continue;
  const positions=account.positions.filter(p=>p.queryId===day.queryId&&p.mode==='trend_11');
  if(!positions.length)continue;
  const verified=positions.filter(p=>p.evaluation&&p.evaluation.verdict!=='unverified'),correct=verified.filter(p=>p.evaluation!.verdict==='correct');
  const findings=positions.map(p=>p.evaluation?p.code+' '+p.name+'：'+({up:'上漲',down:'下跌',flat:'持平'}[p.evaluation.direction])+' '+p.evaluation.changePercent.toFixed(2)+'%；'+(p.evaluation.verdict==='unverified'?'非準時／估價樣本，不納命中率':({correct:'方向猜對',wrong:'方向猜錯',flat:'持平',unverified:'未驗證'}[p.evaluation.verdict]))+'；成本後損益 '+p.pnl:p.code+' '+p.name+'：11時資料待補，未判輸贏');
  const losers=verified.filter(p=>p.evaluation!.verdict==='wrong');
  const hot=losers.filter(p=>(day.snapshot.stocks.find(s=>s.code===p.code&&s.market===p.market)?.indicators?.k??0)>=80).length;
  if(hot)findings.push('失敗樣本中 '+hot+' 檔預測時K≥80；僅為共現，未確認因果');
  const suggestions=['先累積至少20個可驗證樣本，再比較規則；單日輸贏不自動調參。','方向與扣成本後盈虧分開；新策略需在未參與調整的日期驗證。'];
  if(hot)suggestions.push('可在新版本比較高KD候選與其他候選，保留舊版，不直接套改。');
  if(positions.some(p=>p.pnl!==undefined&&p.pnl<0&&p.evaluation?.direction==='up'))suggestions.push('有猜對方向但成本後虧損；比較預期幅度與成本，不只比較漲跌。');
  if(positions.some(p=>p.retrospectiveAt))suggestions.push('含使用者回溯補記樣本：可觀察價格方向與模擬盈虧，但不納正式命中率；不是11時取價失敗。');
  if(positions.some(p=>p.evaluation&&!p.evaluation.onTime||!p.evaluation))suggestions.push('另有遲到或未取得檢驗資料的樣本，需檢查11時資料可用性；不能直接算選股錯誤。');
  if(positions.some(p=>!p.retrospectiveAt&&p.entryBasis!=='observed'))suggestions.push('含分析快照或前日收盤估價樣本：進場基準與當時觀察價不同，不納正式命中率。');
  day.review={audit:auditPaperDay(day,positions),version:'trend-review-0.1.0',evaluatedAt:now.toISOString(),status:positions.every(p=>p.closedAt)?'completed':'partial',sampleCount:positions.length,verifiedCount:verified.length,correctCount:correct.length,findings,suggestions};
 }
}
export function settlePaper(account:PaperAccount,stocks:MarketStock[],now=new Date()){
 const clock=taipeiNow(now);
 for(const p of account.positions.filter(p=>!p.closedAt)){
  const stock=stocks.find(s=>s.code===p.code&&s.market===p.market),opened=taipeiNow(new Date(p.openedAt)).date;
  if(!usableReference(stock,now,p.mode==='trend_11'?15:5)){p.issue='缺當日有效最近成交，待補資料，不捏造11時價格';continue;}
  const q=stock!.quote!;p.mark=p.mode==='trend_11'?q.price:(q.bid??q.price);p.markedAt=now.toISOString();
  if(clock.date<=opened)continue;
  if(!p.plannedExitDate){p.issue='預定下一交易日尚未確認';continue;}
  const minute=p.mode==='trend_11'?660:800;
  if(clock.date<p.plannedExitDate||(clock.date===p.plannedExitDate&&clock.minutes<minute)||clock.minutes>810)continue;
  if(p.mode!=='trend_11'){
   if(!positive(q.bid)||!positive(q.ask)||q.bid>q.ask){p.issue='舊版部位仍依雙邊報價規則';continue;}
   closePosition(account,p,q.bid*0.999,now,stock!,'舊版13:20規則結算');continue;
  }
  const onTime=clock.date===p.plannedExitDate&&clock.minutes<665;
  const direction=q.price>p.buyPrice?'up':q.price<p.buyPrice?'down':'flat';
  const verdict:TrendEvaluation['verdict']=p.retrospectiveAt||!onTime||p.entryBasis!=='observed'?'unverified':direction==='up'?'correct':direction==='down'?'wrong':'flat';
  p.evaluation={version:'trend-review-0.1.0',targetDate:p.plannedExitDate,targetTime:'11:00',observedAt:now.toISOString(),quoteAt:q.at,entryPrice:p.buyPrice,exitPrice:q.price,changePercent:(q.price/p.buyPrice-1)*100,direction,verdict,onTime,note:p.retrospectiveAt?'回溯假想買進，僅供觀察，不納正式命中率':!onTime?'錯過11時窗口，依目前參考價延遲結算，不算11時驗證':p.entryBasis==='previous_close'?'進場採已知收盤估價，不算今日買進的正式命中率':p.entryBasis==='analysis_snapshot'?'以分析截面作假想進場，非發布後觀察價，不納正式命中率':'準時觀察最近成交驗證方向，非實際委託成交'};
  closePosition(account,p,q.price,now,stock!,p.evaluation.note);
 }
 buildPaperReviews(account,now);account.lastCheckedAt=now.toISOString();account.error=undefined;
}
export class PaperEngine {
 private busy=false;private timer?:ReturnType<typeof setInterval>;private quotes:QuoteLoader;
 constructor(quotes:QuoteLoader=loadPaperQuotes){this.quotes=quotes;}
 async accept(query:Query){
  while(this.busy)await new Promise(resolve=>setTimeout(resolve,50));this.busy=true;
  try{
   const day=await mutate(db=>recordPaperDay(db,query));if(!day||day.state!=='recorded')return;
   try{const planned=await tradingCalendar.next(day.date);await mutate(db=>{const d=db.paper!.days.find(d=>d.id===day.id)!;d.plannedExitDate=planned.date;d.calendarSource=planned.source;});}
   catch{await mutate(db=>db.paper!.days.find(d=>d.id===day.id)!.notes.push('下一交易日日曆待補；假想進場保留，驗證日待確認'));}
   let quotes:MarketStock[]=[];
   try{quotes=await this.quotes(day.snapshot.stocks.filter(s=>day.selected.includes(s.market+':'+s.code)),new Date());}
   catch{await mutate(db=>db.paper!.days.find(d=>d.id===day.id)!.notes.push('新參考價未取得，改用已保存的分析價格並標示來源'));}
   await mutate(db=>executePaperBuys(db.paper!,day.id,quotes));
  }finally{this.busy=false;}
 }
 async tick(now=new Date()){
  if(this.busy)return;this.busy=true;
  try{
   const db=await read();if(!db.paper?.enabled)return;
   const clock=taipeiNow(now);if([0,6].includes(clock.weekday)||clock.minutes<540||clock.minutes>810)return;
   const open=db.paper.positions.filter(p=>!p.closedAt);if(!open.length)return;
   for(const queryId of new Set(open.filter(p=>!p.plannedExitDate).map(p=>p.queryId))){
    const day=db.paper.days.find(d=>d.queryId===queryId);if(!day)continue;
    try{const planned=await tradingCalendar.next(day.date);await mutate(current=>{const d=current.paper!.days.find(d=>d.id===day.id)!;d.plannedExitDate=planned.date;d.calendarSource=planned.source;current.paper!.positions.filter(p=>p.queryId===queryId&&!p.closedAt).forEach(p=>p.plannedExitDate=planned.date);});}catch{}
   }
   const stocks=open.map(p=>({code:p.code,name:p.name,market:p.market}) as MarketStock);
   try{const quotes=await this.quotes(stocks,now);await mutate(current=>{if(current.paper?.enabled)settlePaper(current.paper,quotes,new Date());});}
   catch(e){await mutate(current=>{current.paper!.error=e instanceof Error?e.message:'參考價失敗';current.paper!.lastCheckedAt=new Date().toISOString();buildPaperReviews(current.paper!,new Date());});}
  }finally{this.busy=false;}
 }
 start(){void mutate(db=>{if(db.paper)for(const d of db.paper.days)if(d.state==='recorded'){d.state='processed';d.notes.push('上次中斷，不回填過去假想進場');}}).then(()=>this.tick()).catch(()=>{});this.timer=setInterval(()=>{void this.tick().catch(()=>{});},60000);this.timer.unref();}
 stop(){if(this.timer)clearInterval(this.timer);}
}
export { parsePaperCalendar, nextPaperSession } from './calendar.ts';

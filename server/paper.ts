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
function closePosition(account:PaperAccount,p:PaperPosition,price:number,now:Date,stock:MarketStock,reason:string){
 const sellFee=fee(price*p.quantity,0.005),proceeds=money(price*p.quantity-sellFee);
 account.cash=money(account.cash+proceeds);
 Object.assign(p,{sellQuote:structuredClone(stock.quote),sellSource:stock.sources.at(-1),closedAt:now.toISOString(),sellPrice:price,sellFee,proceeds,pnl:money(proceeds-p.cost),exitReason:reason,issue:undefined});
}
export function buildPaperReviews(account:PaperAccount,now:Date){
 const clock=taipeiNow(now);
 for(const day of account.days.filter(d=>d.mode==='trend_11'&&d.plannedExitDate&&(d.plannedExitDate<clock.date||(d.plannedExitDate===clock.date&&clock.minutes>=660)))){
  if(day.review?.status==='completed')continue;
  const positions=account.positions.filter(p=>p.queryId===day.queryId&&p.mode==='trend_11');
  if(!positions.length)continue;
  const verified=positions.filter(p=>p.evaluation&&p.evaluation.verdict!=='unverified'),correct=verified.filter(p=>p.evaluation!.verdict==='correct');
  const findings=positions.map(p=>p.evaluation?p.code+'：'+p.evaluation.direction+' '+p.evaluation.changePercent.toFixed(2)+'%；'+(p.evaluation.verdict==='unverified'?'非準時／估價樣本，不納命中率':p.evaluation.verdict)+'；成本後損益 '+p.pnl:p.code+'：11時資料待補，未判輸贏');
  const losers=verified.filter(p=>p.evaluation!.verdict==='wrong');
  const hot=losers.filter(p=>(day.snapshot.stocks.find(s=>s.code===p.code&&s.market===p.market)?.indicators?.k??0)>=80).length;
  if(hot)findings.push('失敗樣本中 '+hot+' 檔預測時K≥80；僅為共現，未確認因果');
  const suggestions=['先累積至少20個可驗證樣本，再比較規則；單日輸贏不自動調參。','方向與扣成本後盈虧分開；新策略需在未參與調整的日期驗證。'];
  if(hot)suggestions.push('可在新版本比較高KD候選與其他候選，保留舊版，不直接套改。');
  if(positions.some(p=>p.pnl!==undefined&&p.pnl<0&&p.evaluation?.direction==='up'))suggestions.push('有猜對方向但成本後虧損；比較預期幅度與成本，不只比較漲跌。');
  if(verified.length<positions.length)suggestions.push('先改善11時資料可用性；資料缺失與遲到不能算選股錯誤。');
  day.review={version:'trend-review-0.1.0',evaluatedAt:now.toISOString(),status:positions.every(p=>p.closedAt)?'completed':'partial',sampleCount:positions.length,verifiedCount:verified.length,correctCount:correct.length,findings,suggestions};
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
  const verdict:TrendEvaluation['verdict']=!onTime||p.entryBasis!=='observed'?'unverified':direction==='up'?'correct':direction==='down'?'wrong':'flat';
  p.evaluation={version:'trend-review-0.1.0',targetDate:p.plannedExitDate,targetTime:'11:00',observedAt:now.toISOString(),quoteAt:q.at,entryPrice:p.buyPrice,exitPrice:q.price,changePercent:(q.price/p.buyPrice-1)*100,direction,verdict,onTime,note:!onTime?'錯過11時窗口，依目前參考價延遲結算，不算11時驗證':p.entryBasis==='previous_close'?'進場採已知收盤估價，不算今日買進的正式命中率':p.entryBasis==='analysis_snapshot'?'以分析截面作假想進場，非發布後觀察價，不納正式命中率':'準時觀察最近成交驗證方向，非實際委託成交'};
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

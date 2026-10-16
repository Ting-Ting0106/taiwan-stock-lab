import { tradingCalendar } from './calendar.ts';
import { randomUUID, createHash } from 'node:crypto';
import type { Query, Database } from '../shared/model';
import type { MarketStock } from '../shared/market';
import type { PaperAccount, PaperDay } from '../shared/paper';
import { read, mutate } from './store.ts';
import { parseQuotes, taipeiNow } from './market.ts';
export const initialPaper = ():PaperAccount => ({version:'paper-next-session-0.1.0',initialCash:100000,cash:100000,enabled:true,positions:[],days:[]});
const money=(n:number)=>Math.round(n*100)/100;
const fee=(n:number,rate:number)=>Math.ceil(n*rate*100)/100;
export type QuoteLoader=(stocks:MarketStock[],now:Date)=>Promise<MarketStock[]>;
export const loadPaperQuotes:QuoteLoader=async(stocks,now)=>{
 if(!stocks.length)return [];
 const startedAt=Date.now();
 const url='https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch='+stocks.map(s=>(s.market==='TWSE'?'tse_':'otc_')+s.code+'.tw').join('|')+'&json=1&delay=0';
 const r=await fetch(url,{signal:AbortSignal.timeout(15000),redirect:'error'});
 if(!r.ok)throw new Error('模擬報價 HTTP '+r.status);
 const fresh=stocks.map(s=>({...s,quote:undefined,issues:[],sources:[url]}));
 parseQuotes(await r.json(),fresh,new Date(+now+Date.now()-startedAt));return fresh;
};
// Quote timestamps are checked again against the execution clock, not analysis time.
function usable(stock:MarketStock|undefined,now:Date){
 const q=stock?.quote;if(!q || !q.fresh)return false;
 const age=+now-Date.parse(q.at);
 return Number.isFinite(age)&&age>=-5000&&age<=5*60000&&q.at.startsWith(taipeiNow(now).date+'T')&&q.bid!==null&&q.ask!==null&&q.bid>0&&q.ask>0&&q.bid<=q.ask;
}
export function recordPaperDay(db:Database,query:Query,now=new Date(),plannedExitDate?:string){
 const account=db.paper??=initialPaper(),report=query.marketResearch,clock=taipeiNow(now);
 if(!account.enabled || !query.paperTrade || query.status!=='succeeded' || !report?.selection)return undefined;
 if(account.days.some(d=>d.date===clock.date))return undefined;
 const day:PaperDay={plannedExitDate,id:randomUUID(),date:clock.date,queryId:query.id,strategy:report.selection.version,publishedAt:query.finishedAt??now.toISOString(),model:query.model,prompt:query.prompt,snapshotHash:createHash('sha256').update(JSON.stringify(report)).digest('hex'),snapshot:structuredClone(report),selected:[...report.selection.selected],state:'recorded' as const,notes:[] as string[]};
 account.days.push(day);
 if(report.mode!=='intraday'||clock.minutes<540||clock.minutes>=800){Object.assign(day,{state:'missed'});day.notes.push('發布時已不在09:00～13:20買進窗口，不回填成交');}
 else if(!day.selected.length){day.state=report.poolCount===0||report.technicalCount<report.poolCount?'data_missing':'zero';if(day.state==='data_missing')day.notes.push('官方行情或指標未齊，不視為正常零候選');}
 return day;
}
export function executePaperBuys(account:PaperAccount,dayId:string,stocks:MarketStock[],now=new Date()){
 const day=account.days.find(d=>d.id===dayId);if(!day||day.state!=='recorded')return;
 const clock=taipeiNow(now);day.state='processed';
 if(!day.plannedExitDate){day.notes.push('下一交易日未確認，不模擬買進');return;}
 if(!account.enabled||clock.date!==day.date||clock.minutes<540||clock.minutes>=800){day.notes.push('暫停或超過買進窗口，未成交');return;}
 const published=Date.parse(day.publishedAt);
 if(+now<published){day.notes.push('執行時間早於發布，不成交');return;}
 for(const key of day.selected.slice(0,3)){
  const stock=stocks.find(s=>s.market+':'+s.code===key),original=day.snapshot.stocks.find(s=>s.market+':'+s.code===key);
  if(!stock||!original||!usable(stock,now)||(Date.parse(stock.quote!.snapshotAt??stock.quote!.at)<published || Date.parse(stock.quote!.snapshotAt??stock.quote!.at)>+now+5000)){day.notes.push(key+'：缺發布後5分鐘內有效報價，未成交');continue;}
  const q=stock.quote!;
  if(!q.open||!original.indicators||q.price<q.open||q.price<original.indicators.ma20){day.notes.push(key+'：新報價不再符合盤中條件，未成交');continue;}
  if(account.positions.some(p=>!p.closedAt&&p.market===stock.market&&p.code===stock.code)){day.notes.push(key+'：已有持倉，不重複買進');continue;}
  const slots=3-account.positions.filter(p=>!p.closedAt).length;if(slots<=0){day.notes.push(key+'：已滿3檔');continue;}
  const budget=account.cash/slots,price=q.ask!*1.001;
  let quantity=Math.floor(budget/(price*1.002));
  while(quantity>0&&money(price*quantity)+fee(price*quantity,0.002)>budget)quantity--;
  if(!quantity){day.notes.push(key+'：資金不足');continue;}
  const buyFee=fee(price*quantity,0.002),cost=money(price*quantity+buyFee);
  account.cash=money(account.cash-cost);
  account.positions.push({buyQuote:structuredClone(q),buySource:stock.sources.at(-1),plannedExitDate:day.plannedExitDate,calendarSource:day.calendarSource,id:randomUUID(),code:stock.code,name:stock.name,market:stock.market,queryId:day.queryId,openedAt:now.toISOString(),quoteAt:q.snapshotAt??q.at,quantity,buyPrice:price,buyFee,cost,mark:q.bid!,markedAt:now.toISOString()});
  day.notes.push(key+'：依發布後新報價理論模擬買進 '+quantity+' 股');
 }
}
export function settlePaper(account:PaperAccount,stocks:MarketStock[],now=new Date()){
 const clock=taipeiNow(now);
 for(const position of account.positions.filter(p=>!p.closedAt)){
  const stock=stocks.find(s=>s.code===position.code&&s.market===position.market),q=stock?.quote;
  const opened=taipeiNow(new Date(position.openedAt)).date;
  if(!usable(stock,now)){position.issue='無5分鐘內有效雙邊報價，保留未平倉';continue;}
  position.mark=q!.bid!;position.markedAt=now.toISOString();position.issue=undefined;
  if(clock.date<=opened)continue;
  if(!position.plannedExitDate){position.issue='未確認預定出清日，保留持倉';continue;}
  if(clock.date<position.plannedExitDate || (clock.date===position.plannedExitDate&&clock.minutes<800) || clock.minutes>810)continue;
  const price=q!.bid!*0.999,sellFee=fee(price*position.quantity,0.005),proceeds=money(price*position.quantity-sellFee);
  account.cash=money(account.cash+proceeds);
  Object.assign(position,{sellQuote:structuredClone(q),sellSource:stock?.sources.at(-1),closedAt:now.toISOString(),sellPrice:price,sellFee,proceeds,pnl:money(proceeds-position.cost),exitReason:clock.date===position.plannedExitDate?'預定下一交易日13:20後理論模擬出清':'錯過預定出清日，依重新取得的當日報價延遲模擬出清，未回填歷史成交'});
 }
 account.lastCheckedAt=now.toISOString();account.error=undefined;
}
export class PaperEngine {
 private busy=false;private timer?:ReturnType<typeof setInterval>;
 private quotes:QuoteLoader;
 constructor(quotes:QuoteLoader=loadPaperQuotes){this.quotes=quotes;}
 async accept(query:Query){
  while(this.busy)await new Promise(resolve=>setTimeout(resolve,50));this.busy=true;
  try{
   const day=await mutate(db=>recordPaperDay(db,query));if(!day||day.state!=='recorded')return;
   try{const planned=await plannedPaperExit(day.date);await mutate(db=>{const target=db.paper!.days.find(d=>d.id===day.id)!;target.plannedExitDate=planned.date;target.calendarSource=planned.source;});const stocks=await this.quotes(day.snapshot.stocks.filter(s=>day.selected.includes(s.market+':'+s.code)),new Date());await mutate(db=>executePaperBuys(db.paper!,day.id,stocks));}
   catch(e){await mutate(db=>{const target=db.paper!.days.find(d=>d.id===day.id)!;target.state='processed';target.notes.push('報價失敗，未成交：'+(e instanceof Error?e.message:'未知錯誤'));});}
  }finally{this.busy=false;}
 }
 async tick(now=new Date()){
  if(this.busy)return;this.busy=true;
  try{
   const db=await read(),account=db.paper;if(!account?.enabled)return;
   const clock=taipeiNow(now);if(clock.weekday===0||clock.weekday===6||clock.minutes<540||clock.minutes>810)return;
   const open=account.positions.filter(p=>!p.closedAt);if(!open.length)return;
   const stocks=open.map(p=>({code:p.code,name:p.name,market:p.market}) as MarketStock);
   try{const quotes=await this.quotes(stocks,now);await mutate(current=>{if(current.paper?.enabled)settlePaper(current.paper,quotes,new Date());});}
   catch(e){await mutate(current=>{current.paper!.error=e instanceof Error?e.message:'報價失敗';current.paper!.lastCheckedAt=new Date().toISOString();});}
  }finally{this.busy=false;}
 }
 start(){void mutate(db=>{if(db.paper)for(const day of db.paper.days)if(day.state==='recorded'){day.state='processed';day.notes.push('上次服務中斷，未回填或重送模擬買進');}}).then(()=>this.tick()).catch(()=>{});this.timer=setInterval(()=>{void this.tick().catch(()=>{});},60000);this.timer.unref();}
 stop(){if(this.timer)clearInterval(this.timer);}
}

export { parsePaperCalendar, nextPaperSession } from './calendar.ts';
const plannedPaperExit=(date:string)=>tradingCalendar.next(date);

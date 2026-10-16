import type { MarketCheck } from '../shared/model';
const annualUrl=(year:number)=>'https://www.twse.com.tw/holidaySchedule/holidaySchedule?response=json&queryYear='+year;
const indexUrl='https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw%7Cotc_o00.tw&json=1&delay=0';
export function parsePaperCalendar(payload:any,year:number){
 if(payload?.stat!=='ok'||payload?.queryYear!==year||!Array.isArray(payload.fields)||payload.fields.join('|')!=='日期|名稱|說明'||!Array.isArray(payload.data)||payload.data.length<5)throw new Error('官方交易日曆格式或年度不符');
 const closed=new Set<string>();
 for(const row of payload.data){
  if(!Array.isArray(row)||!/^\d{4}-\d{2}-\d{2}$/.test(row[0])||Number(row[0].slice(0,4))!==year||!Number.isFinite(Date.parse(row[0]))||new Date(row[0]).toISOString().slice(0,10)!==row[0])throw new Error('交易日曆日期不符');
  if(/開始交易|最後交易/.test(row[1]))continue;
  if(!/放假|補假|無交易/.test(row[1]+' '+row[2]))throw new Error('不認得的交易日曆分類');
  closed.add(row[0]);
 }
 return closed;
}
export function nextPaperSession(date:string,closed:Set<string>,availableYears:Set<number>){
 for(let i=1;i<=40;i++){const d=new Date(Date.parse(date+'T00:00:00Z')+i*86400000),key=d.toISOString().slice(0,10);if(!availableYears.has(d.getUTCFullYear()))throw new Error('缺下一年度交易日曆');if(![0,6].includes(d.getUTCDay())&&!closed.has(key))return key;}
 throw new Error('找不到已確認的下一交易日');
}
function clock(now:Date){
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
 const get=(name:string)=>parts.find(x=>x.type===name)!.value;
 const date=get('year')+'-'+get('month')+'-'+get('day');
 return {date,minutes:Number(get('hour'))*60+Number(get('minute')),weekday:new Date(date+'T00:00:00Z').getUTCDay()};
}
export class TradingCalendar {
 private cache=new Map<number,{closed:Set<string>;expires:number}>();
 private fetcher:typeof fetch;
 constructor(fetcher:typeof fetch=fetch){this.fetcher=fetcher;}
 private async json(url:string){
  const r=await this.fetcher(url,{signal:AbortSignal.timeout(15000),redirect:'error',cache:'no-store'});
  if(!r.ok)throw new Error('HTTP '+r.status);
  return r.json();
 }
 async year(year:number){
  const cached=this.cache.get(year);if(cached&&cached.expires>Date.now())return cached.closed;
  const closed=parsePaperCalendar(await this.json(annualUrl(year)),year);
  this.cache.set(year,{closed,expires:Date.now()+3600000});return closed;
 }
 async next(date:string){
  const year=Number(date.slice(0,4)),closed=new Set(await this.year(year)),years=new Set([year]);
  try{return {date:nextPaperSession(date,closed,years),source:annualUrl(year)};}
  catch(e){if(date.slice(5,7)!=='12')throw e;for(const day of await this.year(year+1))closed.add(day);years.add(year+1);return {date:nextPaperSession(date,closed,years),source:annualUrl(year)+' ; '+annualUrl(year+1)};}
 }
 async check(now=new Date()):Promise<MarketCheck>{
  const startedAt=Date.now(),c=clock(now),sources:string[]=[];
  const result=(state:MarketCheck['state'],reason:string):MarketCheck=>({date:c.date,state,reason,checkedAt:new Date().toISOString(),sources});
  if([0,6].includes(c.weekday))return result('closed','週末休市');
  try{
   const year=Number(c.date.slice(0,4));sources.push(annualUrl(year));
   if((await this.year(year)).has(c.date))return result('closed','官方年度日曆列為假日或僅交割、無交易日');
   if(c.minutes<540)return result('unknown','尚未開盤，無法確認當日實際交易；未發送AI');
   sources.push(indexUrl);const payload=await this.json(indexUrl);
   if(payload?.rtcode!=='0000'||!Array.isArray(payload.msgArray))throw new Error('市場指數報價格式不符');
   const active=[['tse','t00'],['otc','o00']].every(([ex,code])=>{
    const q=payload.msgArray.find((q:any)=>q.ex===ex&&q.c===code);
    if(!q||q.d!==c.date.replaceAll('-','')||!/^\d{2}:\d{2}:\d{2}$/.test(q.t)||!/^\d+(\.\d+)?$/.test(String(q.z))||Number(q.z)<=0)return false;
    const at=Date.parse(c.date+'T'+q.t+'+08:00'),minute=Number(q.t.slice(0,2))*60+Number(q.t.slice(3,5));
    return Number.isFinite(at)&&minute>=540&&minute<=840&&at<=+now+Date.now()-startedAt+5000&&(c.minutes>=810||+now+Date.now()-startedAt-at<=15*60000);
   });
   return active?result('open','年度日曆非休市日，上市與上櫃指數均有當日有效交易資料'):result('unknown','尚無完整當日上市／上櫃交易證據，可能臨時休市、部分停市或來源延遲；未發送AI');
  }catch(e){return result('unknown','開休市查核失敗：'+(e instanceof Error?e.message:'來源不可用')+'；未發送AI');}
 }
}
export const tradingCalendar=new TradingCalendar();

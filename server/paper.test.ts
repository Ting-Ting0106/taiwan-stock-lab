import { TradingCalendar } from './calendar.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialPaper, recordPaperDay, executePaperBuys, settlePaper, parsePaperCalendar, nextPaperSession } from './paper.ts';
import type { Database, Query } from '../shared/model';
import type { MarketStock, MarketResearch } from '../shared/market';
const now=new Date('2026-10-16T04:02:00Z');
function stocks():MarketStock[]{return ['2330','4904','6885'].map(code=>({code,name:'合成'+code,market:'TWSE',industry:'合成',date:'2026-10-15',open:95,high:101,low:90,close:100,volume:1000000,changePercent:1,historyCount:100,score:5,signals:[],issues:[],sources:[],indicators:{ma5:98,ma10:97,ma20:95,ma60:90,k:60,d:50,dif:2,signal:1,histogram:2,volumeRatio:2},quote:{price:101,at:'2026-10-16T12:01:59+08:00',kind:'last',fresh:true,bid:100,ask:101,open:100,high:102,low:99,cumulativeVolume:100,snapshotAt:'2026-10-16T12:01:59+08:00'}}));}
function fixture(){
 const rows=stocks();const report:MarketResearch={version:'market-evidence-0.2.0',collectedAt:'2026-10-16T04:00:00Z',mode:'intraday',quality:'intraday_available',screening:'completed',universeCount:3,poolCount:3,technicalCount:3,markets:[],stocks:rows,sources:[],limitations:[],selection:{version:'next-day-conditions-0.1.0',assessedAt:'2026-10-16T04:00:01Z',technicalPassed:3,conditional:3,pending:0,excluded:0,selected:rows.map(s=>'TWSE:'+s.code),limitations:[]}};
 const query:Query={id:'query',prompt:'合成測試',model:'synthetic',webSearch:true,includeResearch:false,paperTrade:true,createdAt:'2026-10-16T04:00:00Z',finishedAt:'2026-10-16T04:01:00Z',trigger:'manual',status:'succeeded',sources:[],marketResearch:report};
 const db:Database={bars:[],trades:[],runs:[],queries:[query],schedule:{enabled:false,time:'12:00',weekdays:[1],prompt:'',model:'',webSearch:true,includeResearch:false},paper:initialPaper()};return {db,query,rows};
}
test('每日名單鎖定快照、不覆蓋、零檔保留，AI失敗及未勾選不操作',()=>{
 const {db,query}=fixture();const day=recordPaperDay(db,query,now,'2026-10-19')!;assert.ok(day);query.marketResearch!.stocks[0].close=999;assert.equal(day.snapshot.stocks[0].close,100);assert.equal(day.snapshotHash.length,64);
 assert.equal(recordPaperDay(db,{...query,id:'retry'},now),undefined);
 const zero=fixture();zero.query.marketResearch!.selection!.selected=[];assert.equal(recordPaperDay(zero.db,zero.query,now)?.state,'zero');
 const missing=fixture();missing.query.marketResearch!.selection!.selected=[];missing.query.marketResearch!.technicalCount=0;assert.equal(recordPaperDay(missing.db,missing.query,now)?.state,'data_missing');
 const failed=fixture();assert.equal(recordPaperDay(failed.db,{...failed.query,status:'failed'},now),undefined);assert.equal(recordPaperDay(failed.db,{...failed.query,paperTrade:false},now),undefined);
});
test('十萬虛擬資金最多三檔、成本守恆、不超支、不重複成交',()=>{
 const {db,query,rows}=fixture();const day=recordPaperDay(db,query,now,'2026-10-19')!;
 executePaperBuys(db.paper!,day.id,rows,now);assert.equal(db.paper!.positions.length,3);assert.ok(db.paper!.cash>=0);assert.ok(db.paper!.positions.every(p=>Number.isInteger(p.quantity)&&p.buyFee>0));
 assert.ok(Math.abs(db.paper!.cash+db.paper!.positions.reduce((s,p)=>s+p.cost,0)-100000)<0.001);
 const cash=db.paper!.cash;executePaperBuys(db.paper!,day.id,rows,now);assert.equal(db.paper!.cash,cash);assert.equal(db.paper!.positions.length,3);
});
test('發布前或過期報價、缺賣價、轉弱與過時發布均不模擬成交',()=>{
 for(const change of [(s:MarketStock)=>{s.quote!.snapshotAt='2026-10-16T12:00:59+08:00';},(s:MarketStock)=>{s.quote!.at='2026-10-16T11:00:00+08:00';},(s:MarketStock)=>{s.quote!.ask=null;},(s:MarketStock)=>{s.quote!.price=99;}]){
  const {db,query,rows}=fixture();rows.forEach(change);const day=recordPaperDay(db,query,now,'2026-10-19')!;executePaperBuys(db.paper!,day.id,rows,now);assert.equal(db.paper!.positions.length,0);assert.equal(day.notes.length,3);
 }
 const {db,query}=fixture();assert.equal(recordPaperDay(db,query,new Date('2026-10-16T05:25:00Z'))?.state,'missed');
});
test('不當沖、休市舊報價不出清；後續交易日依買價扣成本，缺報價保留持倉',()=>{
 const {db,query,rows}=fixture();const day=recordPaperDay(db,query,now,'2026-10-19')!;executePaperBuys(db.paper!,day.id,rows,now);
 assert.equal(db.paper!.positions.length,3);
 const today=new Date('2026-10-16T05:20:00Z');rows.forEach(s=>{s.quote!.at='2026-10-16T13:19:59+08:00';});settlePaper(db.paper!,rows,today);assert.ok(db.paper!.positions.every(p=>!p.closedAt));
 const next=new Date('2026-10-19T05:20:00Z');settlePaper(db.paper!,rows,next);assert.ok(db.paper!.positions.every(p=>!p.closedAt&&p.issue));
 rows.forEach(s=>{s.quote!.at='2026-10-19T13:19:59+08:00';s.quote!.bid=105;s.quote!.ask=106;});settlePaper(db.paper!,rows,next);
 assert.ok(db.paper!.positions.every(p=>p.closedAt&&p.pnl!==undefined&&p.sellFee!>0));
 const realized=db.paper!.positions.reduce((s,p)=>s+p.pnl!,0);assert.ok(Math.abs(db.paper!.cash-100000-realized)<0.001);
 const cash=db.paper!.cash;settlePaper(db.paper!,rows,next);assert.equal(db.paper!.cash,cash);
});

test('預定交易日跳過週末、放假及僅交割日；未知格式或跨年缺資料拒絕',()=>{
 const payload={stat:'ok',queryYear:2026,fields:['日期','名稱','說明'],data:[['2026-01-01','元旦','放假'],['2026-01-02','開始交易日','開始交易'],['2026-02-12','市場無交易，僅交割',''],['2026-10-09','國慶','補假'],['2026-10-26','紀念日','放假']]};
 const closed=parsePaperCalendar(payload,2026);assert.ok(!closed.has('2026-01-02'));assert.equal(nextPaperSession('2026-10-08',closed,new Set([2026])),'2026-10-12');assert.equal(nextPaperSession('2026-10-23',closed,new Set([2026])),'2026-10-27');assert.throws(()=>nextPaperSession('2026-12-31',closed,new Set([2026])),/年度/);assert.throws(()=>parsePaperCalendar({...payload,queryYear:2025},2026),/年度/);
});

test('排程日曆：假日／週末不讀指數，來源失敗不冒充開市',async()=>{
 const data={stat:'ok',queryYear:2026,fields:['日期','名稱','說明'],data:[['2026-01-01','元旦','放假'],['2026-01-02','開始交易日',''],['2026-02-12','市場無交易',''],['2026-10-09','國慶','補假'],['2026-10-26','紀念日','放假']]};
 const calls:string[]=[];const calendar=new TradingCalendar(async input=>{calls.push(String(input));return Response.json(data);});
 assert.equal((await calendar.check(new Date('2026-10-09T04:00:00Z'))).state,'closed');assert.equal(calls.length,1);
 assert.equal((await calendar.check(new Date('2026-10-10T04:00:00Z'))).state,'closed');assert.equal(calls.length,1);
 assert.equal((await new TradingCalendar(async()=>new Response('',{status:503})).check(new Date('2026-10-16T04:00:00Z'))).state,'unknown');
});
test('開市須兩市場當日交易，舊日／過期／單邊資料都不發出開市確認',async()=>{
 const data={stat:'ok',queryYear:2026,fields:['日期','名稱','說明'],data:[['2026-01-01','元旦','放假'],['2026-01-02','開始交易日',''],['2026-02-12','市場無交易',''],['2026-10-09','國慶','補假'],['2026-10-26','紀念日','放假']]};
 let quotes=[{c:'t00',ex:'tse',d:'20261016',t:'11:59:59',z:'100'},{c:'o00',ex:'otc',d:'20261016',t:'11:59:59',z:'100'}];
 const calendar=new TradingCalendar(async input=>Response.json(String(input).includes('holidaySchedule')?data:{rtcode:'0000',msgArray:quotes}));
 const now=new Date('2026-10-16T04:00:00Z');assert.equal((await calendar.check(now)).state,'open');
 quotes[1].d='20261015';assert.equal((await calendar.check(now)).state,'unknown');quotes[1].d='20261016';quotes[1].t='09:00:00';assert.equal((await calendar.check(now)).state,'unknown');quotes=quotes.slice(0,1);assert.equal((await calendar.check(now)).state,'unknown');
 assert.equal((await calendar.check(new Date('2026-10-16T00:59:00Z'))).state,'unknown');
});

import { TradingCalendar } from './calendar.ts';
import {test} from 'node:test';import assert from 'node:assert/strict';
import {initialPaper,recordPaperDay,executePaperBuys,settlePaper,parsePaperCalendar,nextPaperSession} from './paper.ts';
import {extractTrendDecision} from './trend.ts';import type {Database,Query} from '../shared/model';import type {MarketResearch,MarketStock} from '../shared/market';
const now=new Date('2026-10-16T04:02:00Z');
function fixture(){
 const rows:MarketStock[]=['2330','4904','6885'].map(code=>({code,name:'合成'+code,market:'TWSE',industry:'合成',date:'2026-10-15',open:95,high:101,low:90,close:100,volume:1000000,changePercent:1,historyCount:100,score:5,signals:[],issues:[],sources:['https://www.twse.com.tw/'],assessment:{status:'conditional',reasons:[],selected:true},indicators:{ma5:98,ma10:97,ma20:95,ma60:90,k:60,d:50,dif:2,signal:1,histogram:2,volumeRatio:2},quote:{price:101,at:'2026-10-16T12:01:59+08:00',kind:'last',fresh:true,bid:null,ask:null,open:110,high:111,low:99}}));
 const report:MarketResearch={version:'market-evidence-0.2.0',collectedAt:'2026-10-16T04:00:00Z',mode:'intraday',quality:'eod_only',screening:'completed',universeCount:3,poolCount:3,technicalCount:3,markets:[],stocks:rows,sources:[],limitations:[],selection:{version:'next-day-trend-0.2.0',assessedAt:'2026-10-16T04:00:01Z',technicalPassed:3,conditional:3,pending:0,excluded:0,selected:rows.map(s=>'TWSE:'+s.code),limitations:[]}};
 const query:Query={id:'query',prompt:'合成',model:'synthetic',webSearch:true,includeResearch:false,paperTrade:true,createdAt:'2026-10-16T04:00:00Z',finishedAt:'2026-10-16T04:01:00Z',trigger:'schedule',status:'succeeded',sources:[],marketResearch:report,trendDecision:{version:'ai-trend-0.1.0',selected:rows.map(s=>({market:s.market,code:s.code,reason:'合成偏多'})),summary:'合成'}};
 const db:Database={bars:[],trades:[],runs:[],queries:[query],schedule:{enabled:false,time:'12:00',weekdays:[1],prompt:'',model:'',webSearch:true,includeResearch:false},paper:initialPaper()};return {db,query,rows};
}
function buy(){const f=fixture(),day=recordPaperDay(f.db,f.query,now,'2026-10-19')!;executePaperBuys(f.db.paper!,day.id,f.rows,now);return {...f,day};}
test('手動不占正式名單；12時排程快照鎖定、同日去重、零檔與缺決策分開',()=>{
 const {db,query}=fixture();assert.equal(recordPaperDay(db,{...query,trigger:'manual'},now),undefined);
 db.paper!.days.push({id:'old',date:'2026-10-16',queryId:'manual-old',strategy:'old',publishedAt:now.toISOString(),model:'old',prompt:'old',snapshotHash:'old',snapshot:query.marketResearch!,selected:[],state:'processed',notes:[]});
 assert.equal(recordPaperDay(db,{...query,createdAt:'2026-10-16T03:00:00Z'},now),undefined);
 const day=recordPaperDay(db,query,now)!;assert.ok(day);query.marketResearch!.stocks[0].close=999;assert.equal(day.snapshot.stocks[0].close,100);assert.equal(day.snapshotHash.length,64);assert.equal(recordPaperDay(db,{...query,id:'retry'},now),undefined);
 const zero=fixture();zero.query.trendDecision!.selected=[];assert.equal(recordPaperDay(zero.db,zero.query,now)?.state,'zero');
 const bad=fixture();bad.query.trendDecision=undefined;assert.equal(recordPaperDay(bad.db,bad.query,now)?.state,'data_missing');
 const failed=fixture();assert.equal(recordPaperDay(failed.db,{...failed.query,status:'failed'},now),undefined);
});
test('缺雙邊報價或低於開盤仍假想成交；最多三檔、資金守恆與去重',()=>{
 const {db,rows,day}=buy();assert.equal(db.paper!.positions.length,3);assert.ok(db.paper!.positions.every(p=>p.buyPrice===101&&p.quantity>0&&p.buyFee>0));
 assert.ok(Math.abs(db.paper!.cash+db.paper!.positions.reduce((s,p)=>s+p.cost,0)-100000)<0.001);assert.ok(db.paper!.cash>=0);
 const cash=db.paper!.cash;executePaperBuys(db.paper!,day.id,rows,now);assert.equal(db.paper!.cash,cash);
});
test('無新價採快照或已知收盤估價且標記，高價股可有小數虛擬單位',()=>{
 const f=fixture(),d=recordPaperDay(f.db,f.query,now)!;d.snapshot.stocks[0].quote=undefined;executePaperBuys(f.db.paper!,d.id,[],now);
 assert.equal(f.db.paper!.positions.length,3);assert.equal(f.db.paper!.positions[0].entryBasis,'previous_close');assert.equal(f.db.paper!.positions[1].entryBasis,'analysis_snapshot');
 const high=fixture();high.rows.forEach(s=>s.quote!.price=1000000);const day=recordPaperDay(high.db,high.query,now)!;executePaperBuys(high.db.paper!,day.id,high.rows,now);assert.equal(high.db.paper!.positions.length,3);assert.ok(high.db.paper!.positions.every(p=>p.quantity>0&&p.quantity<1));assert.ok(high.db.paper!.cash>=0);
});
test('發布過時不補造買進，未驗證文字不能當AI名單',()=>{
 const f=fixture();assert.equal(recordPaperDay(f.db,f.query,new Date('2026-10-16T05:25:00Z'))?.state,'missed');
 const bad=fixture();bad.query.trendDecision=undefined;bad.query.output='推薦2330';const day=recordPaperDay(bad.db,bad.query,now)!;executePaperBuys(bad.db.paper!,day.id,bad.rows,now);assert.equal(bad.db.paper!.positions.length,0);
});
test('不當沖；次交易日11時無雙邊盤仍驗證，方向猜對和成本後虧損分開',()=>{
 const {db,rows,day}=buy();rows.forEach(s=>s.quote!.at='2026-10-16T13:19:59+08:00');settlePaper(db.paper!,rows,new Date('2026-10-16T05:20:00Z'));assert.ok(db.paper!.positions.every(p=>!p.closedAt));
 rows.forEach(s=>{s.quote!.at='2026-10-19T10:59:59+08:00';s.quote!.price=101.1;});settlePaper(db.paper!,rows,new Date('2026-10-19T02:59:59Z'));assert.ok(db.paper!.positions.every(p=>!p.closedAt));
 settlePaper(db.paper!,rows,new Date('2026-10-19T03:00:00Z'));assert.equal(db.paper!.positions.length,3);assert.ok(db.paper!.positions.every(p=>p.closedAt&&p.evaluation?.verdict==='correct'&&p.pnl!<0));assert.equal(day.review?.correctCount,3);assert.ok(day.review!.suggestions.some(x=>x.includes('成本')));
 const realized=db.paper!.positions.reduce((s,p)=>s+p.pnl!,0);assert.ok(Math.abs(db.paper!.cash-100000-realized)<0.001);const cash=db.paper!.cash,reviewAt=day.review!.evaluatedAt;settlePaper(db.paper!,rows,new Date('2026-10-19T03:01:00Z'));assert.equal(db.paper!.cash,cash);assert.equal(day.review!.evaluatedAt,reviewAt);
});
test('缺11時價格不判輸；遲到排除正式命中率；舊部位仍13:20退出',()=>{
 const f=buy();settlePaper(f.db.paper!,f.rows,new Date('2026-10-19T03:00:00Z'));assert.ok(f.db.paper!.positions.every(p=>!p.closedAt));assert.equal(f.day.review?.verifiedCount,0);
 f.rows.forEach(s=>{s.quote!.at='2026-10-19T11:05:59+08:00';s.quote!.price=99;});settlePaper(f.db.paper!,f.rows,new Date('2026-10-19T03:06:00Z'));assert.ok(f.db.paper!.positions.every(p=>p.evaluation?.verdict==='unverified'));
 const old=buy();old.db.paper!.positions.forEach(p=>p.mode=undefined);old.rows.forEach(s=>{s.quote!.at='2026-10-19T10:59:59+08:00';s.quote!.bid=100;s.quote!.ask=101;});settlePaper(old.db.paper!,old.rows,new Date('2026-10-19T03:00:00Z'));assert.ok(old.db.paper!.positions.every(p=>!p.closedAt));
 old.rows.forEach(s=>s.quote!.at='2026-10-19T13:19:59+08:00');settlePaper(old.db.paper!,old.rows,new Date('2026-10-19T05:20:00Z'));assert.ok(old.db.paper!.positions.every(p=>p.closedAt&&!p.evaluation));
});
test('AI決策須唯一合法JSON、最多3檔、無重複且在本次資料包內',()=>{
 const {query}=fixture(),d=query.trendDecision!,fence=String.fromCharCode(96).repeat(3),block=(v:unknown)=>'分析\n'+fence+'trend-decision\n'+JSON.stringify(v)+'\n'+fence;
 const parsed=extractTrendDecision(block(d),query.marketResearch);assert.equal(parsed.decision?.selected.length,3);assert.equal(parsed.output,'分析');
 for(const text of ['文字推薦',block({...d,selected:[...d.selected,d.selected[0]]}),block({...d,selected:[{market:'TWSE',code:'9999',reason:'錯誤'}]}),block(d)+block(d),block({...d,selected:[d.selected[0],d.selected[0]]})])assert.ok(extractTrendDecision(text,query.marketResearch).error);
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

test('分析快照或前收估價雖直接假想進場，11時方向仍與正式命中率分開',()=>{
 const f=fixture(),day=recordPaperDay(f.db,f.query,now,'2026-10-19')!;day.snapshot.stocks[0].quote=undefined;executePaperBuys(f.db.paper!,day.id,[],now);assert.equal(f.db.paper!.positions.length,3);
 f.rows.forEach(s=>{s.quote!.at='2026-10-19T10:59:59+08:00';s.quote!.price=102;});settlePaper(f.db.paper!,f.rows,new Date('2026-10-19T03:00:00Z'));assert.ok(f.db.paper!.positions.every(p=>p.closedAt&&p.evaluation?.direction==='up'&&p.evaluation.verdict==='unverified'));assert.equal(day.review?.verifiedCount,0);
});

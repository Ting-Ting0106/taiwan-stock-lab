import type { MarketResearch } from '../shared/market';
export function classifyCandidates(report:MarketResearch,now=new Date()){
 const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
 for(const stock of report.stocks){
  let status:'conditional'|'pending'|'excluded'='conditional';const reasons:string[]=[];
  if(!stock.indicators||stock.score===undefined){status='pending';reasons.push('日線指標未完成');}
  else if(stock.score<4){status='excluded';reasons.push('日線五條件僅 '+stock.score+'/5，未達4分');}
  else if(Date.parse(date)-Date.parse(stock.historyDate??stock.date)>4*86400000){status='pending';reasons.push('日線超過四個日曆日，需核對休市或延遲');}
  else reasons.push('日線至少4/5，進入隔日11:00趨勢評估；不以買賣盤、進場區間或低於今日開盤價淘汰');
  stock.assessment={status,reasons,selected:false};
 }
 const ranked=report.stocks.filter(s=>s.assessment?.status==='conditional').sort((a,b)=>b.score!-a.score!||b.close*b.volume-a.close*a.volume||a.code.localeCompare(b.code));
 ranked.forEach((s,i)=>{s.assessment!.rank=i+1;s.assessment!.selected=i<3;});
 report.selection={version:'next-day-trend-0.2.0',assessedAt:now.toISOString(),technicalPassed:report.stocks.filter(s=>s.indicators&&(s.score??0)>=4).length,conditional:ranked.length,pending:report.stocks.filter(s=>s.assessment?.status==='pending').length,excluded:report.stocks.filter(s=>s.assessment?.status==='excluded').length,selected:ranked.slice(0,3).map(s=>s.market+':'+s.code),limitations:['這是技術初選，正式假想買進以AI結構化偏多名單為準，不是上漲機率。','趨勢分類不包含成交門檻；參考價與真實成交分開。','最多深入12檔，非全市場掃描；日線量比為最後日量／前20有效日均量。','盤後與長期研究不占12時正式模擬名單。']};
 return report.selection;
}

import { z } from 'zod';
import type { MarketResearch } from '../shared/market';
import type { TrendDecision } from '../shared/paper';
const schema=z.object({version:z.literal('ai-trend-0.1.0'),selected:z.array(z.object({market:z.enum(['TWSE','TPEX']),code:z.string().regex(/^[1-9]\d{3}$/),reason:z.string().trim().min(1).max(1000)}).strict()).max(3),summary:z.string().trim().min(1).max(2000)}).strict();
export function extractTrendDecision(output:string,report?:MarketResearch):{output:string;decision?:TrendDecision;error?:string}{
 const matches=[...output.matchAll(/\x60{3}trend-decision\s*\n([\s\S]*?)\x60{3}/g)];
 if(matches.length!==1)return {output,error:'AI未提供唯一的結構化趨勢名單；不從文字猜測或補造成交'};
 try{
  const decision=schema.parse(JSON.parse(matches[0][1]));
  const keys=decision.selected.map(s=>s.market+':'+s.code);
  if(new Set(keys).size!==keys.length)throw Error('名單重複');
  for(const key of keys){const stock=report?.stocks.find(s=>s.market+':'+s.code===key);if(!stock||!stock.indicators||(stock.score??0)<4||stock.assessment?.status!=='conditional')throw Error('名單不在本次可核對的趨勢初選中：'+key);}
  return {output:output.replace(matches[0][0],'').trim(),decision};
 }catch(e){return {output,error:'趨勢名單驗證失敗：'+(e instanceof Error?e.message:'格式錯誤')};}
}

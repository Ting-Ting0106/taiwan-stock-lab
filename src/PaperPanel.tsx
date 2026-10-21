import type { PaperAccount } from '../shared/paper';
import { paperAssumptions } from '../shared/paper';
const n=(v:number)=>v.toLocaleString('zh-TW',{maximumFractionDigits:2});
const at=(v:string)=>new Date(v).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'});
const verdict={correct:'方向猜對',wrong:'方向猜錯',flat:'持平',unverified:'未納正式驗證'};
export default function PaperPanel({account,onToggle,busy}:{account:PaperAccount;onToggle:()=>void;busy:boolean}){
 const open=account.positions.filter(p=>!p.closedAt),closed=account.positions.filter(p=>p.closedAt),realized=closed.reduce((s,p)=>s+(p.pnl??0),0),marked=open.reduce((s,p)=>s+(p.mark??p.buyPrice)*p.quantity,0);
 const evaluated=closed.filter(p=>p.evaluation&&p.evaluation.verdict!=='unverified'),correct=evaluated.filter(p=>p.evaluation!.verdict==='correct');
 return <section><h2>10萬元趨勢虛擬交易</h2>
 <p><strong>12:00正式排程判斷偏多 → 參考價假想買進 → 下一交易日11:00檢驗並結算 → 下一次分析參考改進建議。</strong></p>
 <p>不等待AI買價或盤口。手動查詢只研究，不占正式名單。排程需選模型、勾選納入虛擬交易並啟用；服務須持續開啟。</p>
 <button disabled={busy} onClick={onToggle}>{account.enabled?'暫停虛擬交易':'啟用虛擬交易'}</button><p className="muted">暫停停止假想買進與檢驗。舊帳本保留；新版不回填已結束查詢。</p>
 <div className="stats"><article><small>可用虛擬現金</small><h3>{n(account.cash)}</h3></article><article><small>已實現模擬損益</small><h3>{n(realized)}</h3></article><article><small>參考總資產（未扣未平倉退出成本）</small><h3>{n(account.cash+marked)}</h3></article></div>
 <p>持倉 {open.length} 檔 · 已結束 {closed.length} 筆 · 準時有效方向樣本 {evaluated.length} 筆，其中猜對 {correct.length} 筆。初始資金 {n(account.initialCash)}。</p>
 <p className="muted">方向猜對不等於扣成本獲利；延遲、分析快照或前日估價樣本分開，不當作準時11時驗證。估值可能過期。</p>
 {account.error&&<p className="error">{account.error}</p>}
 <details><summary>假想成交與驗證假設 · {account.version}</summary><ul>{paperAssumptions.map(x=><li key={x}>{x}</li>)}</ul></details>
 <h3>假想買賣帳本</h3><div className="answer-table"><table><thead><tr><th>股票</th><th>假想進場／價格基準</th><th>股數／張數／成本</th><th>11時檢驗／結算</th><th>方向與損益</th></tr></thead><tbody>{[...account.positions].reverse().map(p=><tr key={p.id}><td>{p.code} {p.name}<br/><small>{p.mode==='trend_11'?'新版11時趨勢':'舊版13:20規則'}</small></td><td>{p.retrospectiveAt&&<><strong>回溯假想買進</strong><br/>補記 {at(p.retrospectiveAt)}<br/></>}{n(p.buyPrice)}<br/>{at(p.openedAt)}<br/><small>{p.entryBasis?({observed:'當時觀察最近成交',analysis_snapshot:'分析截面假想價，非發布後成交',previous_close:'已知收盤估價，非今日實際價'}[p.entryBasis]):'舊版撮合'}<br/>價格時間 {at(p.quoteAt)}</small></td><td>{p.quantity.toLocaleString('zh-TW',{maximumFractionDigits:6})} 股<br/>{(p.quantity/1000).toLocaleString('zh-TW',{maximumFractionDigits:6})} 張<br/>{n(p.cost)}</td><td>{p.closedAt?<>{n(p.sellPrice!)}<br/>{at(p.closedAt)}</>:<>待驗證<br/>{p.plannedExitDate??'日曆待補'} {p.mode==='trend_11'?'11:00':'13:20'}</>}</td><td>{p.evaluation&&<><span className={'badge query-status status-'+(p.evaluation.verdict==='correct'?'succeeded':p.evaluation.verdict==='wrong'?'failed':'market_unknown')}>{verdict[p.evaluation.verdict]}</span><br/>{p.evaluation.changePercent.toFixed(2)}%<br/>{p.evaluation.note}<br/></>}{p.pnl===undefined?'尚未實現損益':('成本後 '+n(p.pnl))}<br/>{p.issue??p.exitReason??'等待次交易日驗證'}</td></tr>)}</tbody></table></div>
 {!account.positions.length&&<p>尚無假想買進；舊查詢不回填。新版從下一次12:00正式排程開始。</p>}

 <h3>每日名單與11時改進紀錄</h3><p className="muted">歷史紀錄持續保存在本機，依發布時間由新到舊排列，不會每天清除。點選標題展開詳細內容。時間皆為台北時間。</p>{!account.days.length&&<p>尚無每日名單紀錄。</p>}<ul className="paper-history">{[...account.days].sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt)).map(d=>{
 const label=(key:string)=>{const stock=d.snapshot.stocks.find(s=>s.market+':'+s.code===key);return stock?stock.code+' '+stock.name:key;};
 const positions=account.positions.filter(p=>p.queryId===d.queryId);
 return <li key={d.id}><details className="paper-day">
 <summary><strong className="paper-history-title"><time dateTime={d.publishedAt}>{at(d.publishedAt)}</time><span>{d.selected.length?d.selected.map(label).join('、'):'零候選'}</span></strong><span className="badge">{d.retrospective?'回溯假想買進':d.origin==='schedule'?'12時正式名單':'歷史查詢名單'}</span><span className="badge">{({recorded:'等待買進',zero:'零候選',missed:'錯過發布窗口',processed:positions.length?'已記錄買進':'未買進',data_missing:'資料待補'}[d.state])}</span></summary>
 <div className="paper-times">
 <div><small>分析發布（台北時間）</small><strong>{at(d.publishedAt)}</strong></div>
 <div><small>預定檢驗與結算</small><strong>{d.plannedExitDate??'交易日待確認'}　{d.mode==='trend_11'?'11:00':'13:20（舊版）'}</strong></div>
 <div><small>11時改進紀錄</small><strong>{d.review?at(d.review.evaluatedAt):'尚未產生'}</strong><span>{d.review?(d.review.status==='completed'?'檢驗完成':'部分資料待補'):'等待檢驗'}</span></div>
 {d.retrospective&&<div><small>實際補記時間</small><strong>{at(d.retrospective.recordedAt)}</strong><span>不納正式命中率</span></div>}
 </div>
 <p className="paper-stocks">{d.selected.map(key=><span className="badge" key={key}>{label(key)}</span>)}{!d.selected.length&&'零候選'}</p>
 {d.review&&<div><p>有效樣本 {d.review.verifiedCount}/{d.review.sampleCount}，猜對 {d.review.correctCount} 筆</p><ul>{d.review.findings.map(x=><li key={x}>{x}</li>)}</ul>{d.review.audit&&<section><h4>資料核對與原因分析</h4><strong>保存一致性檢查（非官方數據獨立驗證）</strong><ul>{d.review.audit.checks.map((x,i)=><li key={i}>{x}</li>)}</ul><strong>保存數據可確認的現象</strong><ul>{d.review.audit.observations.map((x,i)=><li key={i}>{x}</li>)}</ul><strong>可能原因，尚待查證</strong><ul>{d.review.audit.hypotheses.map((x,i)=><li key={i}>{x}</li>)}</ul><strong>尚未完成的核對</strong><ul>{d.review.audit.limitations.map((x,i)=><li key={i}>{x}</li>)}</ul></section>}<strong>供下次分析參考的改進建議</strong><ul>{d.review.suggestions.map(x=><li key={x}>{x}</li>)}</ul></div>}
 <div className="paper-day-record"><h4>分析理由與原始紀錄</h4><p>{d.strategy}</p>{d.decision&&<><p>{d.decision.summary}</p><ul>{d.decision.selected.map(s=><li key={s.market+s.code}>{label(s.market+':'+s.code)}：{s.reason}</li>)}</ul></>}<ul>{d.notes.map((x,i)=><li key={i}>{x}</li>)}</ul><small>快照 {d.snapshotHash}</small></div>
 </details></li>;})}</ul>
 </section>;
}

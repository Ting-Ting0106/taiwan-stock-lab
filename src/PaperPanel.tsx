import type { PaperAccount } from '../shared/paper';
import { paperAssumptions } from '../shared/paper';
const n=(v:number)=>v.toLocaleString('zh-TW',{maximumFractionDigits:2});
export default function PaperPanel({account,onToggle,busy}:{account:PaperAccount;onToggle:()=>void;busy:boolean}){
 const open=account.positions.filter(p=>!p.closedAt),closed=account.positions.filter(p=>p.closedAt),realized=closed.reduce((s,p)=>s+(p.pnl??0),0),marked=open.reduce((s,p)=>s+(p.mark??p.buyPrice)*p.quantity,0);
 return <section><h2>10萬元虛擬交易</h2><p>AI 分析後，固定模擬規則自動記帳。只使用勾選「納入虛擬交易」的短線查詢；每日自動分析請至「自動排程」啟用。沒有實際下單。</p><button disabled={busy} onClick={onToggle}>{account.enabled?'暫停虛擬交易':'啟用虛擬交易'}</button><p className="muted">暫停會停止買進及出清。帳本不會重設。持倉報價每分鐘檢查，服務必須開啟。</p>
 <div className="stats"><article><small>可用虛擬現金</small><h3>{n(account.cash)}</h3></article><article><small>已實現模擬損益</small><h3>{n(realized)}</h3></article><article><small>參考總資產（未扣未平倉賣出成本）</small><h3>{n(account.cash+marked)}</h3></article></div>
 <p>持倉 {open.length} 檔 · 已結束 {closed.length} 筆（獲利 {closed.filter(p=>(p.pnl??0)>0).length}、虧損 {closed.filter(p=>(p.pnl??0)<0).length}） · 初始資金 {n(account.initialCash)}。估值使用最後保存買價，可能過期；不是清算保證。</p>
 {account.error&&<p className="error">{account.error}</p>}<details><summary>固定模擬假設 · {account.version}</summary><ul>{paperAssumptions.map(x=><li key={x}>{x}</li>)}</ul></details>
 <h3>模擬買賣帳本</h3><div className="answer-table"><table><thead><tr><th>股票</th><th>模擬買進</th><th>股數／成本</th><th>模擬賣出</th><th>損益／狀態</th></tr></thead><tbody>{[...account.positions].reverse().map(p=><tr key={p.id}><td>{p.code} {p.name}</td><td>{n(p.buyPrice)}<br/>{new Date(p.openedAt).toLocaleString('zh-TW')}</td><td>{p.quantity} 股<br/>{n(p.cost)}</td><td>{p.closedAt?<>{n(p.sellPrice!)}<br/>{new Date(p.closedAt).toLocaleString('zh-TW')}</>:'未平倉'}</td><td>{p.pnl===undefined?'尚未實現':n(p.pnl)}{p.pnl!==undefined&&p.pnl<=0&&<small><br/>{p.sellPrice!>p.buyPrice?'成本侵蝕':'價格未達模擬買進成本'}（結果分類，非因果結論）</small>}<br/>{p.issue??p.exitReason??('預定 '+(p.plannedExitDate??'待確認')+' 13:20出清')}{p.markedAt&&<small><br/>估值報價 {new Date(p.markedAt).toLocaleString('zh-TW')}</small>}</td></tr>)}</tbody></table></div>
 {!account.positions.length&&<p>尚無模擬成交；不回填舊查詢或虛構績效。</p>}
 <h3>每日鎖定名單</h3>{[...account.days].reverse().map(d=><details key={d.id}><summary>{d.date} · {d.selected.join('、')||'零候選'} · {({recorded:'等待處理',zero:'零候選',missed:'錯過買進窗口',processed:'已處理',data_missing:'資料不足'}[d.state])}</summary><p>{d.strategy} · 發布 {new Date(d.publishedAt).toLocaleString('zh-TW')}</p><ul>{d.notes.map((x,i)=><li key={i}>{x}</li>)}</ul><small>快照識別 {d.snapshotHash}</small></details>)}
 </section>;
}

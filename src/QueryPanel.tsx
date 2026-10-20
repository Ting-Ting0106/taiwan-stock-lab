import { useEffect, useRef, useState, type ReactNode } from 'react';
import { nextDayPrompt, afterHoursPrompt, longTermSectorPrompt } from '../shared/research-prompt';
import MarketEvidence from './MarketEvidence';
import ResearchAnswer from './ResearchAnswer';
import type { AccountUsage, Profile, Query, Schedule } from '../shared/model';

export interface AuthStatus { connected: boolean; account?: string; profileId?: string; planEnabled: boolean; profiles: Profile[]; persistenceError?: string }
async function request(path: string, body?: unknown) {
  const response = await fetch('/api/' + path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '操作失敗');
  return result;
}
export type Page = 'overview' | 'manual' | 'schedule' | 'history' | 'trades' | 'research' | 'paper';
export const pages: { id: Page; label: string; icon: string }[] = [{ id: 'overview', label: '總覽', icon: '◫' }, { id: 'manual', label: '手動查詢', icon: '⌕' }, { id: 'schedule', label: '自動排程', icon: '◷' }, { id: 'history', label: '查詢紀錄', icon: '≡' }, { id: 'paper', label: '虛擬交易', icon: '＄' }, { id: 'trades', label: '交易紀錄', icon: '↔' }, { id: 'research', label: '進階研究', icon: '▤' }];
const statuses = { running: '查詢中', succeeded: '回覆完成', failed: '失敗', interrupted: '服務中斷', missed: '錯過排程', market_closed: '休市略過', market_unknown: '開休市未確認' };
function QueryStatus({status}:{status:Query['status']}){return <span className={'badge query-status status-'+status}>{statuses[status]}</span>;}
const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
const localTime = (date: string) => new Date(date).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
const compactTime = (date: string) => new Date(date).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
function UsagePanel({ analysisAccount, connected, profileId }: { analysisAccount?: string; connected: boolean; profileId?: string }) {
  const [usage, setUsage] = useState<AccountUsage>({ status: 'idle', source: 'codex-app-server', windows: [] });
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setLoading(connected);
    setUsage({ status: 'idle', source: 'codex-app-server', windows: [] });
    setError('');
    const update = () => request(connected ? 'usage/refresh' : 'usage', connected ? {} : undefined).then(result => { if (active) { setUsage(result); setError(''); } }).catch(() => { if (active) setError('用量服務尚未連線；若剛更新程式，請先重啟本機 server。'); }).finally(() => { if (active) setLoading(false); });
    void update(); const timer = setInterval(() => { void update(); }, 60000);
    return () => { active = false; clearInterval(timer); };
  }, [connected, profileId]);
  async function refreshUsage() {
    setLoading(true); setError('');
    try { setUsage(await request('usage/refresh', {})); }
    catch (e) { setError(e instanceof Error ? e.message : '讀取用量失敗'); }
    finally { setLoading(false); }
  }
  const mismatch = Boolean(analysisAccount && usage.account && analysisAccount.toLowerCase() !== usage.account.toLowerCase());
  const duration = (minutes: number | null) => minutes === null ? '週期未提供' : minutes % 1440 === 0 ? `${minutes / 1440} 天週期` : minutes % 60 === 0 ? `${minutes / 60} 小時週期` : `${minutes} 分鐘週期`;
  return <article className="usage-panel" aria-label="帳號用量"><div className="section-heading"><h3>Codex 用量</h3><button className="secondary" aria-label="更新帳號用量" disabled={loading} onClick={() => void refreshUsage()}>{loading ? '讀取中' : '更新'}</button></div>
    {usage.status === 'idle' && <p className="muted">讀取本機 Codex 已登入帳號的用量。</p>}
    {usage.account && <div className="usage-identity"><span className="badge connected">Codex 用量已連線{usage.plan ? ` · ${usage.plan}` : ''}</span><strong>{usage.account}</strong></div>}
    {mismatch && <p className="error">用量帳號與分析帳號不同。</p>}
    {(error || usage.error) && <p className="error" role="status">{error || usage.error}</p>}
    {usage.status === 'available' && <div className="cards">{usage.windows.map(window => <div className="quota-window" key={window.id}><div className="section-heading"><strong>{duration(window.durationMinutes)}</strong><span>剩餘 {window.remainingPercent}%</span></div><progress aria-label={`${window.name} ${duration(window.durationMinutes)} 已用比例`} max={100} value={window.usedPercent} /><small>已用 {window.usedPercent}%{window.name !== 'codex' ? ` · ${window.name}` : ''} · 重置 {window.resetsAt ? compactTime(window.resetsAt) : '未提供'}</small></div>)}</div>}
    {usage.credits && <p>點數：{usage.credits.unlimited ? '官方回報無上限' : usage.credits.balance !== null ? `餘額 ${usage.credits.balance}` : usage.credits.hasCredits ? '有可用點數，餘額未提供' : '無可用點數'}</p>}
    <p className="muted">{usage.checkedAt ? `更新 ${compactTime(usage.checkedAt)} · 每分鐘更新` : '尚未讀取用量'}<br />僅顯示 Codex 額度，與分析授權分開。</p>
  </article>;
}
export default function QueryPanel({ auth, schedule, queries, onChanged, heading, children, page, navigate }: { auth: AuthStatus; schedule: Schedule; queries: Query[]; onChanged: () => Promise<void>; heading: ReactNode; children?: ReactNode; page: Page; navigate: (page: Page) => void }) {
  const [selectedQuery, setSelectedQuery] = useState<string>();
  const [triggerFilter, setTriggerFilter] = useState('all'), [statusFilter, setStatusFilter] = useState('all'), [dateFilter, setDateFilter] = useState('');
  const [notification, setNotification] = useState('');
  const [noticeStatus,setNoticeStatus]=useState<Query['status']>('succeeded');
  const previousQueries = useRef(queries);
  useEffect(() => {
    const finished = queries.find(q => q.status !== 'running' && previousQueries.current.some(old => old.id === q.id && old.status === 'running'));
    if (finished) { setNoticeStatus(finished.status); setNotification('查詢已結束：' + statuses[finished.status]); setSelectedQuery(finished.id); }
    previousQueries.current = queries;
  }, [queries]);
  function viewResult(id?: string) { setSelectedQuery(id); setTriggerFilter('all'); setStatusFilter('all'); setDateFilter(''); navigate('history'); }
  const latestManual = queries.find(q => q.trigger === 'manual');
  const filteredQueries = queries.filter(q => (triggerFilter === 'all' || q.trigger === triggerFilter) && (statusFilter === 'all' || q.status === statusFilter) && (!dateFilter || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date(q.createdAt)) === dateFilter));
  const [accountOpen, setAccountOpen] = useState(true);
  const toggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && accountOpen) { setAccountOpen(false); toggleRef.current?.focus(); } };
    window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close);
  }, [accountOpen]);
  const [form, setForm] = useState(() => ({ paperTrade:false, trendMode:true, prompt: schedule.prompt, model: schedule.model, webSearch: schedule.webSearch, includeResearch: schedule.includeResearch }));
  const [scheduleForm, setScheduleForm] = useState(schedule);
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [profileId, setProfileId] = useState(auth.profileId ?? auth.profiles[0]?.id ?? '');
  const [message, setMessage] = useState(''), [working, setWorking] = useState(false), [loadingModels, setLoadingModels] = useState(false);
  const running = queries.some(q => q.status === 'running');
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.has('login')) {
      setMessage(params.get('login') === 'success' ? '帳號已連線，請確認是否已授權使用 ChatGPT 額度。' : params.get('reason') || '登入未完成');
      history.replaceState(null, '', location.pathname);
    }
  }, []);
  useEffect(() => {
    let active = true;
    setModels([]);
    if (!auth.connected || !auth.planEnabled) return;
    setLoadingModels(true);
    request('models').then(result => {
      if (!active) return;
      setModels(result);
      setForm(previous => ({ ...previous, model: result.some((m: { id: string }) => m.id === previous.model) ? previous.model : result[0]?.id ?? '' }));
      setScheduleForm(previous => ({ ...previous, model: result.some((m: { id: string }) => m.id === previous.model) ? previous.model : result[0]?.id ?? '' }));
      if (!result.length) setMessage('此帳號目前沒有可用模型');
    }).catch(error => { if (active) setMessage(error.message); }).finally(() => { if (active) setLoadingModels(false); });
    return () => { active = false; };
  }, [auth.profileId, auth.connected, auth.planEnabled]);
  async function action(task: () => Promise<string>) {
    setWorking(true); setMessage('處理中…');
    try { const result = await task(); await onChanged(); setMessage(result); }
    catch (error) { setMessage(error instanceof Error ? error.message : '操作失敗'); }
    finally { setWorking(false); }
  }
  const canQuery = auth.connected && auth.planEnabled && Boolean(form.model) && Boolean(form.prompt.trim()) && !loadingModels && !running && !working;
  const savedProfile = auth.profiles.find(profile => profile.id === profileId);
  const analysisStatus = auth.connected ? auth.planEnabled ? 'AI 分析已連線' : '已登入・待授權分析' : savedProfile ? '已儲存帳號・分析待登入' : 'AI 分析待登入';
  return <div className={'workspace' + (accountOpen ? '' : ' workspace--collapsed')}>
    <button className="sidebar-scrim" hidden={!accountOpen} aria-label="關閉帳號欄遮罩" onClick={() => setAccountOpen(false)} />
    <section className="account-sidebar" aria-label="主導覽與帳號"><div className="sidebar-heading"><button ref={toggleRef} className="account-toggle" aria-label={accountOpen ? '收合帳號欄' : '展開帳號欄'} title={accountOpen ? '收合帳號欄' : '展開帳號欄'} aria-expanded={accountOpen} aria-controls="account-sidebar-content" onClick={() => setAccountOpen(open => !open)}><svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg></button>{accountOpen && <h2>每日台股研究室</h2>}</div>
      <nav aria-label="主要導覽">{pages.map(item => <button key={item.id} title={item.label} aria-label={item.label} aria-current={page === item.id ? 'page' : undefined} onClick={() => { navigate(item.id); if (window.matchMedia('(max-width: 820px)').matches) setAccountOpen(false); }}><span aria-hidden="true">{item.icon}</span>{accountOpen && <span>{item.label}</span>}</button>)}</nav>
      <div id="account-sidebar-content" hidden={!accountOpen}><details className="account-drawer"><summary><strong>帳號與用量</strong><span className="muted">{auth.connected ? auth.account : '待登入'}</span></summary>
      <span className={'badge ' + (auth.connected && auth.planEnabled ? 'connected' : '')}>{analysisStatus}</span>
      <p className="account-caption">{auth.connected ? `分析帳號：${auth.account}` : savedProfile ? '此帳號已儲存，請重新登入啟用分析。' : '登入 ChatGPT 以啟用 AI 分析。'}</p>
      <div className="toolbar"><label>{auth.profiles.length ? '已儲存帳號' : '分析帳號'}<select aria-label="選擇登入帳號" value={profileId} onChange={e => setProfileId(e.target.value)}><option value="">新增 ChatGPT 帳號</option>{auth.profiles.map(p => <option key={p.id} value={p.id}>{p.email}{auth.profiles.filter(other => other.email === p.email).length > 1 ? ` · ${p.id.slice(-6)}` : ''}</option>)}</select></label><div className={'auth-actions' + (auth.connected ? ' auth-actions--connected' : '')}><button aria-label={auth.connected ? '重新連接 ChatGPT' : savedProfile ? '重新登入 ChatGPT' : '登入 ChatGPT'} disabled={working || running} onClick={() => void action(async () => { const result = await request('auth/start', profileId ? { profileId } : {}); location.assign(result.url); return '正在前往 OpenAI 官方登入頁…'; })}>{auth.connected ? '重新連線' : savedProfile ? '重新登入 ChatGPT' : '登入 ChatGPT'}</button>{auth.connected && <button className="secondary" aria-label="登出並停用排程" title="登出並停用排程" disabled={working} onClick={() => void action(async () => { const result = await request('auth/logout', {}); return result.message; })}>登出</button>}</div></div>
      {auth.persistenceError && <p className="error" role="status">{auth.persistenceError}</p>}<UsagePanel analysisAccount={auth.account} connected={auth.connected} profileId={auth.profileId} />
      <p className="muted sidebar-note">本機會安全記住登入；授權失效或登出後需重新登入。</p>
      </details></div>
    </section>
    <div className="workspace-main">
    {heading}
    <div className="page-heading"><span className="eyebrow">WORKSPACE</span><h2>{pages.find(item => item.id === page)?.label}</h2></div>
    {notification && <div className={'completion-notice status-'+noticeStatus} role="status">{notification}<button className="secondary" onClick={() => { viewResult(selectedQuery); setNotification(''); }}>查看結果</button><button className="secondary" onClick={() => setNotification('')}>關閉提示</button></div>}
    {page === 'overview' && <><div className="stats"><article><small>最新查詢</small><h3>{queries[0] ? <QueryStatus status={queries[0].status}/> : '尚無紀錄'}</h3><p>{queries[0] ? localTime(queries[0].createdAt) : '從手動查詢開始'}</p></article><article><small>自動排程</small><h3>{schedule.enabled ? schedule.time : '未啟用'}</h3><p>{schedule.enabled ? schedule.weekdays.map(day => '週' + weekdays[day]).join('、') + ' · 台北時間' : '可至自動排程設定'}</p></article><article><small>分析帳號</small><h3>{auth.connected ? '已連線' : '待登入'}</h3><p>{auth.account ?? '請展開左側帳號與用量'}</p></article></div><section><h3>最新查詢摘要</h3>{queries[0] ? <><p>{queries[0].prompt}</p>{queries[0].error && <p className="error">{queries[0].error}</p>}{queries[0].output && <ResearchAnswer text={queries[0].output.split(/\n\s*\n/).slice(0, 2).join('\n\n')} sources={queries[0].sources} />}<button onClick={() => { viewResult(queries[0].id); }}>查看完整結果</button></> : <p>尚無查詢結果。</p>}<button className="secondary" onClick={() => navigate('manual')}>開始手動查詢</button></section><p className="muted">AI 自行上網查詢，取得的資料以來源與時間為準；尚未啟用全市場 12:00 技術掃描。</p></>}
    {message && <p role="status" className="notice">{message}</p>}
    <section className="query-panel" hidden={page !== 'manual'}><span className="eyebrow">AI RESEARCH</span><h2>手動查詢</h2>
      <p className="muted">啟用網路查詢後，由 AI 自行搜尋 K 線、MA、KD、MACD 與成交量資料，不需匯入檔案；後端會自動準備官方日線、計算指標並附盤中報價；AI 再補查消息。查不到的欄位會標示缺資料，內外盤不是必填門檻。</p>
      <div className="manual-query-fields"><p className="muted">套用範本會替換本頁問題並開啟網路查詢，不會直接執行查詢。</p><button className="secondary" onClick={() => setForm(previous => ({ ...previous, prompt: nextDayPrompt, webSearch: true, paperTrade:false, trendMode:true }))}>套用隔日出清範本</button><button className="secondary" onClick={() => setForm(previous => ({ ...previous, prompt: afterHoursPrompt, webSearch: true, paperTrade:false, trendMode:false }))}>套用盤後選股範本</button><button className="secondary" onClick={() => setForm(previous => ({ ...previous, prompt: longTermSectorPrompt, webSearch: true, paperTrade:false, trendMode:false }))}>套用產業長期布局範本</button><p className="muted">隔日出清／盤後選股：短線研究；產業長期布局：6～24 個月基本面與估值比較。</p><label>查詢內容<textarea aria-label="查詢內容" rows={5} maxLength={4000} value={form.prompt} onChange={e => setForm({ ...form, prompt: e.target.value })} placeholder="例如：查詢今日台股市場概況與重要風險，附資料來源及時間。" /></label><label>帳號可用模型<select aria-label="AI 模型" value={form.model} onChange={e => setForm({ ...form, model: e.target.value })} disabled={loadingModels || !models.length}><option value="">{loadingModels ? '讀取模型中…' : '登入後載入可用模型'}</option>{models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label><label className="check"><input type="checkbox" checked={form.webSearch} onChange={e => setForm({ ...form, webSearch: e.target.checked })} />AI 自行上網查詢行情與技術指標（附來源）</label><label className="check"><input type="checkbox" checked={form.includeResearch} onChange={e => setForm({ ...form, includeResearch: e.target.checked })} />額外附上本機收盤研究（選用，不影響 AI 上網查詢）</label><label className="check"><input type="checkbox" checked={form.trendMode} onChange={e=>setForm({...form,trendMode:e.target.checked})}/>隔日11時趨勢分析（手動查詢不建立正式部位）</label><button disabled={!canQuery} onClick={() => void action(async () => { await request('queries', { prompt: form.prompt, model: form.model, webSearch: form.webSearch, includeResearch: form.includeResearch, paperTrade:false, trendMode:form.trendMode }); return '查詢已開始，結果會自動更新，會先抓取行情與計算指標，再分析，最長約六分鐘。'; })}>{running ? 'AI 查詢進行中…' : '立即手動查詢'}</button></div>
    </section>
      <section className="schedule-panel" hidden={page !== 'schedule'}><details><summary><strong>自動排程查詢</strong><span className="badge">{schedule.enabled ? `已啟用 · ${schedule.time}` : '未啟用'}</span><span className="muted schedule-expand">展開設定</span><span className="muted schedule-collapse">收合設定</span></summary><p>獨立設定排程問題與模型。台北時間，每個選定平日最多一次；修改後請儲存。</p><p className="muted">套用範本會替換排程問題並開啟網路查詢，儲存後才生效。</p><button className="secondary" onClick={() => setScheduleForm(previous => ({ ...previous, prompt: nextDayPrompt, webSearch: true, paperTrade:true, trendMode:true, time:'12:00' }))}>套用隔日出清範本</button><button className="secondary" onClick={() => setScheduleForm(previous => ({ ...previous, prompt: afterHoursPrompt, webSearch: true, paperTrade:false, trendMode:false }))}>套用盤後選股範本</button><button className="secondary" onClick={() => setScheduleForm(previous => ({ ...previous, prompt: longTermSectorPrompt, webSearch: true, paperTrade:false, trendMode:false }))}>套用產業長期布局範本</button><p className="muted">長期範本用於 6～24 個月研究，套用不會更改排程時間、啟用狀態或既有交易規則。</p><label>查詢內容<textarea aria-label="排程查詢內容" rows={5} maxLength={4000} value={scheduleForm.prompt} onChange={e => setScheduleForm({ ...scheduleForm, prompt: e.target.value })} placeholder="例如：查詢今日台股市場概況與重要風險，附資料來源及時間。" /></label><label>帳號可用模型<select aria-label="排程 AI 模型" value={scheduleForm.model} onChange={e => setScheduleForm({ ...scheduleForm, model: e.target.value })} disabled={loadingModels || !models.length}><option value="">{loadingModels ? '讀取模型中…' : '登入後載入可用模型'}</option>{models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label><label className="check"><input type="checkbox" checked={scheduleForm.webSearch} onChange={e => setScheduleForm({ ...scheduleForm, webSearch: e.target.checked })} />AI 自行上網查詢行情與技術指標（附來源）</label><label className="check"><input type="checkbox" checked={scheduleForm.includeResearch} onChange={e => setScheduleForm({ ...scheduleForm, includeResearch: e.target.checked })} />額外附上本機收盤研究（選用，不影響 AI 上網查詢）</label><label className="check"><input type="checkbox" checked={scheduleForm.enabled} onChange={e => setScheduleForm({ ...scheduleForm, enabled: e.target.checked })} />啟用排程</label><label className="check"><input type="checkbox" checked={scheduleForm.paperTrade??false} onChange={e=>setScheduleForm({...scheduleForm,paperTrade:e.target.checked,time:e.target.checked?'12:00':scheduleForm.time,trendMode:e.target.checked})}/>12:00假想買進／下一交易日11:00檢驗</label><label>執行時間<input type="time" disabled={Boolean(scheduleForm.paperTrade)} value={scheduleForm.time} onChange={e => setScheduleForm({ ...scheduleForm, time: e.target.value })} /></label><div className="days">{[1, 2, 3, 4, 5].map(day => <label className="check" key={day}><input type="checkbox" checked={scheduleForm.weekdays.includes(day)} onChange={e => setScheduleForm({ ...scheduleForm, weekdays: e.target.checked ? [...scheduleForm.weekdays, day] : scheduleForm.weekdays.filter(d => d !== day) })} />週{weekdays[day]}</label>)}</div><button className="secondary" disabled={working || !scheduleForm.time || !scheduleForm.weekdays.length || !scheduleForm.prompt.trim() || (!scheduleForm.model && scheduleForm.enabled)} onClick={() => void action(async () => { await request('schedule', scheduleForm); return scheduleForm.enabled ? '排程已儲存並啟用，會使用目前登入帳號的額度。' : '排程已停用'; })}>儲存排程設定</button><p><strong>{schedule.enabled ? `已啟用：${schedule.time}` : '目前排程未啟用'}</strong>{schedule.lastAttemptDate && ` · 最近處理日期 ${schedule.lastAttemptDate}`}</p><small>服務需開啟；錯過五分鐘不補跑。執行前查官方年度日曆與當日市場交易資料；休市或無法確認就略過，不消耗AI額度。不是全市場12:00技術選股。</small></details></section>
    <section hidden={page !== 'history'}><div className="section-heading"><h2>AI 查詢結果與執行紀錄</h2><span className="muted">每 5 秒更新</span></div>{!queries.length && <p>尚無查詢紀錄。登入並選擇模型後，可手動查詢或開啟排程。</p>}<div className="history-filters"><label>日期<input aria-label="紀錄日期" type="date" value={dateFilter} onChange={e => setDateFilter(e.target.value)} /></label><label>查詢類型<select aria-label="紀錄類型" value={triggerFilter} onChange={e => setTriggerFilter(e.target.value)}><option value="all">全部</option><option value="manual">手動查詢</option><option value="schedule">自動排程</option></select></label><label>狀態<select aria-label="紀錄狀態" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}><option value="all">全部</option>{Object.entries(statuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label></div>{queries.length > 0 && !filteredQueries.length && <p>沒有符合條件的紀錄。</p>}{filteredQueries.map(q => <div className="history-row" key={q.id}><button className="history-select" aria-expanded={selectedQuery === q.id} onClick={() => setSelectedQuery(selectedQuery === q.id ? undefined : q.id)}><QueryStatus status={q.status}/> {localTime(q.createdAt)} · {q.trigger === 'schedule' ? '自動排程' : '手動查詢'}<span className="history-prompt">{q.prompt}</span></button>{selectedQuery === q.id && <div className="history-detail"><p>{q.prompt}</p><small>{q.model} · {q.webSearch ? '網路查詢' : '僅提供資料'}{q.finishedAt ? ` · 結束 ${localTime(q.finishedAt)}` : ''}</small>{q.marketCheck && <p className="muted">開休市查核：{q.marketCheck.date} · {q.marketCheck.reason}{q.marketCheck.sources.map(url=><a key={url} href={url} target="_blank" rel="noreferrer"> · 官方來源</a>)}</p>}{q.error && <p className="error">{q.error}</p>}{q.trendDecisionError&&<p className="error">{q.trendDecisionError}</p>}{q.trendDecision&&<section><h4>AI隔日11時偏多名單</h4><p>{q.trendDecision.summary}</p><ul>{q.trendDecision.selected.map(s=><li key={s.market+s.code}>{s.code}：{s.reason}</li>)}</ul><small>假想進場參考，非真實成交；{q.trigger==='manual'?'手動查詢不建立正式部位':'正式12時排程由虛擬帳本記錄'}</small></section>}{q.status === 'running' && <p role="status">查詢中，請稍候…</p>}{q.searchCalls !== undefined && <p className="muted">搜尋工具紀錄：{q.searchCalls} 次 · 引用：{q.sources.length} 筆 · 搜尋來源：{q.searchSources?.length ?? 0} 筆</p>}<MarketEvidence report={q.marketResearch} />{q.output && <>{q.status !== 'succeeded' && <h4>未驗證回覆（不可作為推薦結果）</h4>}<ResearchAnswer text={q.output} sources={[...q.sources, ...(q.searchSources ?? [])]} /></>}{Boolean(q.searchSources?.length) && <details><summary>搜尋工具來源（不代表回答已引用）</summary><ul>{q.searchSources!.map(s => <li key={s.url}><a href={s.url} target="_blank" rel="noreferrer">{s.title}</a></li>)}</ul></details>}{q.sources.length > 0 && <><h4>引用來源</h4><ul>{q.sources.map(s => <li key={s.url}><a href={s.url} target="_blank" rel="noreferrer">{s.title}</a></li>)}</ul></>}</div>}</div>)}</section>
    {page === 'manual' && latestManual && <section><h3>本次／最近手動查詢結果</h3><p><QueryStatus status={latestManual.status}/> · {localTime(latestManual.createdAt)}</p>{latestManual.trendDecisionError&&<p className="error">{latestManual.trendDecisionError}</p>}{latestManual.error && <p className="error">{latestManual.error}</p>}{latestManual.status === 'running' && <p role="status">{latestManual.marketResearch ? '行情準備完成，AI 正在分析。' : '正在準備官方行情、計算指標或等待分析，可切換頁面。'}</p>}<MarketEvidence report={latestManual.marketResearch} />{latestManual.output && <>{latestManual.status !== 'succeeded' && <h4>未驗證回覆</h4>}<ResearchAnswer text={latestManual.output} sources={[...latestManual.sources, ...(latestManual.searchSources ?? [])]} /></>}<button className="secondary" onClick={() => viewResult(latestManual.id)}>查看完整紀錄與來源</button></section>}
    {children}
    </div>
  </div>;
}

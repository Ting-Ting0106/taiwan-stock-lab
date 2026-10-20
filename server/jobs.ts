import { tradingCalendar } from './calendar.ts';
import { PaperEngine } from './paper.ts';
import { randomUUID } from 'node:crypto';
import type { Query, QueryInput, Schedule } from '../shared/model';
import type { ChatGPTAuth } from './auth.ts';
import { collectMarketResearch } from './market.ts';
import { queryAI, UnverifiedResponseError } from './ai.ts';
import { read, mutate } from './store.ts';

export function taipeiClock(now: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (key: string) => parts.find(p => p.type === key)!.value;
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  return { date, minutes: Number(get('hour')) * 60 + Number(get('minute')), weekday: new Date(date + 'T00:00:00Z').getUTCDay() };
}
export function scheduleDecision(schedule: Schedule, now: Date): 'wait' | 'due' | 'missed' {
  const clock = taipeiClock(now), [hour, minute] = schedule.time.split(':').map(Number), late = clock.minutes - (hour * 60 + minute);
  if (!schedule.enabled || !schedule.weekdays.includes(clock.weekday) || schedule.lastAttemptDate === clock.date || late < 0) return 'wait';
  return late < 5 ? 'due' : 'missed';
}
export class QueryJobs {
  private busy = false;
  private paper = new PaperEngine();
  private timer?: ReturnType<typeof setInterval>;
  private auth: ChatGPTAuth;
  private execute: typeof queryAI;
  private collect: typeof collectMarketResearch;
  private checkMarket: typeof tradingCalendar.check;
  constructor(auth: ChatGPTAuth, execute: typeof queryAI = queryAI, collect: typeof collectMarketResearch = collectMarketResearch, checkMarket: typeof tradingCalendar.check = now => tradingCalendar.check(now)) { this.checkMarket=checkMarket; this.auth = auth; this.execute = execute; this.collect = collect; }
  get running() { return this.busy; }
  async manual(input: QueryInput) {
    if (this.busy) throw new Error('已有查詢執行中，請等待完成');
    const account = await this.auth.status();
    if (!account.connected || !account.planEnabled) throw new Error('請先登入 ChatGPT 並授權使用訂閱額度');
    if (this.busy) throw new Error('已有查詢執行中，請等待完成');
    this.busy = true;
    try {
      const job: Query = { ...input, id: randomUUID(), createdAt: new Date().toISOString(), trigger: 'manual', status: 'running', sources: [], profileId: account.profileId };
      await mutate(db => db.queries.push(job));
      void this.finish(job).finally(() => { this.busy = false; }).catch(() => { console.error('查詢紀錄保存失敗'); });
      return job;
    } catch (e) { this.busy = false; throw e; }
  }
  private async finish(job: Query) {
    let result: Partial<Query>;
    try {
      if ((await this.auth.status()).profileId !== job.profileId) throw new Error('目前登入帳號與此排程指定帳號不同，請重新儲存排程');
      const db = await read(), research = job.includeResearch ? db.runs.at(-1) : undefined;
      if (job.includeResearch && !research) throw new Error('沒有可附加的收盤研究，請先匯入行情並研究');
      const marketResearch = job.webSearch ? await this.collect(job.prompt) : undefined;
      if (marketResearch) await mutate(db => { const target = db.queries.find(q => q.id === job.id); if (target) target.marketResearch = marketResearch; });
      if ((await this.auth.status()).profileId !== job.profileId) throw new Error('資料準備期間登入帳號已變更，未發送 AI 查詢');
      const feedback=(job.paperTrade||job.trendMode?db.paper?.days??[]:[]).filter(d=>d.review&&Date.parse(d.review.evaluatedAt)<=Date.parse(job.createdAt)).slice(-5).map(d=>({id:d.id,date:d.date,strategy:d.strategy,review:d.review!}));
      await mutate(db=>{const target=db.queries.find(q=>q.id===job.id);if(target)target.feedbackIds=feedback.map(d=>d.id);});
      const response = await this.execute(this.auth, job, research, job.profileId, marketResearch, feedback);
      result = { ...response, status: 'succeeded', researchId: research?.id };
    } catch (e) { result = { ...(e instanceof UnverifiedResponseError ? e.result : {}), status: 'failed', error: e instanceof Error ? e.message : '查詢失敗' }; }
    await mutate(db => { const target = db.queries.find(q => q.id === job.id); if (target) Object.assign(target, result, { finishedAt: new Date().toISOString() }); });
    const saved=(await read()).queries.find(q=>q.id===job.id);
    if(saved?.paperTrade)await this.paper.accept(saved);
  }
  async tick(now = new Date()) {
    if (this.busy) return;
    this.busy = true;
    try {
      const initial=(await read()).schedule;
      if (scheduleDecision(initial, now) === 'wait') return;
      const started=Date.now();
      const marketCheck=await this.checkMarket(now);
      const effectiveNow=new Date(+now+Date.now()-started),clock=taipeiClock(effectiveNow);
      if(marketCheck.date!==clock.date)return;
      const job = await mutate(db => {
        const schedule = db.schedule, decision = scheduleDecision(schedule, effectiveNow);
        if(JSON.stringify(schedule)!==JSON.stringify(initial))return undefined;
        if (decision === 'wait') return undefined;
        schedule.lastAttemptDate = clock.date;
        const job: Query = { trendMode: schedule.paperTrade || schedule.trendMode, paperTrade: schedule.paperTrade, prompt: schedule.prompt, model: schedule.model, webSearch: schedule.webSearch, includeResearch: schedule.includeResearch, id: randomUUID(), createdAt: now.toISOString(), trigger: 'schedule', profileId: schedule.ownerProfileId, sources: [], marketCheck, status: marketCheck.state === 'closed' ? 'market_closed' : marketCheck.state === 'unknown' ? 'market_unknown' : decision === 'due' ? 'running' : 'missed', ...(decision === 'missed' ? { finishedAt: now.toISOString(), error: '服務未在排程時間起的五分鐘內執行，已略過；不會補發過期查詢' } : {}) };
        if(marketCheck.state!=='open'){job.finishedAt=effectiveNow.toISOString();job.error=marketCheck.reason;}
        db.queries.push(job); return job;
      });
      if (job?.status === 'running') await this.finish(job);
    } finally { this.busy = false; }
  }
  async start() {
    this.paper.start();
    const db = await read();
    if (db.queries.some(q => q.status === 'running')) await mutate(db => { for (const job of db.queries) if (job.status === 'running') Object.assign(job, { status: 'interrupted', error: '上次服務關閉時查詢尚未完成，未自動重試', finishedAt: new Date().toISOString() }); });
    this.timer = setInterval(() => { void this.tick().catch(() => { console.error('排程紀錄保存失敗'); }); }, 30000);
    this.timer.unref();
    void this.tick().catch(() => { console.error('排程啟動失敗'); });
  }
  stop() { this.paper.stop(); if (this.timer) clearInterval(this.timer); }
}

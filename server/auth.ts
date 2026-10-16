import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { z } from 'zod';
import type { Profile } from '../shared/model';
import { read, mutate } from './store.ts';
import { sessionVault, type SessionVault } from './session-vault.ts';

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const random = () => randomBytes(32).toString('base64url');
type Pending = { state: string; nonce: string; verifier: string; browser: string; redirect: string; expires: number; profile?: Profile; generation: number };
type Session = { profile: Profile; access: string; refresh?: string; expires: number; scopes: string[]; idToken: string };
const tokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().optional(), expires_in: z.number().positive(), scope: z.string().optional(), id_token: z.string().optional() });

const sessionSchema = z.object({ profile: z.object({ id: z.string(), subject: z.string(), email: z.string() }), access: z.string(), refresh: z.string().optional(), expires: z.number(), scopes: z.array(z.string()), idToken: z.string() });
// Credentials are encrypted with Windows DPAPI, never returned to the browser.
export class ChatGPTAuth {
  private pending = new Map<string, Pending>();
  private session?: Session;
  private refreshing?: Promise<string>;
  private generation = 0;
  private discovery?: Promise<{ issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; revocation_endpoint?: string }>;
  private fetcher: typeof fetch;
  private vault: SessionVault;
  private loaded?: Promise<void>;
  private persistenceError?: string;
  constructor(fetcher: typeof fetch = fetch, vault: SessionVault = sessionVault()) { this.fetcher = fetcher; this.vault = vault; }
  private async restore() {
    this.loaded ??= (async () => {
      try { const saved = await this.vault.load(); if (saved) this.session = sessionSchema.parse(saved); }
      catch { this.persistenceError = '無法還原本機登入，請重新登入'; }
    })();
    await this.loaded;
  }
  private async saveSession() {
    try { if (this.session) await this.vault.save(this.session); else await this.vault.clear(); this.persistenceError = undefined; }
    catch { this.persistenceError = '無法保存本機登入，本次連線僅在服務開啟期間有效'; }
  }
  private async config() {
    if (!this.discovery) this.discovery = (async () => {
      const r = await this.fetcher(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('無法取得 OpenAI 登入設定，請稍後重試');
      const data = z.object({ issuer: z.literal(issuer), authorization_endpoint: z.string().url(), token_endpoint: z.string().url(), jwks_uri: z.string().url(), revocation_endpoint: z.string().url().optional() }).parse(await r.json());
      for (const endpoint of [data.authorization_endpoint, data.token_endpoint, data.jwks_uri, data.revocation_endpoint].filter(Boolean)) {
        if (new URL(endpoint!).origin !== issuer) throw new Error('OpenAI 登入設定的網域不符');
      }
      return data;
    })();
    try { return await this.discovery; } catch (e) { this.discovery = undefined; throw e; }
  }
  async status() {
    await this.restore();
    if (this.session && this.session.expires <= Date.now() + 60000) {
      try { await this.access(); } catch { /* access clears invalid authorization; transient failures are shown below. */ }
    }
    const db = await read();
    return { connected: Boolean(this.session && this.session.expires > Date.now()), account: this.session?.profile.email, profileId: this.session?.profile.id, planEnabled: this.session?.scopes.includes('chatgpt.tokens.use.direct') ?? false, expiresAt: this.session ? new Date(this.session.expires).toISOString() : undefined, profiles: db.identity?.profiles ?? [], persistence: 'windows-dpapi' as const, persistenceError: this.persistenceError };
  }
  async start(redirect: string, profileId?: string) {
    await this.restore();
    const config = await this.config();
    const identity = await mutate(db => {
      db.identity ??= { hostId: `urn:uuid:${randomUUID()}`, profiles: [] }; return db.identity;
    });
    const profile = profileId ? identity.profiles.find(p => p.id === profileId) : undefined;
    if (profileId && !profile) throw new Error('找不到選定的帳號，請重新選擇');
    for (const [key, p] of this.pending) if (p.expires < Date.now()) this.pending.delete(key);
    if (this.pending.size >= 5) throw new Error('登入嘗試過多，請稍後重試');
    const p: Pending = { state: random(), nonce: random(), verifier: random(), browser: random(), redirect, expires: Date.now() + 600000, profile, generation: this.generation };
    const params: Record<string, string> = { client_id: profile?.id ?? 'dynamic_agent_client', ext_agent_host_id: identity.hostId, response_type: 'code', redirect_uri: redirect, scope: scopes, resource, state: p.state, nonce: p.nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(p.verifier).digest('base64url') };
    if (!profile) params.agent_name_hint = '每日台股研究室';
    this.pending.set(p.state, p);
    return { url: `${config.authorization_endpoint}?${new URLSearchParams(params)}`, browser: p.browser };
  }
  async callback(params: URLSearchParams, browser?: string) {
    const state = params.get('state') ?? '', p = this.pending.get(state);
    if (!p || p.expires < Date.now() || p.browser !== browser || p.generation !== this.generation) throw new Error('登入驗證已失效，請回到工具重新登入');
    this.pending.delete(state);
    if (params.get('error')) throw new Error('你未完成授權，或帳號目前不支援此登入方式');
    const code = params.get('code'), clientId = params.get('client_id') ?? p.profile?.id;
    if (!code || !clientId || !/^oaiapp_[A-Za-z0-9_-]+$/.test(clientId) || (p.profile && clientId !== p.profile.id)) throw new Error('登入回傳資料不完整或帳號不符');
    const config = await this.config();
    const r = await this.fetcher(config.token_endpoint, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: p.verifier, redirect_uri: p.redirect, resource }), signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`OpenAI 授權交換失敗（${r.status}），請重新登入`);
    const token = tokenSchema.parse(await r.json());
    if (!token.id_token) throw new Error('登入缺少身分憑證');
    const { payload } = await jwtVerify(token.id_token, createRemoteJWKSet(new URL(config.jwks_uri), { [customFetch]: this.fetcher }), { issuer, audience: clientId, requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5 });
    if (payload.nonce !== p.nonce || typeof payload.sub !== 'string' || (p.profile && payload.sub !== p.profile.subject)) throw new Error('登入身分驗證不符');
    const profile: Profile = { id: clientId, subject: payload.sub, email: typeof payload.email === 'string' ? payload.email : `帳號 ${clientId.slice(-6)}` };
    if (p.generation !== this.generation) throw new Error('登入狀態已變更，請重試');
    await mutate(db => { const profiles = db.identity!.profiles; const index = profiles.findIndex(x => x.id === profile.id); if (index >= 0) profiles[index] = profile; else profiles.push(profile); });
    if (p.generation !== this.generation) throw new Error('登入狀態已變更，請重試');
    this.session = { profile, access: token.access_token, refresh: token.refresh_token, expires: Date.now() + token.expires_in * 1000, scopes: (token.scope ?? '').split(' '), idToken: token.id_token };
    this.generation++; this.pending.clear();
    await this.saveSession();
  }
  async access() {
    await this.restore();
    const s = this.session;
    if (!s) throw new Error('請先使用 ChatGPT 登入');
    if (!s.scopes.includes('chatgpt.tokens.use.direct')) throw new Error('帳號已登入，但未授權使用 ChatGPT 額度，請重新授權');
    if (s.expires > Date.now() + 60000) return s.access;
    if (!s.refresh) { this.session = undefined; await this.saveSession(); throw new Error('登入已過期，請重新登入'); }
    if (!this.refreshing) this.refreshing = (async () => {
      const config = await this.config();
      const r = await this.fetcher(config.token_endpoint, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: s.profile.id, refresh_token: s.refresh!, resource }), signal: AbortSignal.timeout(20000) });
      if (!r.ok) { if (r.status === 400 || r.status === 401) { if (this.session === s) { this.session = undefined; await this.saveSession(); } } throw new Error(`登入續期失敗（${r.status}），請重新登入`); }
      const token = tokenSchema.parse(await r.json());
      if (this.session !== s) throw new Error('帳號已切換，請重試');
      Object.assign(s, { access: token.access_token, refresh: token.refresh_token ?? s.refresh, expires: Date.now() + token.expires_in * 1000, scopes: token.scope?.split(' ') ?? s.scopes });
      if (!s.scopes.includes('chatgpt.tokens.use.direct')) throw new Error('ChatGPT 額度授權已失效，請重新登入');
      await this.saveSession();
      return s.access;
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  async logout() {
    await this.restore();
    const session = this.session; this.session = undefined; this.generation++; this.pending.clear();
    await this.vault.clear();
    if (!session?.refresh) return { message: '已登出本機帳號' };
    try {
      const config = await this.config();
      if (!config.revocation_endpoint) throw new Error('missing endpoint');
      const r = await this.fetcher(config.revocation_endpoint, { method: 'POST', body: new URLSearchParams({ token: session.refresh, token_type_hint: 'refresh_token', client_id: session.profile.id }), signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('revocation failed');
      return { message: '已登出並撤銷此連線的續期授權' };
    } catch { return { message: '已清除本機登入；遠端撤銷未確認，可至 ChatGPT 設定中斷此工具連線' }; }
  }
}


export class BrowserLoginBridge {
  private tickets = new Map<string, { url: string; browser: string; expires: number }>();
  issue(pending: { url: string; browser: string }, now = Date.now()) {
    for (const [key, value] of this.tickets) if (value.expires <= now) this.tickets.delete(key);
    if (this.tickets.size >= 5) throw new Error('瀏覽器登入嘗試過多，請稍後重試');
    if (new URL(pending.url).origin !== issuer) throw new Error('登入網域不符');
    const ticket = random(); this.tickets.set(ticket, { ...pending, expires: now + 120000 }); return ticket;
  }
  consume(ticket: string, now = Date.now()) {
    const pending = this.tickets.get(ticket); this.tickets.delete(ticket);
    return pending && pending.expires > now ? { url: pending.url, browser: pending.browser } : undefined;
  }
  clear() { this.tickets.clear(); }
}

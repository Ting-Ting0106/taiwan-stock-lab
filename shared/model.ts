import type { PaperAccount } from './paper';
import type { MarketResearch } from './market';
export interface Bar { code: string; name: string; market: 'TWSE' | 'TPEX'; date: string; open: number; high: number; low: number; close: number; volume: number }
export interface Trade { id: string; code: string; buyDate: string; buyPrice: number; quantity: number; sellDate?: string; sellPrice?: number; fees: number; note: string }
export interface Profile { id: string; subject: string; email: string }
export interface UsageWindow { id: string; name: string; usedPercent: number; remainingPercent: number; durationMinutes: number | null; resetsAt: string | null }
export interface AccountUsage { status: 'idle' | 'available' | 'signed_out' | 'unavailable'; source: 'codex-app-server'; checkedAt?: string; account?: string; plan?: string; windows: UsageWindow[]; credits?: { balance: string | null; unlimited: boolean; hasCredits: boolean }; error?: string }
export interface Schedule { paperTrade?: boolean; enabled: boolean; time: string; weekdays: number[]; prompt: string; model: string; webSearch: boolean; includeResearch: boolean; ownerProfileId?: string; lastAttemptDate?: string }
export interface QueryInput { paperTrade?: boolean; prompt: string; model: string; webSearch: boolean; includeResearch: boolean }
export interface Query extends QueryInput { marketCheck?: MarketCheck; id: string; createdAt: string; finishedAt?: string; trigger: 'manual' | 'schedule'; status: 'running' | 'succeeded' | 'failed' | 'interrupted' | 'missed' | 'market_closed' | 'market_unknown'; output?: string; marketResearch?: MarketResearch; searchSources?: { title: string; url: string }[]; searchCalls?: number; error?: string; sources: { title: string; url: string }[]; researchId?: string; profileId?: string }
export interface Database { paper?: PaperAccount; bars: Bar[]; trades: Trade[]; runs: Run[]; queries: Query[]; schedule: Schedule; identity?: { hostId: string; profiles: Profile[] } }
export interface Candidate { code: string; name: string; score: number; close: number; ma5: number; ma20: number; k: number; d: number; macd: number; signal: number; reasons: string[] }
export interface Run { id: string; createdAt: string; date: string; strategy: string; mode: 'EOD_RESEARCH'; coverage: number; candidates: Candidate[]; excluded: number }

export interface MarketCheck { date:string; state:'open'|'closed'|'unknown'; reason:string; checkedAt:string; sources:string[] }

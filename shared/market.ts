export interface MarketSource { url: string; fetchedAt: string; status: 'ok' | 'error'; error?: string }
export interface MarketIndicators { ma5: number; ma10: number; ma20: number; ma60: number; k: number; d: number; dif: number; signal: number; histogram: number; volumeRatio: number | null }
export interface MarketStock {
  code: string; name: string; market: 'TWSE' | 'TPEX'; industry: string; date: string;
  open: number; high: number; low: number; close: number; volume: number; changePercent: number | null;
  historyCount: number; historyDate?: string; indicators?: MarketIndicators;
  score?: number; signals: string[]; sources: string[]; issues: string[];
  assessment?: { status: 'conditional' | 'pending' | 'excluded'; reasons: string[]; selected: boolean; rank?: number };
  quote?: { price: number; at: string; kind: 'last' | 'recent-trade'; fresh: boolean; bid: number | null; ask: number | null; snapshotAt?: string; open?: number; high?: number; low?: number; cumulativeVolume?: number; volumeUnit?: 'source-unverified' };
}
export interface SectorOverview {
 version:'sector-snapshot-0.1.0';date:string;coveredStocks:number;excludedOlderStocks:number;
 sectors:{industry:string;count:number;knownReturns:number;meanChange:number|null;medianChange:number|null;upRatio:number|null;representatives:{market:'TWSE'|'TPEX';code:string;name:string;changePercent:number|null}[]}[];
 limitations:string[];
}
export interface MarketResearch {
 sectorOverview?:SectorOverview;
  version: 'market-evidence-0.1.0' | 'market-evidence-0.2.0';
  selection?: { version: 'next-day-conditions-0.1.0' | 'next-day-trend-0.2.0'; assessedAt: string; technicalPassed: number; conditional: number; pending: number; excluded: number; selected: string[]; limitations: string[] }; collectedAt: string; mode: 'intraday' | 'after_hours';
  quality: 'intraday_available' | 'eod_only' | 'partial' | 'unavailable';
  screening: 'completed' | 'incomplete'; universeCount: number; poolCount: number; technicalCount: number;
  markets: { market: 'TWSE' | 'TPEX'; count: number; date?: string }[];
  stocks: MarketStock[]; sources: MarketSource[]; limitations: string[];
}

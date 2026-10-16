import type { Bar, Candidate } from '../shared/model';
export const VERSION = 'eod-research-0.1.0';
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
export function evaluate(bars: Bar[]): Candidate | null {
  if (bars.length < 60) return null;
  const last = bars.at(-1)!;
  let k = 50, d = 50, fast = bars[0].close, slow = fast, signal = 0, macd = 0;
  bars.forEach((b, i) => {
    fast += (b.close - fast) * 2 / 13; slow += (b.close - slow) * 2 / 27;
    macd = fast - slow; signal += (macd - signal) * 2 / 10;
    if (i >= 8) {
      const window = bars.slice(i - 8, i + 1);
      const lo = Math.min(...window.map(x => x.low)), hi = Math.max(...window.map(x => x.high));
      const rsv = hi === lo ? 50 : (b.close - lo) / (hi - lo) * 100;
      k = k * 2 / 3 + rsv / 3; d = d * 2 / 3 + k / 3;
    }
  });
  const ma5 = mean(bars.slice(-5).map(b => b.close)), ma20 = mean(bars.slice(-20).map(b => b.close));
  const previousVolume = mean(bars.slice(-21, -1).map(b => b.volume));
  const reasons: string[] = [];
  if (last.close > ma20) reasons.push('收盤價高於 MA20');
  if (ma5 > ma20) reasons.push('MA5 高於 MA20');
  if (k > d && k < 80) reasons.push('KD 偏多且 K 小於 80');
  if (macd > signal) reasons.push('MACD 高於訊號線');
  if (previousVolume > 0 && last.volume > previousVolume * 1.2) reasons.push('成交量超過前 20 日均量 1.2 倍');
  if (reasons.length < 4 || last.volume === 0) return null;
  return { code: last.code, name: last.name, score: reasons.length, close: last.close, ma5, ma20, k, d, macd, signal, reasons };
}
export function select(bars: Bar[], date: string) {
  const grouped = new Map<string, Bar[]>();
  for (const b of bars) if (b.date <= date) { const key = `${b.market}:${b.code}`; grouped.set(key, [...(grouped.get(key) ?? []), b]); }
  const candidates: Candidate[] = []; let excluded = 0;
  for (const rows of grouped.values()) {
    rows.sort((a, b) => a.date.localeCompare(b.date));
    if (rows.at(-1)?.date !== date) { excluded++; continue; }
    const result = evaluate(rows); if (result) candidates.push(result); else excluded++;
  }
  candidates.sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));
  return { candidates: candidates.slice(0, 3), excluded, coverage: grouped.size };
}

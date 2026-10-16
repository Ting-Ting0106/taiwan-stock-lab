import { test } from 'node:test';
import assert from 'node:assert/strict';
import { select } from './strategy.ts';
import type { Bar } from '../shared/model';
// 合成資料僅用於測試，不是歷史行情或績效。
const bars: Bar[] = Array.from({ length: 80 }, (_, i) => ({ code: '9999', name: '測試', market: 'TWSE', date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10), open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: i === 79 ? 2000 : 1000 }));
test('截止日之後的行情不得影響選股', () => {
  const cutoff = bars[69].date;
  assert.deepEqual(select(bars, cutoff), select(bars.slice(0, 70), cutoff));
});
test('歷史不足或當日缺資料不能選入', () => {
  assert.equal(select(bars.slice(0, 30), bars[29].date).candidates.length, 0);
  assert.equal(select(bars, '2030-01-01').candidates.length, 0);
});

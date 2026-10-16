import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Database } from '../shared/model';
import { nextDayPrompt } from '../shared/research-prompt.ts';
import { dataDirectory } from './config.ts';
export const defaultSchedule = (): Database['schedule'] => ({ enabled: false, time: '12:00', weekdays: [1, 2, 3, 4, 5], prompt: nextDayPrompt, model: '', webSearch: true, includeResearch: false });
const dir = dataDirectory, file = resolve(dir, 'database.json');
export async function read(): Promise<Database> {
  try { const db = JSON.parse(await readFile(file, 'utf8')) as Database; return { ...db, queries: db.queries ?? [], schedule: db.schedule ?? defaultSchedule() }; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { bars: [], trades: [], runs: [], queries: [], schedule: defaultSchedule() }; throw e; }
}
let pending: Promise<unknown> = Promise.resolve();
export function mutate<T>(action: (db: Database) => T): Promise<T> {
  const task = pending.then(async () => {
    const db = await read(); const result = action(db);
    await mkdir(dir, { recursive: true }); await writeFile(file + '.tmp', JSON.stringify(db, null, 2)); await rename(file + '.tmp', file);
    return result;
  });
  pending = task.catch(() => undefined); return task;
}

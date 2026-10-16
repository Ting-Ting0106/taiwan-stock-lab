import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDirectory } from './config.ts';

export interface SessionVault { load(): Promise<unknown>; save(value: unknown): Promise<void>; clear(): Promise<void> }
// DPAPI CurrentUser binds the encrypted credential to this Windows user and machine.
export function sessionVault(directory = dataDirectory): SessionVault {
  const file = join(directory, 'session.dpapi');
  let pending: Promise<unknown> = Promise.resolve();
  function serialized<T>(action: () => Promise<T>): Promise<T> {
    const next = pending.then(action); pending = next.catch(() => {}); return next;
  }
  async function crypt(value: Buffer, decrypt: boolean): Promise<Buffer> {
    if (process.platform !== 'win32') throw new Error('記住登入目前僅支援 Windows 安全儲存');
    const method = decrypt ? 'Unprotect' : 'Protect';
    const command = `Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $result=[Security.Cryptography.ProtectedData]::${method}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`;
    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      let output = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('本機安全儲存逾時')); }, 15000);
      child.stdout.on('data', data => { output += data; });
      child.on('error', () => { clearTimeout(timer); reject(new Error('無法開啟 Windows 安全儲存')); });
      child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(Buffer.from(output.trim(), 'base64')) : reject(new Error('無法存取本機加密登入，請重新登入')); });
      child.stdin.on('error', () => {}); child.stdin.end(value.toString('base64'));
    });
  }
  return {
    load: () => serialized(async () => { let value: Buffer; try { value = await readFile(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; } return JSON.parse((await crypt(value, true)).toString('utf8')); }),
    save: value => serialized(async () => { const encrypted = await crypt(Buffer.from(JSON.stringify(value)), false); await mkdir(directory, { recursive: true }); await writeFile(file + '.tmp', encrypted); await rename(file + '.tmp', file); }),
    clear: () => serialized(async () => { await rm(file, { force: true }); }),
  };
}

import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
if (!process.argv.includes('--verify')) {
await mkdir('.desktop', { recursive: true });
await Promise.all([
  build({ entryPoints: ['desktop/main.ts'], outfile: '.desktop/main.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], legalComments: 'eof' }),
  build({ entryPoints: ['server/index.ts'], outfile: '.desktop/server.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node22', legalComments: 'linked' }),
]);
function crc32(bytes: Buffer) {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type: string, content: Buffer) {
  const name = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(content.length); crc.writeUInt32BE(crc32(Buffer.concat([name, content])));
  return Buffer.concat([length, name, content, crc]);
}
const size = 256, pixels = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const offset = y * (size * 4 + 1) + 1 + x * 4;
  const candle = (x >= 48 && x <= 83 && y >= 135 && y <= 195) || (x >= 110 && x <= 145 && y >= 94 && y <= 170) || (x >= 172 && x <= 207 && y >= 47 && y <= 132);
  const wick = (x >= 63 && x <= 68 && y >= 116 && y <= 212) || (x >= 125 && x <= 130 && y >= 75 && y <= 188) || (x >= 187 && x <= 192 && y >= 31 && y <= 150);
  pixels.set([...(candle || wick ? [91, 223, 189] : [17, 29, 46]), 255], offset);
}
const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
await writeFile('.desktop/icon.png', png);
const ico = Buffer.alloc(22); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
await writeFile('.desktop/icon.ico', Buffer.concat([ico, png]));
console.log('Desktop main/backend and icon built in .desktop/');

}

if (process.argv.includes('--package')) {
  process.env.ELECTRON_BUILDER_CACHE = (await import('node:path')).resolve('.desktop/cache/builder');
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']) delete process.env[key];
  const builder = await import('electron-builder');
  await builder.build({ targets: builder.Platform.WINDOWS.createTarget(['nsis', 'portable'], builder.Arch.x64), publish: 'never' });
}
if (process.argv.includes('--package') || process.argv.includes('--verify')) {
  const { readFile, readdir, stat } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const { createReadStream } = await import('node:fs');
  const { listPackage, extractFile } = await import('@electron/asar');
  const packageInfo = JSON.parse(await readFile('package.json', 'utf8'));
  const entries = listPackage('release/win-unpacked/resources/app.asar', { isPack: false }).map(p => p.replace(/\\/g, '/').replace(/^\/+/, ''));
  const allowed = new Set(['.desktop', '.desktop/main.cjs', '.desktop/icon.png', 'package.json']);
  if (entries.length !== allowed.size || entries.some(p => !allowed.has(p))) throw new Error('打包範圍不符，停止交付：app.asar 含非預期檔案');
  if (!extractFile('release/win-unpacked/resources/app.asar', '.desktop/main.cjs').equals(await readFile('.desktop/main.cjs'))) throw new Error('桌面啟動器不是本次編譯版本');
  if (!(await readFile('release/win-unpacked/resources/server/server.cjs')).equals(await readFile('.desktop/server.cjs'))) throw new Error('後端不是本次編譯版本');
  const serverFiles = await readdir('release/win-unpacked/resources/server');
  if (serverFiles.length !== 2 || !serverFiles.includes('server.cjs') || !serverFiles.includes('server.cjs.LEGAL.txt')) throw new Error('後端資源不符');
  async function checkWeb(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) { if (entry.name !== 'assets') throw new Error('網頁資源有非預期目錄'); await checkWeb(join(directory, entry.name)); }
      else if (!/^(index\.html|file-launcher\.js)$/.test(entry.name) && !/^[\w.-]+\.(js|css)$/.test(entry.name)) throw new Error('網頁資源有非預期檔案');
    }
  }
  await checkWeb('release/win-unpacked/resources/web');
  const artifacts = [];
  for (const kind of ['Setup', 'Portable']) {
    const name = 'TaiwanStockLab-' + kind + '-' + packageInfo.version + '-x64.exe', file = join('release', name);
    const size = (await stat(file)).size;
    if (size < 1_000_000) throw new Error('EXE 大小不合理：' + name);
    const hash = createHash('sha256');
    for await (const data of createReadStream(file)) hash.update(data);
    artifacts.push({ name, bytes: size, sha256: hash.digest('hex') });
  }
  await writeFile('release/SHA256SUMS.txt', artifacts.map(a => a.sha256 + '  ' + a.name).join('\n') + '\n');
  await writeFile('release/build-verification.json', JSON.stringify({ version: packageInfo.version, checkedAt: new Date().toISOString(), archiveEntries: entries, backendFiles: serverFiles, personalDataIncluded: false, exeLaunchedByBuild: false, artifacts }, null, 2) + '\n');
  await writeFile('release/使用說明.txt', '每日台股研究室 v' + packageInfo.version + '\n\n免安裝版：雙擊 Portable EXE，自動啟動本機 server 並開啟獨立桌面視窗，不需另外安裝 Node.js。\n安裝版：執行 Setup EXE，安裝後從桌面捷徑開啟。\n\n升級前先從右下角圖示選單完全結束舊版，再開啟新版 EXE。\n新增10萬元虛擬交易：到自動排程選模型、套用隔日出清範本，勾選納入虛擬交易並儲存啟用。\n每日首份結果鎖定，發布後新報價才模擬買進；預定下一交易日13:20嘗試出清。\n費用、滑價及逐股模擬限制請見虛擬交易頁，不代表真實成交；服務須持續開啟。\n只有 ChatGPT 登入與來源連結會開啟外部瀏覽器；授權完成後回到桌面視窗。\n每個人登入自己的 ChatGPT 帳號，首次需授權；不包含開發者的帳號或資料。\n個人資料保存在 %APPDATA%\\TaiwanStockLab\\data；日誌位於上層 desktop.log。\n關閉視窗後仍在右下角背景執行；從右下角圖示選單「完全結束」才停止服務與排程。\n安裝版可勾選登入 Windows 時自動啟動，免安裝版不提供此設定。電腦關機或睡眠時不執行。\n預設接埠 3100，占用改選 3102～3130；不會停止其他 server。\n\n此版未附數位簽章，尚無 GitHub 自動更新，也未內附官方 Codex CLI；用量顯示需本機另有官方 CLI 登入。\n舊開發版資料不會自動搬移。資料不足可推薦零檔，沒有上漲或成交保證，不自動下單。\n');
  // Remove obsolete releases only after the new artifacts passed every check.
  const { unlink } = await import('node:fs/promises');
  const current = packageInfo.version.split('.').map(Number);
  for (const name of await readdir('release')) {
    const match = /^TaiwanStockLab-(?:Setup|Portable)-(\d+\.\d+\.\d+)-x64\.exe(?:\.blockmap)?$/.exec(name);
    if (!match) continue;
    const previous = match[1].split('.').map(Number);
    const first = previous.findIndex((v,i) => v !== current[i]);
    if (first >= 0 && previous[first] < current[first]) {
      try { await unlink(join('release',name)); }
      catch (error) { if (['EBUSY','EPERM','EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) console.warn('舊版正在使用或受保護，請完全結束後清理：'+name); else throw error; }
    }
  }
  console.log(JSON.stringify({ verified: true, version: packageInfo.version, personalDataIncluded: false, exeLaunched: false, artifacts }));
}

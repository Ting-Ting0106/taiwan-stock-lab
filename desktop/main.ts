import { app, BrowserWindow, dialog, Menu, nativeImage, shell, Tray, utilityProcess, type UtilityProcess } from 'electron';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { backendEnvironment, desktopPaths, desktopPorts, findFreePort, ownedHealth, navigationTarget, readHealth, waitForServer } from './runtime';

app.setName('TaiwanStockLab');
const userData = join(app.getPath('appData'), 'TaiwanStockLab');
app.setPath('userData', userData);
mkdirSync(userData, { recursive: true });
let quitting = false, backend: UtilityProcess | undefined, tray: Tray | undefined, base = '', ready = false;
let mainWindow: BrowserWindow | undefined;
let failures = 0, lastPort: number | undefined;
const logFile = join(userData, 'desktop.log'), instanceId = randomBytes(24).toString('hex');
const log = (message: string) => { try { appendFileSync(logFile, new Date().toISOString() + ' ' + message + '\n'); } catch {} };
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, args) => { if (!args.includes('--background')) openInterface(); });
  app.on('window-all-closed', () => {});
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void requestQuit(); } });
  void app.whenReady().then(async () => {
    app.setAppUserModelId('tw.taiwanstocklab.desktop');
    const paths = desktopPaths(app.getAppPath(), process.resourcesPath, userData, app.isPackaged);
    mkdirSync(paths.data, { recursive: true });
    tray = new Tray(nativeImage.createFromPath(paths.icon).resize({ width: 24, height: 24 }));
    tray.setToolTip('每日台股研究室：正在啟動');
    tray.on('double-click', openInterface);
    refreshMenu();
    await launchBackend();
    if (!process.argv.includes('--background')) openInterface();
  }).catch(error => {
    log('startup-failed ' + (error instanceof Error ? error.message : 'unknown'));
    dialog.showErrorBox('每日台股研究室啟動失敗', error instanceof Error ? error.message : '無法啟動本機服務');
    void stopAndQuit();
  });
}
function openInterface() {
  if (!ready || !base) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show(); mainWindow.focus(); return;
  }
  const paths = desktopPaths(app.getAppPath(), process.resourcesPath, userData, app.isPackaged);
  const window = new BrowserWindow({ title: '每日台股研究室', width: 1440, height: 960, minWidth: 860, minHeight: 600, show: false, backgroundColor: '#0b1220', icon: paths.icon, autoHideMenuBar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: !app.isPackaged } });
  mainWindow = window; window.setMenu(null);
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  const external = (url: string) => { void shell.openExternal(url).catch(() => dialog.showErrorBox('無法開啟外部連結', '請確認預設瀏覽器設定後重試。')); };
  const guard = (event: { preventDefault(): void }, url: string) => {
    const target = navigationTarget(url, base);
    if (target !== 'app') { event.preventDefault(); if (target === 'login' || target === 'external') external(url); }
  };
  window.webContents.on('will-navigate', guard);
  window.webContents.on('will-redirect', guard);
  window.webContents.on('page-title-updated', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(({ url }) => { const target = navigationTarget(url, base); if (target === 'external' || target === 'login') external(url); return { action: 'deny' }; });
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  window.on('closed', () => { if (mainWindow === window) mainWindow = undefined; });
  window.once('ready-to-show', () => { window.show(); window.focus(); });
  void window.loadURL(base + '/').catch(() => { window.show(); dialog.showErrorBox('介面載入失敗', '本機服務正在啟動或重新連線，請從右下角圖示重新開啟。'); });
}
function refreshMenu() {
  const portable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: '開啟每日台股研究室', enabled: ready, click: openInterface },
    { label: ready ? base : '本機服務啟動中…', enabled: false },
    { type: 'separator' },
    { label: '登入 Windows 時自動啟動（安裝版）', type: 'checkbox', enabled: app.isPackaged && !portable, checked: app.isPackaged && !portable && app.getLoginItemSettings().openAtLogin, click: item => {
      app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath, args: ['--background'] });
    } },
    { label: '開啟資料與日誌資料夾', click: () => { void shell.openPath(userData); } },
    { type: 'separator' },
    { label: '完全結束（停止排程）', click: () => { void requestQuit(); } },
  ]));
}
async function launchBackend() {
  const paths = desktopPaths(app.getAppPath(), process.resourcesPath, userData, app.isPackaged);
  const port = await findFreePort(desktopPorts(lastPort));
  lastPort = port; base = 'http://127.0.0.1:' + port;
  const child = utilityProcess.fork(paths.server, [], { cwd: userData, env: backendEnvironment(process.env, port, paths.data, paths.web, instanceId), stdio: 'pipe', serviceName: 'TaiwanStockLab Backend' });
  backend = child;
  child.on('message', message => {
    if (backend === child && message && message.type === 'auth-completed') {
      openInterface();
      if (!message.ok) dialog.showErrorBox('登入未完成', '請回到帳號欄重新登入；詳細原因顯示在官方登入流程的回傳頁面。');
    }
  });
  let exited = false, wasReady = false;
  child.stdout?.resume(); child.stderr?.resume();
  child.on('exit', code => {
    exited = true; log('backend-exit code=' + code);
    if (!quitting && backend === child && wasReady) {
      ready = false; refreshMenu(); tray?.setToolTip('每日台股研究室：服務重新啟動中');
      if (++failures > 3) { dialog.showErrorBox('本機服務反覆停止', '請查看 desktop.log，完全結束後再試。'); void stopAndQuit(); return; }
      setTimeout(() => { if (!quitting) void launchBackend().catch(error => { log('restart-failed'); dialog.showErrorBox('重新啟動失敗', String(error.message)); void stopAndQuit(); }); }, 1500);
    }
  });
  await waitForServer(base, instanceId, app.getVersion(), () => !exited && !quitting);
  ready = true; wasReady = true;
  log('ready version=' + app.getVersion() + ' port=' + port);
  tray?.setToolTip('每日台股研究室 v' + app.getVersion() + '（背景執行）');
  refreshMenu();
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.getURL().startsWith(base + '/')) void mainWindow.loadURL(base + '/').catch(() => {});
}
let quitPrompt = false;
async function requestQuit() {
  if (quitting || quitPrompt) return;
  quitPrompt = true;
  try {
    let running = false;
    try { const health = await readHealth(base); running = ownedHealth(health, instanceId, app.getVersion()) && health.running; } catch {}
    if (running) {
      const answer = await dialog.showMessageBox({ type: 'question', title: '有背景工作執行中', message: '現在結束可能中斷查詢；排程也會停止。確定完全結束？', buttons: ['取消', '完全結束'], defaultId: 0, cancelId: 0 });
      if (answer.response === 0) return;
    }
    await stopAndQuit();
  } finally { quitPrompt = false; }
}
async function stopAndQuit() {
  if (quitting) return;
  quitting = true; ready = false;
  const child = backend;
  if (child?.pid) await new Promise<void>(resolve => {
    const timer = setTimeout(() => { child.kill(); resolve(); }, 8000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.postMessage({ type: 'shutdown' });
  });
  mainWindow?.destroy(); tray?.destroy(); log('quit'); app.exit(0);
}

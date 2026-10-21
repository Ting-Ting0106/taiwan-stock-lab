import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { backendEnvironment, desktopPaths, desktopPorts, findFreePort, ownedHealth, navigationTarget, waitForServer } from './runtime.ts';

test('桌面資料與執行檔分離，不把登入放在安裝或 ASAR 目錄', () => {
  assert.equal(desktopPorts(3108)[0], 3108); assert.ok(!desktopPorts().includes(3101)); assert.equal(new Set(desktopPorts(3108)).size, desktopPorts(3108).length);
  const paths = desktopPaths('C:/app/app.asar', 'C:/app/resources', 'C:/user/profile', true);
  assert.equal(paths.data, join('C:/user/profile', 'data'));
  assert.equal(paths.server, join('C:/app/resources', 'server', 'server.cjs'));
  assert.equal(paths.web, join('C:/app/resources', 'web'));
  const parent = { NODE_OPTIONS: '--inspect', OPENAI_API_KEY: 'synthetic-key', ELECTRON_RUN_AS_NODE: '1', PATH: 'system-path' };
  const env = backendEnvironment(parent, 3120, paths.data, paths.web, 'test-id');
  assert.equal(env.PORT, '3120'); assert.equal(env.DATA_DIR, paths.data); assert.equal(env.STATIC_DIR, paths.web);
  assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(parent.OPENAI_API_KEY, 'synthetic-key');
});
test('接埠已被占用會另選，不把其他服務當成自己的後端', async () => {
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ application: 'taiwan-stock-lab', version: '0.10.4', instanceId: 'another-app', running: false })); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    assert.notEqual(await findFreePort([port, 0]), port);
    assert.equal(ownedHealth({ application: 'taiwan-stock-lab', instanceId: 'wrong', version: '0.10.4', running: false }, 'mine', '0.10.4'), false);
    await assert.rejects(waitForServer('http://127.0.0.1:' + port, 'mine', '0.10.4', () => true, 250), /未能啟動/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('獨立打包後端不依賴專案 node_modules，能提供網頁與健康檢查', { skip: !existsSync(resolve('.desktop/server.cjs')) }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stock-bundle-test-')), port = await findFreePort([0]);
  const serverFile = join(directory, 'server.cjs');
  await copyFile(resolve('.desktop/server.cjs'), serverFile);
  const child = spawn(process.execPath, [serverFile], { cwd: directory, env: backendEnvironment(process.env, port, join(directory, 'data'), resolve('dist'), 'bundle-test'), windowsHide: true, stdio: 'ignore' });
  try {
    await waitForServer('http://127.0.0.1:' + port, 'bundle-test', '0.10.4', () => child.exitCode === null, 15000);
    const state = await (await fetch('http://127.0.0.1:' + port + '/api/state')).json();
    assert.equal(state.auth.connected, false); assert.equal(state.version, '0.10.4'); assert.equal(state.trades.length, 0);
    assert.equal(state.instance.dataDirectory, join(directory, 'data'));
    assert.equal(state.paper.cash,100000);assert.equal(state.paper.positions.length,0);
    assert.equal((await fetch('http://127.0.0.1:' + port + '/')).status, 200);
    assert.equal((await fetch('http://127.0.0.1:' + port + '/api/health')).headers.get('cache-control'), 'no-store');
  } finally {
    if (child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
    assert.equal(resolve(directory, '..'), resolve(tmpdir())); assert.ok(directory.includes('stock-bundle-test-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('桌面導覽限制', () => {
 const base='http://127.0.0.1:3100';
 assert.equal(navigationTarget(base+'/#history',base),'app');
 assert.equal(navigationTarget(base+'/auth/desktop-launch?ticket='+'a'.repeat(43),base),'login');
 for(const path of ['/auth/callback?code=x','/auth/desktop-launch?ticket=bad','/auth/desktop-launch?ticket='+'a'.repeat(43)+'&extra=x']) assert.equal(navigationTarget(base+path,base),'blocked');
 assert.equal(navigationTarget('https://www.twse.com.tw/',base),'external');
 for(const url of ['file:///C:/secret','javascript:alert(1)','https://user:pass@example.com','not-a-url']) assert.equal(navigationTarget(url,base),'blocked');
});

test('桌面視窗生命週期：啟動不開瀏覽器、關閉隱藏、重複開啟還原', async () => {
 const { EventEmitter }=await import('node:events'),{runInNewContext}=await import('node:vm'),{createRequire}=await import('node:module'),{readFile}=await import('node:fs/promises');
 const directory=await mkdtemp(join(tmpdir(),'stock-window-test-'));
 const windows:any[]=[],external:string[]=[],errors:string[]=[];let menu:any[]=[],worker:any,environment:any,exited=false;
 const app:any=Object.assign(new EventEmitter(),{setName(){},getPath(){return directory;},setPath(){},requestSingleInstanceLock(){return true;},whenReady:async()=>{},setAppUserModelId(){},getAppPath(){return directory;},isPackaged:true,getVersion(){return '0.10.4';},getLoginItemSettings(){return {openAtLogin:false};},exit(){exited=true;}});
 class Window extends EventEmitter {
  options:any;webContents:any;url='';hidden=false;shows=0;destroyed=false;
  constructor(options:any){super();this.options=options;windows.push(this);this.webContents=Object.assign(new EventEmitter(),{session:{setPermissionRequestHandler(){},setPermissionCheckHandler(){}},setWindowOpenHandler(this:any,handler:any){this.popup=handler;},getURL:()=>this.url});}
  setMenu(){} async loadURL(url:string){this.url=url;this.emit('ready-to-show');}show(){this.hidden=false;this.shows++;}focus(){}hide(){this.hidden=true;}isDestroyed(){return this.destroyed;}isMinimized(){return false;}destroy(){this.destroyed=true;this.emit('closed');}
 }
 class Tray extends EventEmitter {setToolTip(){}setContextMenu(value:any){menu=value;}destroy(){}}
 const electron={app,BrowserWindow:Window,Tray,Menu:{buildFromTemplate:(value:any)=>value},nativeImage:{createFromPath:()=>({resize:()=>({})})},shell:{openExternal:async(url:string)=>{external.push(url);},openPath:async()=>''},dialog:{showErrorBox:(_title:string,message:string)=>errors.push(message)},utilityProcess:{fork:(_path:string,_args:any,options:any)=>{environment=options.env;worker=Object.assign(new EventEmitter(),{pid:123,postMessage(){worker.emit('exit',0);},kill(){worker.emit('exit',0);}});return worker;}}};
 const realRequire=createRequire(import.meta.url);
 try{
  runInNewContext(await readFile(resolve('.desktop/main.cjs'),'utf8'),{require:(name:string)=>name==='electron'?electron:realRequire(name),module:{exports:{}},exports:{},process:{env:{},argv:['synthetic.exe'],resourcesPath:directory,execPath:'synthetic.exe'},Buffer,URL,AbortSignal,setTimeout,clearTimeout,console,fetch:async()=>Response.json({application:'taiwan-stock-lab',version:'0.10.4',instanceId:environment.DESKTOP_INSTANCE_ID,running:false})});
  for(let n=0;n<100&&!windows.length;n++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(windows.length,1);assert.deepEqual(external,[]);
  const window=windows[0];assert.equal(window.options.webPreferences.nodeIntegration,false);assert.equal(window.options.webPreferences.contextIsolation,true);assert.equal(window.options.webPreferences.sandbox,true);
  let prevented=false;window.emit('close',{preventDefault(){prevented=true;}});assert.equal(prevented,true);assert.equal(window.hidden,true);
  app.emit('second-instance',{},['synthetic.exe']);assert.equal(windows.length,1);assert.equal(window.hidden,false);
  const shows=window.shows;worker.emit('message',{type:'auth-completed',ok:true});assert.ok(window.shows>shows);
  const target=new URL(window.url);target.pathname='/auth/desktop-launch';target.search='?ticket='+'a'.repeat(43);
  window.webContents.emit('will-navigate',{preventDefault(){}},target.href);assert.equal(external[0],target.href);
  window.webContents.emit('will-navigate',{preventDefault(){}},'file:///C:/secret');assert.equal(external.length,1);
  const result=window.webContents.popup({url:'https://www.twse.com.tw/'});assert.equal(result.action,'deny');assert.equal(external.length,2);
  menu.find(item=>item.label?.startsWith('完全結束')).click();for(let n=0;n<100&&!exited;n++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(exited,true);assert.equal(window.destroyed,true);assert.deepEqual(errors,[]);
 }finally{assert.equal(resolve(directory,'..'),resolve(tmpdir()));await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});

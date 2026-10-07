import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';

const { chromium } = process.env.PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href)
  : await import('playwright');
const baseUrl = new URL(process.env.BASE_URL || 'http://localhost:8000/');
baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, '')}/`;
baseUrl.search = '';
baseUrl.hash = '';
const base = baseUrl.href;
const output = new URL('../test-results/',import.meta.url);
await mkdir(output,{recursive:true});
const browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_BROWSER_PATH ? {executablePath:process.env.PLAYWRIGHT_BROWSER_PATH} : {})});
let passed = 0;
const check = message => { passed++; console.log(`PASS ${message}`); };
const errors = [];
const context = await browser.newContext({viewport:{width:1440,height:1100},acceptDownloads:true});
await context.addInitScript(() => {
  class Characteristic extends EventTarget {
    startNotifications() { return Promise.resolve(this); }
    stopNotifications() { return Promise.resolve(this); }
    emit(bpm, flags=0) {
      this.value = new DataView(Uint8Array.from(flags & 1 ? [flags,bpm&255,bpm>>8] : [flags,bpm]).buffer);
      this.dispatchEvent(new Event('characteristicvaluechanged'));
    }
  }
  class Device extends EventTarget {
    constructor(index) {
      super(); this.id = `mock-${index}`; this.name=`測試手錶 ${index+1}`; this.measurement = new Characteristic();
      this.fail = false;
      this.gatt = { connected:false,
        connect:async()=>{if(this.fail) throw new Error('Out of range');this.gatt.connected=true;return this.gatt;},
        disconnect:()=>{if(this.gatt.connected){this.gatt.connected=false;this.dispatchEvent(new Event('gattserverdisconnected'));}},
        getPrimaryService:async()=>({getCharacteristic:async()=>this.measurement}) };
    }
  }
  const bluetooth = new EventTarget();
  bluetooth.getAvailability = async()=>true;
  const devices = Array.from({length:4},(_,i)=>new Device(i));
  window.__ble = {devices,next:0,cancel:false};
  bluetooth.requestDevice = async()=>{
    if(window.__ble.cancel) throw Object.assign(new Error('cancel'),{name:'NotFoundError'});
    return devices[window.__ble.next];
  };
  Object.defineProperty(navigator,'bluetooth',{value:bluetooth,configurable:true});
});
await context.route('**/*',route=>new URL(route.request().url()).origin === baseUrl.origin ? route.continue() : route.abort());
const page = await context.newPage();
page.on('pageerror',error=>errors.push(error.message));
await page.clock.install();
const ready = async target => {
  await target.goto(base);
  await target.waitForSelector('body[data-ready="true"]');
};
const sessions = async () => page.evaluate(async()=>{
  const {HeartRateStore}=await import('./assets/storage.js'); const store=new HeartRateStore();
  try{return await store.listSessions();}finally{store.close();}
});
const waitSaved = async () => {
  await page.waitForFunction(()=>![...document.querySelectorAll('.record-status')].some(el=>el.textContent.includes('寫入中')));
};
const tick = async ms => {await page.clock.runFor(ms);await waitSaved();};
try {
  await ready(page);
  assert.equal(await page.locator('.device-card').count(),4);
  await page.waitForFunction(()=>document.getElementById('placeholder-0').hidden);
  assert.deepEqual(await page.locator('.machine-picture canvas').evaluateAll(nodes=>nodes.map(c=>[c.width,c.height])),[[488,551],[488,551],[488,551],[488,551]]);
  assert.equal(await page.locator('#historyCount').textContent(),'0');
  assert.equal(await page.locator('#chartError').isVisible(),false);
  check('Initial offline assets, four fixed image quadrants and Chart.js render');
  const storageResults=await page.evaluate(async()=>{const {runStorageTests}=await import('./tests/storage.browser.mjs');return await runStorageTests();});
  console.log('IndexedDB:',JSON.stringify(storageResults));
  check('Real IndexedDB transactions, rollback, recovery, immutable sessions and deletion');
  if (process.env.RUN_ENDURANCE === '1') {
    console.log('Running two-hour equivalent persisted four-stream endurance test…');
    const endurance=await page.evaluate(async()=>{const {runEnduranceTest}=await import('./tests/endurance.browser.mjs');return await runEnduranceTest();});
    console.log('Endurance:',JSON.stringify(endurance));
    check('Two-hour equivalent run persists 28,800 samples with bounded chart buffers');
  }

  await page.locator('#demoModeBtn').click();
  await page.waitForFunction(()=>document.getElementById('liveCount').textContent==='4');
  await page.locator('#maxhr-0').fill('190');
  await page.locator('#maxhr-0').dispatchEvent('change');
  for(let id=0;id<4;id++) {await page.locator(`#record-${id}`).click();await page.waitForFunction(id=>document.getElementById(`recordLabel-${id}`).textContent==='停止紀錄',id);}
  assert.equal(await page.locator('#bleModeBtn').isDisabled(),true);
  assert.equal(await page.locator('#maxhr-0').isDisabled(),true);
  await tick(4000);
  const during=await sessions();
  assert.equal(during.length,4);
  assert.ok(during.every(s=>s.count>=4 && s.source==='demo' && s.status==='recording'));
  assert.equal(during.find(s=>s.slotId===0).maxHR,190);
  check('Four independent demo recordings, saved samples and frozen zone settings');
  await page.locator('#clearChartBtn').click();
  assert.equal((await sessions()).reduce((n,s)=>n+s.count,0),during.reduce((n,s)=>n+s.count,0));
  for(let id=0;id<4;id++) {await page.locator(`#record-${id}`).click();await page.waitForFunction(id=>document.getElementById(`recordLabel-${id}`).textContent==='開始紀錄',id);}
  assert.ok((await sessions()).every(s=>s.status==='completed'));
  assert.equal(await page.locator('#liveCount').textContent(),'4');
  check('Stopping preserves live monitoring; clearing graph preserves recorded samples');
  await page.locator('[data-session]').first().click();
  await page.waitForSelector('#detailDialog[open]');
  const downloadPromise=page.waitForEvent('download');
  await page.locator('#detailExportBtn').click();
  const download=await downloadPromise;
  assert.ok(download.suggestedFilename().includes('模擬'));
  await download.saveAs(fileURLToPath(new URL('demo.csv',output)));
  assert.equal(await page.locator('#historyChartError').isVisible(),false);
  await page.locator('#detailDialog .close-dialog').click();
  check('History detail chart and CSV download with demo labeling');
  await page.locator('#record-0').click();
  await page.waitForFunction(()=>document.getElementById('recordLabel-0').textContent==='停止紀錄');
  await tick(2000);
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]');
  const reloaded=await sessions();
  assert.equal(reloaded.length,5);
  assert.equal(reloaded.filter(s=>s.status==='interrupted').length,1);
  assert.equal(reloaded.filter(s=>s.status==='recording').length,0);
  assert.equal(await page.locator('#maxhr-0').inputValue(),'190');
  check('Reload retains records and settings, interrupts unfinished recording without resuming');

  for(let id=0;id<4;id++) {
    await page.evaluate(id=>{window.__ble.next=id;},id);
    await page.locator(`#connect-${id}`).click();
    await page.waitForFunction(id=>document.getElementById(`badge-${id}`).textContent==='等待數據',id);
    await page.evaluate(id=>window.__ble.devices[id].measurement.emit(80+id*20),id);
  }
  assert.deepEqual(await page.locator('.bpm').allTextContents(),['80','100','120','140']);
  check('Four mock BLE watches connect and deliver isolated live heart rates');
  await page.locator('#record-0').click();
  await page.waitForFunction(()=>document.getElementById('recordLabel-0').textContent==='停止紀錄');
  await page.evaluate(()=>window.__ble.devices[0].measurement.emit(111));
  await waitSaved();
  await tick(11000);
  assert.equal(await page.locator('#badge-0').textContent(),'資料逾時');
  assert.equal(await page.locator('#bpm-0').textContent(),'--');
  assert.equal(await page.locator('#heart-0').evaluate(el=>el.classList.contains('beating')),false);
  await page.evaluate(()=>window.__ble.devices[0].measurement.emit(132,4));
  assert.equal(await page.locator('#badge-0').textContent(),'未接觸感測器');
  await page.evaluate(()=>window.__ble.devices[0].measurement.emit(121));
  await waitSaved();
  check('Stale/contact-loss clears BPM and animation; valid reading restores it');
  await page.evaluate(()=>window.__ble.devices[0].gatt.disconnect());
  assert.equal(await page.locator('#badge-0').textContent(),'重新連線中');
  await tick(1200);
  await page.evaluate(()=>window.__ble.devices[0].measurement.emit(125));
  await waitSaved();
  await page.locator('#connect-0').click();
  await page.waitForFunction(()=>document.getElementById('recordLabel-0').textContent==='開始紀錄');
  const bleSession=(await sessions()).find(s=>s.source==='ble');
  assert.equal(bleSession.status,'completed');
  assert.equal(bleSession.count,3);
  const events=await page.evaluate(async id=>{const{HeartRateStore}=await import('./assets/storage.js');const s=new HeartRateStore();try{return await s.getEvents(id);}finally{s.close();}},bleSession.id);
  assert.ok(events.some(e=>e.bpm===null));
  check('Reconnect preserves recording, manual disconnect finalizes it, gaps stored without fake BPM');
  await page.evaluate(()=>{window.__ble.next=1;});
  await page.locator('#connect-0').click();
  await page.waitForFunction(()=>document.getElementById('badge-0').textContent==='連線失敗');
  assert.ok((await page.locator('#message-0').textContent()).includes('其他機台'));
  await page.evaluate(()=>window.__ble.devices[1].measurement.emit(135));
  assert.equal(await page.locator('#bpm-1').textContent(),'135');
  check('Duplicate watch rejected without affecting original slot');

  // Capture genuine rendered screens at desktop and narrow-phone sizes.
  await page.locator('#demoModeBtn').click();
  await tick(60000);
  await page.screenshot({path:fileURLToPath(new URL('desktop.png',output)),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:fileURLToPath(new URL('mobile.png',output)),fullPage:true});
  await page.screenshot({path:fileURLToPath(new URL('mobile-viewport.png',output))});
  check('Desktop and 390px mobile layouts have no horizontal overflow');

  const second = await context.newPage();
  await ready(second);
  assert.equal(await second.locator('#demoModeBtn').isDisabled(),true);
  assert.ok((await second.locator('#systemAlerts').textContent()).includes('唯讀'));
  await second.close();
  check('Second tab cannot recover or overwrite another tab’s active monitoring');

  // Inject an actual storage append error through the module interface.
  await page.evaluate(async()=>{const{HeartRateStore}=await import('./assets/storage.js');window.__append=HeartRateStore.prototype.appendSample;HeartRateStore.prototype.appendSample=async()=>{throw new Error('Injected quota failure');};});
  await page.locator('#record-0').click();
  await page.waitForFunction(()=>document.getElementById('recordLabel-0').textContent==='停止紀錄');
  await tick(1100);
  await page.waitForFunction(()=>document.getElementById('recordStatus-0').textContent.includes('儲存失敗'));
  assert.equal(await page.locator('#liveCount').textContent(),'4');
  await page.evaluate(async()=>{const{HeartRateStore}=await import('./assets/storage.js');HeartRateStore.prototype.appendSample=window.__append;});
  check('Storage failure stops recording but leaves live display working');
  await page.locator('[data-session]').first().click();
  await page.waitForSelector('#detailDialog[open]');
  page.once('dialog',dialog=>dialog.accept());
  const beforeDelete=(await sessions()).length;
  await page.locator('#detailDeleteBtn').click();
  await page.waitForFunction(()=>!document.getElementById('detailDialog').open);
  assert.equal((await sessions()).length,beforeDelete-1);
  check('Historical record deletion removes selected session');

  assert.deepEqual(errors,[]);
  await context.close();
  const fallbackContext=await browser.newContext();
  const fallback=await fallbackContext.newPage();
  await fallbackContext.route('**/chart.umd.min.js',route=>route.abort());
  await fallbackContext.route('**/exercise-machine.jpg',route=>route.abort());
  await fallback.addInitScript(()=>Object.defineProperty(navigator,'bluetooth',{value:undefined,configurable:true}));
  await ready(fallback);
  assert.equal(await fallback.locator('#chartError').isVisible(),true);
  assert.equal(await fallback.locator('#placeholder-0').isVisible(),true);
  await fallback.locator('#demoModeBtn').click();
  await fallback.waitForFunction(()=>document.getElementById('liveCount').textContent==='4');
  assert.equal(await fallback.locator('#record-0').isEnabled(),true);
  await fallbackContext.close();
  check('Missing chart/image/Bluetooth fails gracefully; demo and recording remain available');
  console.log(`\n${passed} browser scenarios passed; no uncaught application errors.`);
} finally { await browser.close(); }

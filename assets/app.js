import { SLOT_CONFIGS, BoundedSeries, getZone } from './core.js';
import { BleSlot } from './ble.js';
import { HeartRateStore, sessionCsv } from './storage.js';

const $ = id => document.getElementById(id);
const escapeHtml = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const dateText = value => new Date(value).toLocaleString('zh-TW', { hour12:false });
const elapsedText = ms => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 3600)).padStart(2,'0')}:${String(Math.floor(seconds / 60) % 60).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`;
};
const STATUS = { idle:'未連線', selecting:'選擇裝置', connecting:'連線中', waiting:'等待數據', live:'即時接收', 'no-contact':'未接觸感測器', stale:'資料逾時', reconnecting:'重新連線中', disconnected:'已斷線', error:'連線失敗' };
const connectedStates = new Set(['waiting','live','no-contact','stale']);
const busyStates = new Set(['selecting','connecting','reconnecting']);
const store = new HeartRateStore();
const registry = new Map();
const alerts = new Map();
const slots = SLOT_CONFIGS.map(config => ({
  ...config, series:new BoundedSeries(), snapshot:{status:'idle',currentBpm:null,deviceName:''}, controller:null,
  maxHR:null, record:null, stats:null, accepting:false, starting:false, stopping:false, writeFailed:false,
  queue:Promise.resolve(), pending:0, recordError:'', lastRecordGap:false, terminalDuringStart:null,
}));
let mode = 'ble';
let storeReady = false;
let writer = false;
let initialized = false;
let bluetoothReady = false;
let chooserBusy = false;
let liveChart = null;
let historyChart = null;
let selectedSession = null;
let historyRevision = 0;
let detailRevision = 0;
let demoSeconds = 0;
let toastTimeout;
let leaving = false;

function setAlert(key, message, isError = false) {
  if (message) alerts.set(key, {message,isError}); else alerts.delete(key);
  $('systemAlerts').innerHTML = [...alerts.values()].map(item => `<div class="notice ${item.isError ? 'error' : ''}">${escapeHtml(item.message)}</div>`).join('');
}
function toast(message, error = false) {
  clearTimeout(toastTimeout);
  $('toast').textContent = message;
  $('toast').className = `toast${error ? ' error' : ''}`;
  $('toast').hidden = false;
  toastTimeout = setTimeout(() => { $('toast').hidden = true; }, 5000);
}
function renderCards() {
  $('devicesContainer').innerHTML = slots.map(st => `
    <article class="device-card" id="card-${st.id}" style="--slot:${st.color}" aria-labelledby="title-${st.id}">
      <div class="card-heading"><div class="machine-title"><span class="slot-dot"></span><div><h3 id="title-${st.id}">${st.name}</h3><span class="slot-number">機台 ${String(st.id + 1).padStart(2,'0')}</span></div></div><span id="badge-${st.id}" class="status-badge" role="status">未連線</span></div>
      <div class="machine-picture"><div id="placeholder-${st.id}" class="picture-placeholder">${st.name}<br>正在載入機台圖片</div><canvas id="machine-${st.id}" role="img" aria-label="${st.name}示意圖片"></canvas><span id="device-${st.id}" class="device-overlay">未綁定裝置</span></div>
      <div class="heart-panel"><svg id="heart-${st.id}" class="heart-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21S1 14 1 7a6 6 0 0 1 11-3A6 6 0 0 1 23 7c0 7-11 14-11 14"/></svg><div class="bpm-row"><span id="bpm-${st.id}" class="bpm">--</span><span class="bpm-unit">BPM</span></div><span id="zone-${st.id}" class="zone-tag">無數據</span></div>
      <div class="stats"><div class="stat"><div class="stat-label">最低</div><div id="min-${st.id}" class="stat-value">--</div></div><div class="stat"><div class="stat-label">平均</div><div id="avg-${st.id}" class="stat-value">--</div></div><div class="stat"><div class="stat-label">最高</div><div id="max-${st.id}" class="stat-value">--</div></div></div>
      <p class="stats-caption">本次紀錄統計 · BPM</p>
      <div class="settings-row"><label for="maxhr-${st.id}">參考最大心率<br><span>選填，用於顯示區間</span></label><input id="maxhr-${st.id}" type="number" min="1" max="65535" step="1" placeholder="未設定" inputmode="numeric" aria-label="${st.name}參考最大心率"></div>
      <div class="card-actions"><button id="connect-${st.id}" class="button primary">搜尋並連線</button><button id="record-${st.id}" class="button record" disabled><span class="record-dot"></span><span id="recordLabel-${st.id}">開始紀錄</span></button></div>
      <div id="message-${st.id}" class="card-message" role="status" hidden></div><div id="recordStatus-${st.id}" class="record-status">連線後可開始紀錄</div>
    </article>`).join('');
  for (const st of slots) {
    $(`connect-${st.id}`).addEventListener('click', () => {
      if (st.starting || st.stopping || !writer || mode !== 'ble') return;
      const status = st.controller.snapshot.status;
      if (connectedStates.has(status) || busyStates.has(status)) st.controller.disconnect();
      else {
        st.series.gap(Date.now());
        // connect() requests permission before any await; preserve the click gesture.
        void st.controller.connect();
      }
    });
    $(`record-${st.id}`).addEventListener('click', () => {
      if (st.record) void stopRecording(st); else void startRecording(st);
    });
    $(`maxhr-${st.id}`).addEventListener('change', () => void saveMaxHR(st));
  }
  $('chartLegend').innerHTML = slots.map(st => `<span class="legend-item"><span class="legend-line" style="--slot:${st.color}"></span>${st.name}</span>`).join('');
}

function renderSlot(st) {
  const snap = st.snapshot;
  const live = snap.status === 'live' && snap.currentBpm > 0;
  const bpm = live ? snap.currentBpm : null;
  const badge = $(`badge-${st.id}`);
  badge.textContent = mode === 'demo' ? '模擬數據' : STATUS[snap.status] ?? snap.status;
  badge.className = `status-badge ${live ? 'live' : snap.status === 'error' ? 'error' : ['stale','no-contact',...busyStates].includes(snap.status) ? 'waiting' : ''}`;
  $(`bpm-${st.id}`).textContent = bpm ?? '--';
  $(`bpm-${st.id}`).className = `bpm${live ? ' has-value' : ''}`;
  const heart = $(`heart-${st.id}`);
  heart.classList.toggle('beating', live);
  heart.style.setProperty('--beat-duration', `${live ? Math.max(.15,60 / bpm) : 1}s`);
  const zone = live ? getZone(bpm, st.record ? st.record.maxHR : st.maxHR) : null;
  $(`zone-${st.id}`).textContent = zone ? `${zone.name} · ${zone.percent}%` : live ? '即時心率' : snap.status === 'no-contact' ? '請確認配戴狀態' : snap.status === 'stale' ? '超過 10 秒無有效數據' : '無數據';
  $(`zone-${st.id}`).style.color = zone?.color ?? '';
  $(`device-${st.id}`).textContent = snap.deviceName || '未綁定裝置';
  for (const key of ['min','max']) $(`${key}-${st.id}`).textContent = st.stats?.[key] ?? '--';
  $(`avg-${st.id}`).textContent = st.stats?.count ? Math.round(st.stats.sum / st.stats.count) : '--';
  const connect = $(`connect-${st.id}`);
  connect.textContent = mode === 'demo' ? '模擬心率運作中' : connectedStates.has(snap.status) ? '斷開連線' : busyStates.has(snap.status) ? '取消連線' : snap.status === 'error' ? '重新搜尋' : '搜尋並連線';
  connect.disabled = !initialized || !writer || mode === 'demo' || st.starting || st.stopping || (!connectedStates.has(snap.status) && !busyStates.has(snap.status) && (!bluetoothReady || chooserBusy));
  connect.classList.toggle('primary', !connectedStates.has(snap.status));
  $(`maxhr-${st.id}`).disabled = !initialized || !writer || !!st.record || st.starting || st.stopping;
  const recordButton = $(`record-${st.id}`);
  recordButton.disabled = !storeReady || !writer || st.starting || st.stopping || (!st.record && !connectedStates.has(snap.status));
  recordButton.classList.toggle('recording', !!st.record);
  $(`recordLabel-${st.id}`).textContent = st.starting ? '準備紀錄…' : st.stopping ? '正在儲存…' : st.record ? '停止紀錄' : '開始紀錄';
  const recordStatus = $(`recordStatus-${st.id}`);
  recordStatus.classList.toggle('active', !!st.record);
  recordStatus.textContent = st.record ? `● ${elapsedText(Date.now() - st.record.startedAt)} · 已存 ${st.stats?.count ?? 0} 筆${st.pending ? ' · 寫入中' : ''}` : st.writeFailed ? '紀錄已停止 · 儲存失敗' : st.stats ? `已保存 ${st.stats.count} 筆 · ${st.stats.status === 'interrupted' ? '中斷' : '已結束'}` : connectedStates.has(snap.status) ? '即時監看中 · 尚未開始紀錄' : '連線後可開始紀錄';
  const message = st.recordError || snap.error || '';
  $(`message-${st.id}`).textContent = message;
  $(`message-${st.id}`).hidden = !message;
}
function renderAll() {
  chooserBusy = slots.some(st => st.snapshot.status === 'selecting');
  for (const st of slots) renderSlot(st);
  const blocked = !initialized || !writer || slots.some(st => st.record || st.starting || st.stopping || st.pending);
  for (const nextMode of ['ble','demo']) {
    const button = $(`${nextMode}ModeBtn`);
    button.disabled = blocked;
    button.classList.toggle('selected', mode === nextMode);
    button.setAttribute('aria-pressed', String(mode === nextMode));
    button.title = blocked && initialized ? '請先停止所有機台的紀錄，再切換模式。' : '';
  }
  $('demoNotice').hidden = mode !== 'demo';
  $('liveCount').textContent = slots.filter(st => st.snapshot.status === 'live').length;
}

function onBluetoothState(st, snapshot) {
  if (mode !== 'ble' || leaving) return;
  if (snapshot.status !== 'live' && st.snapshot.status === 'live') {
    st.series.gap(Date.now());
    recordGap(st, STATUS[snapshot.status] || snapshot.status);
  }
  st.snapshot = snapshot;
  renderAll();
}
function acceptSample(st, sample) {
  st.series.push(sample.timestamp, sample.bpm);
  if (!st.record || !st.accepting) return;
  st.lastRecordGap = false;
  queueWrite(st, id => store.appendSample(id, {timestamp:sample.timestamp,bpm:sample.bpm}));
}
function recordGap(st, reason) {
  if (!st.record || !st.accepting || st.lastRecordGap) return;
  st.lastRecordGap = true;
  const timestamp = Date.now();
  queueWrite(st, id => store.appendGap(id, {timestamp,reason}));
}
function queueWrite(st, operation) {
  const session = st.record;
  if (!session || !st.accepting) return;
  // Bound the pending queue if storage becomes slower than notifications.
  if (st.pending >= 256) {
    st.accepting = false;
    st.recordError = '儲存速度不足，紀錄已停止；已寫入的數據仍會保留。';
    void stopRecording(st, 'interrupted', '儲存速度不足');
    return;
  }
  st.pending++;
  st.queue = st.queue.then(async () => {
    if (st.writeFailed) return;
    const saved = await operation(session.id);
    st.stats = saved;
    if (st.record?.id === session.id) st.record = saved;
  }).catch(error => recordingFailed(st, session, error)).finally(() => {
    st.pending--;
    renderAll();
  });
}
async function recordingFailed(st, session, error) {
  if (st.writeFailed) return;
  st.writeFailed = true;
  st.accepting = false;
  st.record = null;
  st.recordError = `紀錄已停止，未保存的資料不會顯示為已儲存。${error.message || ''}`;
  try {
    st.stats = await store.finishSession(session.id, {status:'interrupted', reason:'本機儲存失敗',endedAt:st.stats?.lastSampleAt ?? session.startedAt});
  } catch { /* The persisted active record will be recovered as interrupted next load. */ }
  toast('本機儲存失敗，即時監看仍可繼續。', true);
  await refreshHistory();
}
async function startRecording(st) {
  if (st.record || st.starting || st.stopping || !storeReady || !writer || !connectedStates.has(st.snapshot.status)) return;
  st.starting = true;
  st.recordError = '';
  st.terminalDuringStart = null;
  renderAll();
  try {
    await st.queue;
    const session = await store.createSession({slotId:st.id,machine:st.name,deviceName:st.snapshot.deviceName,source:mode,maxHR:st.maxHR,startedAt:Date.now()});
    st.record = st.stats = session;
    st.writeFailed = false;
    st.accepting = true;
    st.lastRecordGap = false;
    if (st.snapshot.status !== 'live') recordGap(st, STATUS[st.snapshot.status]);
    // A disconnect may occur while the session-creation transaction is pending.
    if (st.terminalDuringStart) await stopRecording(st, st.terminalDuringStart === 'manual' ? 'completed' : 'interrupted', st.terminalDuringStart);
    await refreshHistory();
  } catch (error) {
    st.recordError = `無法開始紀錄。${error.message}`;
    toast(st.recordError, true);
  } finally {
    st.starting = false;
    renderAll();
  }
}
async function stopRecording(st, status = 'completed', reason = '手動停止') {
  if (!st.record || st.stopping) return;
  const session = st.record;
  const endedAt = Date.now();
  st.accepting = false;
  st.stopping = true;
  renderAll();
  try {
    await st.queue;
    if (!st.writeFailed) st.stats = await store.finishSession(session.id, {status,reason,endedAt});
  } catch (error) {
    await recordingFailed(st, session, error);
  } finally {
    st.record = null;
    st.stopping = false;
    renderAll();
    await refreshHistory();
  }
}
function onTerminal(st, {reason}) {
  if (leaving) return;
  if (st.starting) st.terminalDuringStart = reason;
  if (st.record) void stopRecording(st, reason === 'manual' ? 'completed' : 'interrupted', reason === 'manual' ? '手動斷線' : '藍牙重連失敗');
}
async function saveMaxHR(st) {
  const input = $(`maxhr-${st.id}`);
  if (st.record || st.starting || st.stopping || !writer) { input.value = st.maxHR ?? ''; return; }
  const value = input.value === '' ? null : Number(input.value);
  if (value !== null && (!Number.isInteger(value) || value < 1 || value > 65535)) {
    input.value = st.maxHR ?? '';
    toast('請輸入正整數心率，或留白不設定區間。', true);
    return;
  }
  st.maxHR = value;
  renderSlot(st);
  try { await store.setSetting(`maxHR-${st.id}`, value); }
  catch (error) { toast(`區間設定僅在本次有效。${error.message}`, true); }
}
function changeMode(nextMode) {
  if (mode === nextMode || !writer || !initialized || slots.some(st => st.record || st.starting || st.stopping || st.pending)) return;
  for (const st of slots) st.controller.disconnect();
  mode = nextMode;
  for (const st of slots) {
    st.series.clear();
    st.stats = null;
    st.recordError = '';
    st.writeFailed = false;
    st.snapshot = nextMode === 'demo' ? {status:'waiting',currentBpm:null,deviceName:`模擬手錶 ${st.id + 1}`} : st.controller.snapshot;
  }
  demoSeconds = 0;
  if (mode === 'demo') emitDemo();
  renderAll();
  updateChart();
}
function emitDemo() {
  const timestamp = Date.now();
  for (const st of slots) {
    const bpm = Math.round(92 + st.id * 12 + 13 * Math.sin(demoSeconds / 15 + st.id) + 3 * Math.sin(demoSeconds / 3 + st.id * 2));
    st.snapshot = {status:'live',currentBpm:bpm,deviceName:`模擬手錶 ${st.id + 1}`,lastValidAt:timestamp};
    acceptSample(st, {timestamp,bpm});
  }
  demoSeconds++;
}

function chartOptions() {
  return {responsive:true, maintainAspectRatio:false, animation:false, parsing:false, normalized:false,
    interaction:{mode:'nearest',intersect:false}, plugins:{legend:{display:false},tooltip:{callbacks:{title:items => items.length ? new Date(items[0].parsed.x).toLocaleTimeString('zh-TW',{hour12:false}) : '',label:item => `${item.dataset.label}: ${item.parsed.y} BPM`}}},
    scales:{x:{type:'linear',grid:{color:'#26374b55'},ticks:{color:'#7790b0',maxTicksLimit:7,font:{size:10},callback:value => new Date(value).toLocaleTimeString('zh-TW',{hour12:false})}},y:{suggestedMin:40,suggestedMax:180,grid:{color:'#35465e66'},ticks:{color:'#839ab8',font:{size:10}},title:{display:true,text:'BPM',color:'#748aaa',font:{size:10}}}}};
}
function initChart() {
  try {
    if (!globalThis.Chart) throw new Error('Chart.js unavailable');
    liveChart = new Chart($('heartRateChart'), {type:'line',data:{datasets:slots.map(st => ({label:st.name,borderColor:st.color,backgroundColor:st.color,borderWidth:2,pointRadius:0,pointHitRadius:10,tension:0,spanGaps:false,data:[]}))},options:chartOptions()});
    updateChart();
  } catch {
    $('chartError').hidden = false;
    liveChart?.destroy();
    liveChart = null;
  }
}
function updateChart() {
  const now = Date.now();
  for (const st of slots) st.series.trim(now);
  if (!liveChart) return;
  try {
    for (const st of slots) liveChart.data.datasets[st.id].data = st.series.points;
    liveChart.options.scales.x.min = now - 60000;
    liveChart.options.scales.x.max = now;
    liveChart.update('none');
  } catch {
    liveChart.destroy(); liveChart = null;
    $('chartError').hidden = false;
  }
}
function loadMachineImages() {
  const image = new Image();
  image.onload = () => {
    for (const st of slots) {
      const canvas = $(`machine-${st.id}`);
      const {sx,sy,sw,sh} = st.crop;
      // Keep the actual quadrant ratio. CSS contain fits it into the 5:4 frame.
      canvas.width = Math.round(image.naturalWidth * sw);
      canvas.height = Math.round(image.naturalHeight * sh);
      canvas.getContext('2d').drawImage(image, image.naturalWidth*sx,image.naturalHeight*sy,image.naturalWidth*sw,image.naturalHeight*sh,0,0,canvas.width,canvas.height);
      $(`placeholder-${st.id}`).hidden = true;
    }
  };
  image.onerror = () => {
    for (const st of slots) {
      $(`machine-${st.id}`).hidden = true;
      $(`placeholder-${st.id}`).textContent = `${st.name} · 圖片暫時無法載入`;
    }
  };
  image.src = './exercise-machine.jpg';
}

async function refreshHistory() {
  const revision = ++historyRevision;
  if (!storeReady) {
    $('historyList').innerHTML = '<div class="empty-state">本機儲存目前無法使用，仍可進行即時監看。</div>';
    return;
  }
  try {
    const sessions = await store.listSessions();
    if (revision !== historyRevision) return;
    $('historyCount').textContent = sessions.length;
    if (!sessions.length) {
      $('historyList').innerHTML = '<div class="empty-state"><strong>你的第一筆運動紀錄，從這裡開始。</strong>連接手錶或切換展示模式，再點擊機台的「開始紀錄」。</div>';
      return;
    }
    $('historyList').innerHTML = sessions.map(session => {
      const status = session.status === 'recording' ? '紀錄中' : session.status === 'interrupted' ? '中斷' : '已完成';
      return `<div class="history-row"><div class="history-summary"><strong>${escapeHtml(session.machine)}<span class="source-tag ${session.source === 'demo' ? 'demo' : ''}">${session.source === 'demo' ? '模擬' : '藍牙'}</span></strong><small>${escapeHtml(session.deviceName)} · ${status}</small></div><div class="history-time"><span class="history-status">${dateText(session.startedAt)}</span><small>${elapsedText((session.endedAt ?? Date.now()) - session.startedAt)} · ${session.count} 筆數據</small></div><div class="history-average history-value">${session.count ? Math.round(session.sum/session.count) : '--'}<span>平均 BPM</span></div><button class="button subtle" data-session="${escapeHtml(session.id)}" aria-label="查看${escapeHtml(session.machine)}紀錄">查看詳情</button></div>`;
    }).join('');
  } catch (error) {
    if (revision !== historyRevision) return;
    $('historyList').innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}
// Preserve gap markers and extrema while bounding a historical chart's size.
function historyPoints(events, maxPoints = 2400) {
  if (events.length <= maxPoints) return events.map(e => ({x:e.timestamp,y:e.bpm}));
  const size = Math.ceil(events.length / Math.floor(maxPoints / 4));
  const points = [];
  for (let i=0; i<events.length; i+=size) {
    const chunk = events.slice(i,i+size);
    if (chunk.some(e => e.bpm === null)) {
      // A gap anywhere in a bucket must not be turned into a continuous line.
      points.push({x:chunk[0].timestamp,y:null});
      continue;
    }
    let min = chunk[0], max = chunk[0];
    for (const event of chunk) { if (event.bpm < min.bpm) min = event; if (event.bpm > max.bpm) max = event; }
    const selected = [...new Set([chunk[0],min,max,chunk.at(-1)])].sort((a,b)=>a.timestamp-b.timestamp);
    points.push(...selected.map(e=>({x:e.timestamp,y:e.bpm})));
  }
  return points;
}
async function showDetail(id) {
  const revision = ++detailRevision;
  try {
    // Flush this page's accepted writes before presenting a consistent snapshot.
    await Promise.all(slots.filter(st=>st.record?.id === id).map(st=>st.queue));
    const {session,events} = await store.getSessionSnapshot(id);
    if (revision !== detailRevision || !session) return;
    selectedSession = session;
    $('detailTitle').textContent = session.machine;
    $('detailMeta').className = 'detail-meta';
    $('detailMeta').innerHTML = `${escapeHtml(session.deviceName)} <span class="source-tag ${session.source === 'demo' ? 'demo' : ''}">${session.source === 'demo' ? '模擬紀錄' : '藍牙紀錄'}</span><br>${dateText(session.startedAt)} → ${session.endedAt ? dateText(session.endedAt) : '紀錄中（目前快照）'}<br>${session.status === 'interrupted' ? `中斷原因：${escapeHtml(session.reason)}` : session.status === 'recording' ? '紀錄仍在進行，關閉後重新開啟可更新資料。' : '紀錄已完成'}${session.maxHR ? `<br>參考最大心率：${session.maxHR} BPM` : ''}`;
    $('detailStats').innerHTML = [['持續時間',elapsedText((session.endedAt ?? Date.now())-session.startedAt)],['最低 BPM',session.min ?? '--'],['平均 BPM',session.count ? Math.round(session.sum/session.count) : '--'],['最高 BPM',session.max ?? '--']].map(([label,value])=>`<div><small>${label}</small><strong>${value}</strong></div>`).join('');
    $('detailEmpty').textContent = `${session.count} 筆有效數據${events.length > 2400 ? ' · 曲線已簡化顯示，CSV 保留完整數據' : ''}${session.count === 0 ? ' · 這段期間沒有收到有效心率' : ''}`;
    $('detailDeleteBtn').disabled = !writer || session.status === 'recording';
    $('detailExportBtn').disabled = session.count === 0;
    if (!$('detailDialog').open) $('detailDialog').showModal();
    historyChart?.destroy(); historyChart = null;
    $('historyChartError').hidden = true;
    try {
      const options = chartOptions();
      options.scales.x.min = session.startedAt;
      options.scales.x.max = Math.max(session.startedAt+1000,session.endedAt ?? Date.now());
      historyChart = new Chart($('historyChart'), {type:'line',data:{datasets:[{label:session.machine,data:historyPoints(events),borderColor:slots[session.slotId]?.color ?? '#8eafff',borderWidth:2,pointRadius:session.count<2?3:0,spanGaps:false,tension:0}]},options});
    } catch { $('historyChartError').hidden = false; }
  } catch (error) { toast(`無法開啟紀錄。${error.message}`,true); }
}
async function exportDetail() {
  if (!selectedSession) return;
  const id = selectedSession.id;
  try {
    const {session,events} = await store.getSessionSnapshot(id);
    const samples = events.filter(event=>event.bpm !== null);
    if (!session || !samples.length) { toast('這筆紀錄沒有可匯出的心率。'); return; }
    const blob = new Blob([sessionCsv(session,samples)],{type:'text/csv;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `心率_${session.source === 'demo' ? '模擬' : '藍牙'}_機台${session.slotId+1}_${new Date(session.startedAt).toISOString().replace(/[:.]/g,'-')}.csv`;
    link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  } catch (error) { toast(`匯出失敗。${error.message}`,true); }
}
async function deleteDetail() {
  if (!selectedSession || !writer || selectedSession.status === 'recording') return;
  if (!confirm('確定刪除此筆運動紀錄？刪除後無法復原，請先匯出需要保留的資料。')) return;
  try {
    const id = selectedSession.id;
    await store.deleteSession(id);
    for (const st of slots) if (st.stats?.id === id) { st.stats = null; renderSlot(st); }
    $('detailDialog').close();
    toast('已刪除紀錄。');
    await refreshHistory();
  } catch (error) { toast(error.message,true); }
}

async function checkBluetooth() {
  const badge = $('environmentBadge');
  if (!isSecureContext) {
    bluetoothReady = false;
    badge.textContent = '需要安全連線'; badge.className = 'pill warning';
    setAlert('bluetooth','請使用 http://localhost:8000 或 HTTPS 開啟，才能取得藍牙權限。');
  } else if (!navigator.bluetooth?.requestDevice) {
    bluetoothReady = false;
    badge.textContent = '瀏覽器未提供藍牙'; badge.className = 'pill warning';
    setAlert('bluetooth','此瀏覽器未提供 Web Bluetooth。請使用 Chrome／Edge，或完成樹莓派 Chromium 設定；仍可使用展示模式。');
  } else {
    let available = true;
    try { if (navigator.bluetooth.getAvailability) available = await navigator.bluetooth.getAvailability(); } catch { /* Availability is a hint; the chooser remains authoritative. */ }
    bluetoothReady = available;
    badge.textContent = available ? '可使用 Web Bluetooth' : '藍牙目前不可用';
    badge.className = `pill ${available ? 'ready' : 'warning'}`;
    setAlert('bluetooth',available ? '' : '請開啟此裝置的藍牙，並確認瀏覽器具有藍牙權限。');
  }
  renderAll();
}
async function acquireWriterLock() {
  if (!navigator.locks) return false;
  return new Promise(resolve => {
    navigator.locks.request('exercise-heart-rate-writer',{ifAvailable:true},async lock => {
      resolve(!!lock);
      if (lock) await new Promise(() => {}); // Released by the browser when this document closes.
    }).catch(()=>resolve(false));
  });
}
async function boot() {
  renderCards();
  for (const st of slots) {
    st.controller = new BleSlot({id:st.id,registry,bluetooth:navigator.bluetooth,onState:snapshot=>onBluetoothState(st,snapshot),onSample:sample=>acceptSample(st,sample),onTerminal:event=>onTerminal(st,event)});
    st.snapshot = st.controller.snapshot;
  }
  renderAll();
  loadMachineImages();
  initChart();
  $('demoModeBtn').addEventListener('click',()=>changeMode('demo'));
  $('bleModeBtn').addEventListener('click',()=>changeMode('ble'));
  $('helpBtn').addEventListener('click',()=>$('helpDialog').showModal());
  for (const button of document.querySelectorAll('.close-dialog')) button.addEventListener('click',()=>button.closest('dialog').close());
  $('detailDialog').addEventListener('close',()=>{ ++detailRevision; historyChart?.destroy(); historyChart=null; selectedSession=null; });
  $('clearChartBtn').addEventListener('click',()=>{ for (const st of slots) st.series.clear(); updateChart(); toast('即時圖表已清除，運動紀錄與統計不受影響。'); });
  $('refreshHistoryBtn').addEventListener('click',()=>void refreshHistory());
  $('historyList').addEventListener('click',event=>{ const button=event.target.closest('[data-session]'); if(button) void showDetail(button.dataset.session); });
  $('detailExportBtn').addEventListener('click',()=>void exportDetail());
  $('detailDeleteBtn').addEventListener('click',()=>void deleteDetail());
  navigator.bluetooth?.addEventListener?.('availabilitychanged',()=>void checkBluetooth());
  writer = await acquireWriterLock();
  if (!writer) setAlert('writer','此分頁為唯讀：另一個分頁可能正在監測。請關閉其他監測分頁後重新整理；若只有此分頁，請更新瀏覽器以支援本機鎖定。');
  try {
    await store.open();
    if (writer) await store.recoverInterrupted();
    storeReady = true;
    for (const st of slots) {
      const setting = await store.getSetting(`maxHR-${st.id}`);
      st.maxHR = Number.isInteger(setting) && setting > 0 && setting <= 65535 ? setting : null;
      $(`maxhr-${st.id}`).value = st.maxHR ?? '';
    }
  } catch (error) { setAlert('storage',`無法保存本機紀錄，仍可即時監看。${error.message}`,true); }
  initialized = true;
  await checkBluetooth();
  await refreshHistory();
  renderAll();
  setInterval(()=>{
    if (mode === 'demo' && writer) emitDemo();
    else for (const st of slots) st.controller.tick();
    renderAll(); updateChart();
  },1000);
  document.addEventListener('visibilitychange',()=>{
    if (document.visibilityState === 'visible') {
      for (const st of slots) st.controller.tick();
      if (mode === 'demo') for (const st of slots) if (Date.now() - (st.snapshot.lastValidAt ?? 0) > 10000) { st.series.gap(Date.now()); recordGap(st,'分頁暫停更新'); }
      updateChart(); void checkBluetooth(); void refreshHistory();
    }
  });
  window.addEventListener('pagehide',()=>{
    // Unload cannot reliably await IDB. Keep the persisted session unfinished;
    // the next owner reconciles it to interrupted at the last committed sample.
    leaving = true;
    for(const st of slots) { st.accepting = false; st.controller.dispose(); }
  });
  // A bfcache-restored page must obtain a fresh writer lock and reconcile records.
  window.addEventListener('pageshow',event=>{ if(event.persisted) location.reload(); });
  document.body.dataset.ready = 'true';
}
void boot().catch(error=>{ setAlert('startup',`啟動失敗：${error.message}`,true); });

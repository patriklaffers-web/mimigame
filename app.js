import { Hub, MSG } from './spike.js';
import {
  PORTS, DIR_ORDER, HORN, PROGRAM_COUNT, slotFor, driveProgram, hornProgram, SAMPLE_CODE, configSignature,
} from './programs.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

let hub = null;
let installedSig = null;   // config signature currently on the hub
let installing = false;
let desired = null;        // direction key the user wants, or null
let active = null;         // slot currently running (that we started), or null
let reconciling = false;

// ------------------------------------------------------------- settings ----
for (const sel of [$('leftPort'), $('rightPort')]) {
  for (const p of PORTS) sel.add(new Option(`Port ${p}`, p));
}
const saved = store.get('spike-car-settings', {});
$('leftPort').value = saved.leftPort ?? 'A';
$('rightPort').value = saved.rightPort ?? 'B';
$('revLeft').checked = saved.revLeft ?? true;
$('revRight').checked = saved.revRight ?? false;
$('speed').value = saved.speed ?? 60;
$('turn').value = saved.turn ?? 40;
$('slotBase').value = saved.slotBase ?? 10;
$('code').value = store.get('spike-car-code', SAMPLE_CODE);

function config() {
  const base = Math.min(20 - PROGRAM_COUNT, Math.max(0, parseInt($('slotBase').value, 10) || 0));
  return {
    leftPort: $('leftPort').value, rightPort: $('rightPort').value,
    revLeft: $('revLeft').checked, revRight: $('revRight').checked,
    speed: +$('speed').value, turn: +$('turn').value, slotBase: base,
  };
}

function refreshSettingsUI() {
  const c = config();
  $('speedOut').textContent = `${c.speed}%`;
  $('turnOut').textContent = `${c.turn}%`;
  $('slotRange').textContent = `uses ${c.slotBase}–${c.slotBase + PROGRAM_COUNT - 1}`;
  store.set('spike-car-settings', c);
  const ready = hub?.connected && installedSig === configSignature(c);
  $('installBtn').disabled = !hub?.connected || installing;
  $('installBtn').textContent = ready ? 'Reinstall drive programs' : 'Install drive programs';
  if (hub?.connected && !installing) {
    setStatus(ready ? 'Ready to drive.' : 'Settings changed — install to apply.', ready ? 'ok' : '');
  }
}

for (const id of ['leftPort', 'rightPort', 'revLeft', 'revRight', 'slotBase']) $(id).addEventListener('change', refreshSettingsUI);
for (const id of ['speed', 'turn']) {
  $(id).addEventListener('input', refreshSettingsUI);
  // speed changes need new programs on the hub; reinstall automatically
  $(id).addEventListener('change', () => { if (hub?.connected && installedSig) install(); });
}
$('code').addEventListener('input', () => store.set('spike-car-code', $('code').value));

// ---------------------------------------------------------------- log ------
function log(text, cls) {
  const el = $('log');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
  const line = document.createElement('div');
  if (cls) line.style.color = cls === 'err' ? 'var(--stop)' : 'var(--muted)';
  line.textContent = text;
  el.append(line);
  while (el.childNodes.length > 400) el.firstChild.remove();
  if (atBottom) el.scrollTop = el.scrollHeight;
}

function setStatus(text, cls = '') {
  const s = $('installStatus');
  s.textContent = text;
  s.className = `status ${cls}`;
}

// ------------------------------------------------------------ connect ------
if (!navigator.bluetooth) $('noBt').style.display = 'block';

$('connectBtn').addEventListener('click', async () => {
  if (hub?.connected) { await stopAll(); hub.disconnect(); return; }
  hub = new Hub();
  hub.addEventListener('message', (e) => onMessage(e.message));
  hub.addEventListener('disconnect', onDisconnect);
  $('connectBtn').disabled = true;
  $('hubInfo').textContent = 'Connecting…';
  try {
    const info = await hub.connect();
    $('dot').classList.add('on');
    $('hubInfo').textContent = `${hub.device.name || 'Hub'} · fw ${info.firmware}`;
    $('connectBtn').textContent = 'Disconnect';
    $('runBtn').disabled = false;
    $('stopCodeBtn').disabled = false;
    log(`Connected to ${hub.device.name || 'hub'} (firmware ${info.firmware}, RPC ${info.rpc})`, 'muted');
    await hub.enableDeviceNotifications(250).catch(() => log('Could not enable sensor data', 'err'));
    installedSig = store.get(`spike-car-installed:${hub.device.id}`, null);
    refreshSettingsUI();
    if (installedSig !== configSignature(config())) await install();
  } catch (err) {
    if (err.name === 'SecurityError') {
      // e.g. page embedded in a frame that isn't allowed to use Bluetooth
      $('noBt').style.display = 'block';
      log('Bluetooth is blocked on this page. Download the app file and open it in Chrome or Edge instead.', 'err');
    } else if (err.name !== 'NotFoundError') log(`Connection failed: ${err.message}`, 'err'); // NotFoundError = picker cancelled
    if (hub?.connected) hub.disconnect(); else onDisconnect();
  } finally {
    $('connectBtn').disabled = false;
  }
});

function onDisconnect() {
  $('dot').classList.remove('on');
  $('hubInfo').textContent = 'Not connected';
  $('connectBtn').textContent = 'Connect hub';
  $('runBtn').disabled = $('stopCodeBtn').disabled = true;
  active = null; desired = null; installing = false; installedSig = null;
  renderPad();
  refreshSettingsUI();
  setStatus('Disconnected.');
  if (hub) log('Disconnected', 'muted');
  telemetry.clear();
  renderTelemetry();
}

// ------------------------------------------------------------ install ------
async function install() {
  if (installing || !hub?.connected) return;
  installing = true;
  desired = null;
  await stopAll();
  const cfg = config();
  const jobs = [
    ...DIR_ORDER.map((d) => [slotFor(cfg.slotBase, d), driveProgram(d, cfg)]),
    [slotFor(cfg.slotBase, HORN), hornProgram()],
  ];
  refreshSettingsUI();
  try {
    for (let i = 0; i < jobs.length; i++) {
      setStatus(`Installing program ${i + 1} of ${jobs.length}…`);
      $('progress').style.width = `${(i / jobs.length) * 100}%`;
      await hub.uploadProgram(jobs[i][0], jobs[i][1]);
    }
    $('progress').style.width = '100%';
    installedSig = configSignature(cfg);
    store.set(`spike-car-installed:${hub.device.id}`, installedSig);
  } catch (err) {
    setStatus(`Install failed: ${err.message}`, 'err');
    log(`Install failed: ${err.message}`, 'err');
    installedSig = null;
  } finally {
    installing = false;
    setTimeout(() => { $('progress').style.width = '0'; }, 600);
    refreshSettingsUI();
    // the user may have moved the slider again while we were installing
    if (hub?.connected && installedSig && installedSig !== configSignature(config())) install();
  }
}
$('installBtn').addEventListener('click', install);

// ------------------------------------------------------------- driving -----
const ready = () => hub?.connected && !installing && installedSig === configSignature(config());

function drive(dir) {
  if (dir && !ready()) {
    if (hub?.connected && !installing) setStatus('Install the drive programs first.', 'err');
    dir = null;
  }
  if (dir === desired) return;
  desired = dir;
  renderPad();
  reconcile();
}

// Converge the hub's running program to `desired`, coalescing rapid changes.
async function reconcile() {
  if (reconciling) return;
  reconciling = true;
  try {
    while (hub?.connected) {
      const wantSlot = desired ? slotFor(installedSigBase(), desired) : null;
      if (wantSlot === active) break;
      if (active !== null) {
        await hub.stopProgram(active).catch(() => {});
        active = null;
      }
      if (wantSlot !== null && desired) {
        const res = await hub.startProgram(wantSlot);
        if (res.success) active = wantSlot;
        else { log(`Hub refused to start slot ${wantSlot}`, 'err'); desired = null; renderPad(); }
      }
    }
  } catch (err) {
    log(`Drive error: ${err.message}`, 'err');
    desired = null; renderPad();
  } finally {
    reconciling = false;
  }
}
const installedSigBase = () => config().slotBase;

async function stopAll() {
  desired = null;
  renderPad();
  if (!hub?.connected) return;
  const slot = active ?? config().slotBase;
  active = null;
  await hub.stopProgram(slot).catch(() => {});
}

async function horn() {
  if (!ready()) return;
  desired = null; renderPad();
  while (reconciling) await new Promise((r) => setTimeout(r, 20));
  if (active !== null) { await hub.stopProgram(active).catch(() => {}); active = null; }
  const slot = slotFor(config().slotBase, HORN);
  const res = await hub.startProgram(slot).catch(() => null);
  if (res?.success) active = slot;
}

// pad (pointer)
const padButtons = [...document.querySelectorAll('#pad [data-dir]')];
let pointerDir = null;
for (const btn of padButtons) {
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    btn.setPointerCapture(e.pointerId);
    pointerDir = btn.dataset.dir;
    updateInput();
  });
  const release = () => { if (pointerDir === btn.dataset.dir) { pointerDir = null; updateInput(); } };
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointercancel', release);
  btn.addEventListener('lostpointercapture', release);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}
$('stopBtn').addEventListener('click', () => { pointerDir = null; keys.clear(); stopAll(); });
$('hornBtn').addEventListener('click', horn);

function renderPad() {
  for (const b of padButtons) b.classList.toggle('active', b.dataset.dir === desired);
}

// keyboard
const keys = new Set();
const KEYMAP = { ArrowUp: 'u', KeyW: 'u', ArrowDown: 'd', KeyS: 'd', ArrowLeft: 'l', KeyA: 'l', ArrowRight: 'r', KeyD: 'r' };
window.addEventListener('keydown', (e) => {
  if (e.target.closest('textarea, input, select')) return;
  if (e.code === 'Space') { e.preventDefault(); keys.clear(); pointerDir = null; stopAll(); return; }
  if (e.code === 'KeyH' && !e.repeat) { horn(); return; }
  const k = KEYMAP[e.code];
  if (!k) return;
  e.preventDefault();
  keys.add(k); updateInput();
});
window.addEventListener('keyup', (e) => { const k = KEYMAP[e.code]; if (k) { keys.delete(k); updateInput(); } });
window.addEventListener('blur', () => { keys.clear(); pointerDir = null; gamepadDir = null; updateInput(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { keys.clear(); pointerDir = null; updateInput(); } });

function dirFromVector(x, y) { // x: -1 left .. 1 right, y: -1 back .. 1 forward
  if (!x && !y) return null;
  if (y > 0) return x < 0 ? 'fl' : x > 0 ? 'fr' : 'f';
  if (y < 0) return x < 0 ? 'bl' : x > 0 ? 'br' : 'b';
  return x < 0 ? 'l' : 'r';
}

function keyboardDir() {
  const x = (keys.has('r') ? 1 : 0) - (keys.has('l') ? 1 : 0);
  const y = (keys.has('u') ? 1 : 0) - (keys.has('d') ? 1 : 0);
  return dirFromVector(x, y);
}

// gamepad (left stick or d-pad)
let gamepadDir = null;
function pollGamepad() {
  const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
  let dir = null;
  for (const gp of pads) {
    let x = gp.axes[0] ?? 0, y = -(gp.axes[1] ?? 0);
    if (gp.buttons[12]?.pressed) y = 1;
    if (gp.buttons[13]?.pressed) y = -1;
    if (gp.buttons[14]?.pressed) x = -1;
    if (gp.buttons[15]?.pressed) x = 1;
    const mag = Math.hypot(x, y);
    if (mag > 0.45) {
      const a = Math.atan2(y, x); // 8 sectors
      const sx = Math.abs(Math.cos(a)) > 0.38 ? Math.sign(x) : 0;
      const sy = Math.abs(Math.sin(a)) > 0.38 ? Math.sign(y) : 0;
      dir = dirFromVector(sx, sy);
    }
    if (gp.buttons[0]?.pressed && !pollGamepad.hornDown) horn();
    pollGamepad.hornDown = !!gp.buttons[0]?.pressed;
  }
  if (dir !== gamepadDir) { gamepadDir = dir; updateInput(); }
  if (pads.length) requestAnimationFrame(pollGamepad); else pollGamepad.running = false;
}
window.addEventListener('gamepadconnected', () => {
  log('Gamepad connected', 'muted');
  if (!pollGamepad.running) { pollGamepad.running = true; requestAnimationFrame(pollGamepad); }
});

function updateInput() { drive(pointerDir ?? keyboardDir() ?? gamepadDir); }

// ------------------------------------------------------------ custom code --
$('runBtn').addEventListener('click', async () => {
  const slot = Math.min(19, Math.max(0, parseInt($('codeSlot').value, 10) || 0));
  const base = config().slotBase;
  if (slot >= base && slot < base + PROGRAM_COUNT && !confirm(`Slot ${slot} is used by the drive programs. Overwrite it?`)) return;
  $('runBtn').disabled = true;
  try {
    await stopAll();
    log(`Uploading to slot ${slot}…`, 'muted');
    await hub.uploadProgram(slot, $('code').value);
    if (slot >= base && slot < base + PROGRAM_COUNT) { installedSig = null; refreshSettingsUI(); }
    const res = await hub.startProgram(slot);
    if (res.success) { active = slot; log(`Running slot ${slot}`, 'muted'); } else log('Hub refused to start the program', 'err');
  } catch (err) {
    log(`Run failed: ${err.message}`, 'err');
  } finally {
    $('runBtn').disabled = !hub?.connected;
  }
});
$('stopCodeBtn').addEventListener('click', async () => {
  const slot = Math.min(19, Math.max(0, parseInt($('codeSlot').value, 10) || 0));
  desired = null; renderPad();
  await hub?.stopProgram(active ?? slot).catch(() => {});
  active = null;
});

// ------------------------------------------------------------ messages -----
const telemetry = new Map();
const COLORS = ['Black', 'Magenta', 'Purple', 'Blue', 'Azure', 'Turquoise', 'Green', 'Yellow', 'Orange', 'Red', 'White'];
const MOTOR_TYPES = { 0x30: 'Medium motor', 0x31: 'Large motor', 0x41: 'Small motor' };

function onMessage(m) {
  switch (m.id) {
    case MSG.ConsoleNotification:
      log(m.text.replace(/\n$/, ''));
      break;
    case MSG.ProgramFlowNotification:
      // only trust "stopped" when we aren't switching programs ourselves; a late
      // notice for the previous program could otherwise clobber the new one
      if (m.stopped && !desired && !reconciling) active = null;
      break;
    case MSG.DeviceNotification:
      for (const d of m.devices) {
        const P = PORTS[d.port] ?? '?';
        if (d.kind === 'battery') telemetry.set('battery', ['Battery', `${d.level}%`]);
        else if (d.kind === 'imu') telemetry.set('imu', ['Tilt (pitch / roll)', `${d.pitch} / ${d.roll}`]);
        else if (d.kind === 'motor') telemetry.set(`p${d.port}`, [`${P} · ${MOTOR_TYPES[d.type] ?? 'Motor'}`, `${d.position}° · ${d.speed}%`]);
        else if (d.kind === 'distance') telemetry.set(`p${d.port}`, [`${P} · Distance`, d.mm < 0 ? '—' : `${(d.mm / 10).toFixed(1)} cm`]);
        else if (d.kind === 'color') telemetry.set(`p${d.port}`, [`${P} · Color`, COLORS[d.color] ?? '—']);
        else if (d.kind === 'force') telemetry.set(`p${d.port}`, [`${P} · Force`, `${d.value}%${d.pressed ? ' ●' : ''}`]);
      }
      renderTelemetry();
      break;
  }
}

let telemetryFrame = 0;
function renderTelemetry() {
  if (telemetryFrame) return;
  telemetryFrame = requestAnimationFrame(() => {
    telemetryFrame = 0;
    const el = $('telemetry');
    if (!telemetry.size) { el.innerHTML = '<div class="empty">Connect the hub to see live data.</div>'; return; }
    const keys = [...telemetry.keys()].sort();
    el.replaceChildren(...keys.map((k) => {
      const [label, value] = telemetry.get(k);
      const t = document.createElement('div');
      t.className = 'tile';
      t.innerHTML = '<div class="k"></div><div class="v"></div>';
      t.firstChild.textContent = label;
      t.lastChild.textContent = value;
      return t;
    }));
  });
}

refreshSettingsUI();

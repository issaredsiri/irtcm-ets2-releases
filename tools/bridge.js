#!/usr/bin/env node
/*
 * Truck Dash bridge: runs on every player's PC and pushes this truck into the shared room.
 *
 *   localhost:25555 /api/ets2/telemetry  -> "pos"  (~1/s while moving, every 5 s when parked)
 *   localhost:25556 /gps + /route        -> "plan" (on a new save, and every 10 s for late joiners)
 *
 * Sends through the Supabase Realtime REST broadcast endpoint, so it never receives messages
 * (keeps the free-tier message count down). Supabase URL / anon key come from
 * server/Html/m/room-config.js; name + room code from tools/bridge.config.json (asked on first run).
 *
 * Usage: routing\node\node.exe tools\bridge.js [--setup]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(__dirname, 'bridge.config.json');
const ROOM_CONFIG = path.join(ROOT, 'server', 'Html', 'm', 'room-config.js');
const TELEMETRY = 'http://localhost:25555/api/ets2/telemetry';
const ROUTE = 'http://localhost:25556';
const POS_MS = 1000, PARKED_MS = 5000, PLAN_MS = 10000, GPS_MS = 3000;
const MAX_PLAN_BYTES = 200 * 1024;   // Realtime messages are capped at 256 KB

// ---------- config ----------
function readRoomConfig() {
  const src = fs.readFileSync(ROOM_CONFIG, 'utf8');
  const get = k => (new RegExp(k + "\\s*:\\s*['\"]([^'\"]*)['\"]").exec(src) || [])[1] || '';
  return { url: get('supabaseUrl').replace(/\/+$/, ''), key: get('supabaseAnonKey') };
}
function newRoomCode() {
  // 12 chars from a 32-letter alphabet (~60 bits): not guessable, still easy to read out
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (const b of crypto.randomBytes(12)) s += abc[b % 32];
  return s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8);
}
async function setup(old) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('\n=== Truck Dash bridge: ตั้งค่าครั้งแรก ===');
  let name = (await rl.question(`ชื่อที่เพื่อนเห็น${old.name ? ` [${old.name}]` : ''}: `)).trim() || old.name || '';
  while (!name) name = (await rl.question('ชื่อ (ห้ามว่าง): ')).trim();
  let room = (await rl.question(`Room code จากเพื่อน (เว้นว่าง = ${old.room ? `ใช้ ${old.room}` : 'สร้างห้องใหม่'}): `)).trim().toUpperCase();
  if (!room) room = old.room || newRoomCode();
  rl.close();
  const cfg = { name: name.slice(0, 24), room };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  console.log(`\nบันทึกแล้ว: ${CONFIG_FILE}`);
  console.log(`ส่ง room code นี้ให้เพื่อน: ${room}\n`);
  return cfg;
}
async function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* first run */ }
  if (process.argv.includes('--setup') || !cfg.name || !cfg.room) cfg = await setup(cfg);
  return cfg;
}

// ---------- helpers ----------
async function getJson(url, ms = 2000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  return r.json();
}
const r1 = v => Math.round(v * 10) / 10;

// keep the route light: drop points closer than 20 units, remap step/stop indices onto the kept points
function slimRoute(d) {
  const keep = [], map = new Array(d.points.length);
  let last = null;
  d.points.forEach((p, i) => {
    const end = i === d.points.length - 1;
    if (!last || end || Math.hypot(p[0] - last[0], p[1] - last[1]) >= 20) { keep.push([Math.round(p[0]), Math.round(p[1])]); last = p; }
    map[i] = keep.length - 1;
  });
  const at = i => map[Math.max(0, Math.min(map.length - 1, i))];
  return {
    points: keep,
    steps: (d.steps || []).map(s => ({ ...s, idx: at(s.idx) })),
    stops: (d.stops || []).map(s => ({ ...s, idx: at(s.idx) })),
    distance: d.distance, duration: d.duration,
  };
}
function distToRoute(points, x, z) {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1], dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz;
    const t = L ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L)) : 0;
    best = Math.min(best, Math.hypot(a[0] + t * dx - x, a[1] + t * dz - z));
  }
  return best;
}

// Dashboard data for every tab (Drive / Job / Truck) on phones that only see this player through the room.
// full = every scalar field of truck / trailer / job (sent every FULL_MS: wear, temperatures... change slowly);
// otherwise only what changes every second. The page keeps the last full copy and overlays the light ones.
const FULL_MS = 5000;
const FAST_TRUCK = ['speed', 'engineRpm', 'displayedGear', 'gameSteer', 'gameThrottle', 'gameBrake', 'gameClutch',
  'blinkerLeftOn', 'blinkerRightOn', 'cruiseControlOn', 'cruiseControlSpeed', 'parkBrakeOn', 'motorBrakeOn', 'retarderBrake',
  'lightsBeamLowOn', 'lightsBeamHighOn', 'lightsBeaconOn', 'fuel', 'airPressure'];
function scalars(o) {
  const out = {};
  for (const [k, v] of Object.entries(o || {})) {
    if (typeof v === 'number') out[k] = Math.round(v * 1000) / 1000;
    else if (typeof v === 'string' || typeof v === 'boolean') out[k] = v;   // objects (placement, acceleration...) skipped
  }
  return out;
}
function dashOf(d, full) {
  const t = scalars(d.truck), n = d.navigation;
  const nav = { estimatedTime: n.estimatedTime, estimatedDistance: Math.round(n.estimatedDistance), speedLimit: n.speedLimit };
  const game = { time: d.game.time, paused: d.game.paused, nextRestStopTime: d.game.nextRestStopTime, timeScale: d.game.timeScale };
  if (full) return { full: true, game, truck: t, trailer: scalars(d.trailer), job: scalars(d.job), navigation: nav };
  const fast = {};
  for (const k of FAST_TRUCK) if (k in t) fast[k] = t[k];
  return { game, truck: fast, navigation: nav };
}

// ---------- main ----------
(async () => {
  const cfg = await loadConfig();
  if (process.argv.includes('--setup-only')) return;
  const sb = readRoomConfig();
  if (!sb.url || !sb.key) {
    console.error(`ยังไม่ได้ใส่ Supabase URL / anon key ใน ${ROOM_CONFIG}`);
    console.error('ดูขั้นตอนใน PLAN.md (เฟส 4) แล้วรันใหม่');
    process.exitCode = 1;
    return;
  }
  const topic = 'room:' + cfg.room;
  console.log(`bridge: ${cfg.name} -> room ${cfg.room} (${sb.url})`);

  let sent = 0, errors = 0, lastErr = '';
  async function broadcast(event, payload) {
    try {
      const r = await fetch(sb.url + '/realtime/v1/api/broadcast', {
        method: 'POST',
        // legacy anon key (JWT) also goes as Bearer; new "sb_publishable_" keys only as apikey
        headers: Object.assign({ apikey: sb.key, 'Content-Type': 'application/json' },
          sb.key.startsWith('eyJ') ? { Authorization: 'Bearer ' + sb.key } : {}),
        body: JSON.stringify({ messages: [{ topic, event, payload, private: false }] }),
        signal: AbortSignal.timeout(5000),
      });
      if (r.status >= 300) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
      sent++; lastErr = '';
      return true;
    } catch (e) {
      errors++; lastErr = String(e.message || e);
      return false;
    }
  }

  let truck = null, job = null, telemetryOk = false, gameOk = false;
  let lastPos = 0, lastSent = null, lastFull = 0;
  async function tickPos() {
    try {
      const d = await getJson(TELEMETRY);
      telemetryOk = true;
      gameOk = !!(d.game && d.game.connected);
      if (!gameOk) return;
      const pl = d.truck.placement;
      truck = { x: pl.x, y: pl.y, z: pl.z, h: pl.heading, s: Math.abs(d.truck.speed) };
      // active job (the old plugin never clears it, but the game's nav distance drops to 0 once it is done)
      const j = d.job, navM = d.navigation ? d.navigation.estimatedDistance : 0;
      job = j && j.destinationCity && navM > 0 ? { city: j.destinationCity, company: j.destinationCompany, nav: Math.round(navM) } : null;
      const now = Date.now();
      const parked = truck.s < 1 || d.game.paused;
      const moved = !lastSent || Math.hypot(truck.x - lastSent.x, truck.z - lastSent.z) > 1;
      if (now - lastPos < (parked && !moved ? PARKED_MS : POS_MS)) return;
      lastPos = now; lastSent = truck;
      const full = now - lastFull >= FULL_MS;
      const ok = await broadcast('pos', { name: cfg.name, x: r1(pl.x), z: r1(pl.z), h: Math.round(pl.heading * 10000) / 10000, s: r1(truck.s),
                                          p: !!d.game.paused, t: now, d: dashOf(d, full) });
      if (ok && full) lastFull = now;
    } catch {
      telemetryOk = false; gameOk = false;
    }
  }

  let gps = null, plan = null, lastPlan = 0, lastRoute = 0, routeOk = false;
  async function tickPlan() {
    try {
      const g = await getJson(ROUTE + '/gps');
      routeOk = true;
      const wps = g && g.ok ? (g.ahead || []).map(w => [Math.round(w.x), Math.round(w.z)]) : [];
      let savedAt = g && g.ok ? g.savedAt : 0;
      const now = Date.now();
      // no waypoints of our own but a job (e.g. driving the job's GPS route, or convoy host): share the job route
      const jobKey = !wps.length && job ? `${job.city}|${job.company}` : '';
      const gpsSavedAt = savedAt;
      let need = !plan || plan.gpsSavedAt !== gpsSavedAt || (plan.jobKey || '') !== jobKey;
      // off our own route (detour) -> route again from here, at most every 30 s
      if (!need && plan.route && truck && now - lastRoute > 30000 && distToRoute(plan.route, truck.x, truck.z) > 200) need = true;
      if (need && truck) {
        let r = null, planWps = wps, label = '';
        const from = `x=${truck.x.toFixed(1)}&z=${truck.z.toFixed(1)}&h=${truck.h.toFixed(4)}`;
        try {
          if (wps.length) {
            const d = await getJson(`${ROUTE}/route?${from}&via=` + wps.map(w => w.join(',')).join(';'), 20000);
            if (d.ok && d.points && d.points.length > 1) r = slimRoute(d);
          } else if (jobKey) {
            const d = await getJson(`${ROUTE}/route?${from}&city=${encodeURIComponent(job.city)}&company=${encodeURIComponent(job.company)}&nav=${job.nav}`, 20000);
            if (d.ok && d.points && d.points.length > 1) {
              r = slimRoute(d);
              planWps = [r.points[r.points.length - 1]];          // the depot = destination pin
              label = `${job.company} · ${job.city}`;
              // a newly taken job counts as "saved now" for picking the group route
              savedAt = plan && plan.jobKey === jobKey ? plan.savedAt : Math.max(savedAt, now);
            }
          }
        } catch { /* no road route: friends still get the waypoints */ }
        lastRoute = now;
        plan = { name: cfg.name, savedAt, gpsSavedAt, wps: planWps, jobKey, label, routeAt: now,
                 route: r ? r.points : null, steps: r ? r.steps : [], stops: r ? r.stops : [] };
        // very long routes: thin out until the message fits
        while (plan.route && JSON.stringify(plan).length > MAX_PLAN_BYTES && plan.route.length > 50) {
          plan.route = plan.route.filter((_, i) => i % 2 === 0 || i === plan.route.length - 1);
          plan.steps = []; plan.stops = [];
        }
        lastPlan = 0;
      }
      if (plan && now - lastPlan > PLAN_MS && gameOk) {
        if (await broadcast('plan', plan)) lastPlan = now;
      }
    } catch {
      routeOk = false;
    }
  }

  setInterval(tickPos, 250);
  setInterval(tickPlan, GPS_MS);
  tickPlan();

  // one status line
  setInterval(() => {
    const parts = [
      telemetryOk ? (gameOk ? 'เกม: ต่อแล้ว' : 'เกม: ยังไม่เปิด') : 'telemetry: ไม่ตอบ (เปิด Ets2Telemetry.exe)',
      routeOk ? `waypoint: ${plan ? plan.wps.length : 0}${plan && plan.route ? ' + เส้นทาง' : ''}` : 'route server: ไม่ตอบ',
      `ส่งแล้ว ${sent}`,
      errors ? `ผิดพลาด ${errors}${lastErr ? ` (${lastErr})` : ''}` : '',
    ].filter(Boolean);
    const line = `[${new Date().toLocaleTimeString()}] ${cfg.room} · ${parts.join(' · ')}`;
    if (process.stdout.isTTY) process.stdout.write('\r' + line.slice(0, (process.stdout.columns || 120) - 1).padEnd((process.stdout.columns || 120) - 1));
    else console.log(line);
  }, 2000);
})();

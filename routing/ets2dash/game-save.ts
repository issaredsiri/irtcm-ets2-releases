/*
 * Reads the in-game GPS waypoints from the newest ETS2 save (game.sii).
 *
 * The telemetry SDK does not expose the GPS route, but every save stores it:
 *   economy.stored_gps_ahead_waypoints  -> gps_waypoint_storage units { nav_node_position, direction }
 * Saves are encrypted (ScsC: AES-256-CBC + zlib) and binary (BSII); both are decoded here.
 * The game writes a save on quicksave (F5) and on every autosave, so the waypoints are as fresh
 * as the newest save.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

// Well-known key used by the game for save encryption (same as SII_Decrypt).
const KEY = Buffer.from(
  '2a5fcb1791d22fb60245b3d8369ed0b2c27371563fbf1f3c9edf6b11825a5d0a',
  'hex',
);

export type Waypoint = { x: number; z: number; direction?: string };
export type GpsState = {
  ok: boolean;
  file?: string;
  savedAt?: number; // ms epoch (file mtime)
  ahead: Waypoint[];
  behind: Waypoint[];
  error?: string;
};

// ---------- locating saves ----------
function regValue(key: string, name: string): string | undefined {
  try {
    const out = execFileSync('reg', ['query', key, '/v', name], { encoding: 'utf8', windowsHide: true });
    const m = new RegExp(`${name}\\s+REG_\\w+\\s+(.+)`).exec(out);
    return m ? m[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

function profileRoots(game: 'ets2' | 'ats'): string[] {
  const appId = game === 'ets2' ? '227300' : '270880';
  const folder = game === 'ets2' ? 'Euro Truck Simulator 2' : 'American Truck Simulator';
  const roots: string[] = [];
  if (process.env.ETS2_SAVE_DIR) roots.push(process.env.ETS2_SAVE_DIR);

  const docs = new Set<string>([path.join(os.homedir(), 'Documents')]);
  const personal = regValue('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders', 'Personal');
  if (personal) docs.add(personal);
  for (const d of docs) {
    roots.push(path.join(d, folder, 'profiles'), path.join(d, folder, 'steam_profiles'));
  }

  // Steam Cloud keeps the real saves in userdata/<account>/<appid>/remote/profiles
  const steam = new Set<string>(['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam']);
  const sp = regValue('HKCU\\Software\\Valve\\Steam', 'SteamPath');
  if (sp) steam.add(sp.replace(/\//g, '\\'));
  for (const s of steam) {
    const ud = path.join(s, 'userdata');
    if (!fs.existsSync(ud)) continue;
    for (const acc of fs.readdirSync(ud)) roots.push(path.join(ud, acc, appId, 'remote', 'profiles'));
  }
  return roots.filter(r => fs.existsSync(r));
}

let rootsCache: { game: string; at: number; roots: string[] } | undefined;
function newestSave(game: 'ets2' | 'ats'): { file: string; mtime: number } | undefined {
  if (!rootsCache || rootsCache.game !== game || Date.now() - rootsCache.at > 60_000) {
    rootsCache = { game, at: Date.now(), roots: profileRoots(game) };
  }
  let best: { file: string; mtime: number } | undefined;
  for (const root of rootsCache.roots) {
    let profiles: string[] = [];
    try { profiles = fs.readdirSync(root); } catch { continue; }
    for (const p of profiles) {
      const saveDir = path.join(root, p, 'save');
      let saves: string[] = [];
      try { saves = fs.readdirSync(saveDir); } catch { continue; }
      for (const s of saves) {
        const f = path.join(saveDir, s, 'game.sii');
        try {
          const m = fs.statSync(f).mtimeMs;
          if (!best || m > best.mtime) best = { file: f, mtime: m };
        } catch { /* no game.sii in this slot */ }
      }
    }
  }
  return best;
}

// ---------- decoding ----------
export function decryptSii(buf: Buffer): Buffer {
  const magic = buf.toString('latin1', 0, 4);
  if (magic !== 'ScsC') return buf; // already plain (g_save_format 2) or BSII
  const iv = buf.subarray(36, 52);
  const d = crypto.createDecipheriv('aes-256-cbc', KEY, iv);
  return zlib.inflateSync(Buffer.concat([d.update(buf.subarray(56)), d.final()]));
}

const CH = '0123456789abcdefghijklmnopqrstuvwxyz_';
function encStr(v: bigint): string {
  let s = '';
  while (v > 0n) {
    const i = Number(v % 38n);
    v /= 38n;
    if (i) s += CH[i - 1];
  }
  return s;
}

type Unit = { type: string; id: string; vals: Record<string, unknown> };

/** Minimal BSII reader. Only keeps units for which `keep(structName)` is true. */
export function parseBsii(b: Buffer, keep: (name: string) => boolean): Unit[] {
  let o = 0;
  const u8 = () => b[o++];
  const u32 = () => { const v = b.readUInt32LE(o); o += 4; return v; };
  const i32 = () => { const v = b.readInt32LE(o); o += 4; return v; };
  const f32 = () => { const v = b.readFloatLE(o); o += 4; return v; };
  const u64 = () => { const v = b.readBigUInt64LE(o); o += 8; return v; };
  const str = () => { const n = u32(); const s = b.toString('utf8', o, o + n); o += n; return s; };
  const id = () => {
    const n = u8();
    if (n === 0xff) return '_nameless.' + u64().toString(16);
    const parts: string[] = [];
    for (let i = 0; i < n; i++) parts.push(encStr(u64()));
    return parts.join('.') || 'null';
  };
  const vec = (n: number, f: () => number) => () => { const a: number[] = []; for (let i = 0; i < n; i++) a.push(f()); return a; };

  if (b.toString('latin1', 0, 4) !== 'BSII') throw new Error('not a BSII save');
  o = 4;
  const version = u32();
  const R: Record<number, () => unknown> = {
    0x01: str, 0x03: () => encStr(u64()), 0x05: f32, 0x07: vec(2, f32), 0x09: vec(3, f32),
    0x11: vec(3, i32), 0x17: vec(4, f32), 0x25: i32, 0x27: u32,
    0x29: () => { const v = b.readInt16LE(o); o += 2; return v; },
    0x2b: () => { const v = b.readUInt16LE(o); o += 2; return v; },
    0x2f: u32,
    0x31: () => { const v = b.readBigInt64LE(o); o += 8; return v; },
    0x33: u64, 0x35: u8, 0x39: id, 0x3b: id, 0x3d: id,
    0x19: () => {
      if (version === 1) return vec(8, f32)();
      const x = f32(), y = f32(), z = f32(), bias = i32(), q = vec(4, f32)();
      return { p: [x + (((bias & 0xfff) - 2048) << 9), y, z + ((((bias >> 12) & 0xfff) - 2048) << 9)], q };
    },
  };
  for (const k of [0x01, 0x03, 0x05, 0x07, 0x09, 0x11, 0x17, 0x19, 0x25, 0x27, 0x29, 0x2b, 0x31, 0x33, 0x35, 0x39, 0x3b, 0x3d]) {
    const f = R[k];
    R[k + 1] = () => { const n = u32(), a: unknown[] = []; for (let i = 0; i < n; i++) a.push(f()); return a; };
  }

  type Seg = { t: number; name: string; ord?: Record<number, string> };
  const structs = new Map<number, { name: string; segs: Seg[] }>();
  const units: Unit[] = [];
  while (o < b.length) {
    const type = u32();
    if (type === 0) {
      if (!u8()) break;
      const sid = u32(), name = str(), segs: Seg[] = [];
      for (;;) {
        const t = u32();
        if (!t) break;
        const seg: Seg = { t, name: str() };
        if (t === 0x37) {
          seg.ord = {};
          const n = u32();
          for (let i = 0; i < n; i++) { const k = u32(); seg.ord[k] = str(); }
        }
        segs.push(seg);
      }
      structs.set(sid, { name, segs });
      continue;
    }
    const s = structs.get(type);
    if (!s) throw new Error(`unknown structure ${type} at ${o}`);
    const uid = id(), vals: Record<string, unknown> = {};
    for (const seg of s.segs) {
      if (seg.t === 0x37) { vals[seg.name] = seg.ord![u32()]; continue; }
      const r = R[seg.t];
      if (!r) throw new Error(`unknown value type 0x${seg.t.toString(16)} (${s.name}.${seg.name})`);
      vals[seg.name] = r();
    }
    if (keep(s.name)) units.push({ type: s.name, id: uid, vals });
  }
  return units;
}

/** Plain-text saves (g_save_format "2"): just pull the same fields with regexes. */
function parseText(t: string): { ahead: Waypoint[]; behind: Waypoint[] } {
  const store = new Map<string, Waypoint>();
  const re = /gps_waypoint_storage\s*:\s*(\S+)\s*\{([^}]*)\}/g;
  for (let m; (m = re.exec(t)); ) {
    const pos = /nav_node_position:\s*\(([^)]*)\)/.exec(m[2]);
    if (!pos) continue;
    const [x, , z] = pos[1].split(',').map(v => Number(v.trim()));
    const dir = /direction:\s*(\w+)/.exec(m[2])?.[1];
    store.set(m[1], { x: x / 256, z: z / 256, direction: dir });
  }
  const list = (field: string) => {
    const out: Waypoint[] = [];
    const r = new RegExp(`${field}\\[\\d+\\]:\\s*(\\S+)`, 'g');
    for (let m; (m = r.exec(t)); ) { const w = store.get(m[1]); if (w) out.push(w); }
    return out;
  };
  return { ahead: list('stored_gps_ahead_waypoints'), behind: list('stored_gps_behind_waypoints') };
}

export function readGps(file: string): { ahead: Waypoint[]; behind: Waypoint[] } {
  const raw = decryptSii(fs.readFileSync(file));
  if (raw.toString('latin1', 0, 4) === 'SiiN') return parseText(raw.toString('utf8'));
  const units = parseBsii(raw, n => n === 'economy' || n === 'gps_waypoint_storage');
  const store = new Map<string, Waypoint>();
  let economy: Unit | undefined;
  for (const u of units) {
    if (u.type === 'economy') economy = u;
    else {
      const p = u.vals.nav_node_position as number[] | undefined;
      // nav_node_position is fixed point (1/256 world unit)
      if (p) store.set(u.id, { x: p[0] / 256, z: p[2] / 256, direction: u.vals.direction as string });
    }
  }
  const pick = (k: string) =>
    ((economy?.vals[k] as string[] | undefined) ?? []).map(i => store.get(i)).filter((w): w is Waypoint => !!w);
  return { ahead: pick('stored_gps_ahead_waypoints'), behind: pick('stored_gps_behind_waypoints') };
}

// ---------- cached state for the http endpoint ----------
let state: GpsState = { ok: false, ahead: [], behind: [], error: 'not read yet' };
let stateKey = '';

export function gpsState(game: 'ets2' | 'ats' = 'ets2'): GpsState {
  const s = newestSave(game);
  if (!s) return { ok: false, ahead: [], behind: [], error: 'no save found' };
  const key = s.file + '|' + s.mtime;
  if (key !== stateKey) {
    stateKey = key;
    try {
      const g = readGps(s.file);
      state = { ok: true, file: s.file, savedAt: Math.round(s.mtime), ...g };
      console.log(`gps: ${g.ahead.length} waypoint(s) from ${path.basename(path.dirname(s.file))}`);
    } catch (e) {
      state = { ok: false, file: s.file, savedAt: Math.round(s.mtime), ahead: [], behind: [], error: String(e) };
    }
  }
  return state;
}

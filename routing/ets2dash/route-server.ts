/*
 * ets2-telemetry-server route server.
 *
 * Loads the ETS2 road graph produced by build-route-data.cmd and answers
 * GET /route requests from the mobile dashboard with a road-following route
 * (game coordinates) plus turn-by-turn steps.
 *
 *   GET /health
 *   GET /route?x=&y=&z=&h=            truck position + heading (0..1, CCW from north)
 *             &city=&company=&nav=    job destination (+ game nav distance in m to pick the right depot)
 *             | &tx=&tz=              or an arbitrary map point (pin)
 *             | &via=x,z;x,z;...      or a chain of waypoints (in-game GPS waypoints from the save)
 *   GET /gps                          in-game GPS waypoints read from the newest save (see game-save.ts)
 *
 * Built on TruckSim Maps (https://github.com/truckermudgeon/maps, GPL-3.0).
 */
import polyline from '@mapbox/polyline';
import { fromDir } from '@truckermudgeon/io';
import {
  Ets2SelectableDlcs,
  toEts2DlcGuards,
} from '@truckermudgeon/map/constants';
import { fromWgs84ToEts2Coords } from '@truckermudgeon/map/projections';
import type { Context, Route, RouteKey } from '@truckermudgeon/map/routing';
import { findRouteFromKey } from '@truckermudgeon/map/routing';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { generateRoutes } from '../packages/apis/navigation/domain/actor/generate-routes';
import { readGraphAndMapData } from '../packages/apis/navigation/infra/lookups/graph-and-map';
import { gpsState } from './game-save';

const PORT = Number(process.env.ROUTE_PORT ?? 25556);
const DATA_DIR =
  // started from routing/maps (see start-route-server.cmd)
  process.env.ROUTE_DATA ?? path.resolve(process.cwd(), '../data/europe');

console.log(`loading route data from ${DATA_DIR} (takes a while)...`);
const t0 = Date.now();
const graphAndMapData = readGraphAndMapData(fromDir(DATA_DIR), 'europe');
const { tsMapData, graphData } = graphAndMapData;
const context: Context = {
  nodeLUT: tsMapData.nodes,
  graph: graphData.graph,
  enabledDlcGuards: toEts2DlcGuards(Ets2SelectableDlcs),
  map: 'europe',
};

// --- vector road map (so the phone map matches the installed game version) ---
// Each line is [code, x0, z0, x1, z1, ...] with code = class + 10 * layer.
// Classes: 0 = motorway, 1 = local road, 2 = junction / prefab curve, 3 = expressway (trunk).
// Layer = elevation bucket (4 world units), so the phone can draw bridges over the roads they cross.
const CELL = 2000; // world units
const LAYER_H = 4;
const roadCells = new Map<string, number[][]>();
{
  const t = Date.now();
  let lineCount = 0;
  // class from the lane types of a road look (motorways are often two one-way roads of 2 lanes each)
  const lookClass = (token: string): number => {
    const look = tsMapData.roadLooks.get(token);
    const lanes = look ? [...look.lanesLeft, ...look.lanesRight] : [];
    if (lanes.some(l => l.includes('.motorway'))) return 0;
    if (lanes.some(l => l.includes('.expressway'))) return 3;
    if (lanes.length && lanes.every(l => l.includes('.rail.') || l.startsWith('traffic_lane.no_vehicles'))) return -1;
    return 1;
  };
  type AnyItem = { type: number; hidden?: true; roadLookToken?: string; startNodeUid?: bigint; endNodeUid?: bigint; nodeUids?: readonly bigint[] };
  const entries = graphAndMapData.roadAndPrefabRTree.all();
  // node -> best class of the roads touching it (used to classify prefab curves)
  const rank = (c: number) => (c === 0 ? 3 : c === 3 ? 2 : c === 1 ? 1 : 0);
  const nodeClass = new Map<bigint, number>();
  for (const e of entries) {
    const it = e.item as AnyItem;
    if (it.type !== 3) continue;
    const c = lookClass(it.roadLookToken!);
    for (const n of [it.startNodeUid!, it.endNodeUid!]) {
      const old = nodeClass.get(n);
      if (old === undefined || rank(c) > rank(old)) nodeClass.set(n, c);
    }
  }
  const nodeZ = (uid: bigint) => tsMapData.nodes.get(uid)?.z;
  for (const entry of entries) {
    const item = entry.item as AnyItem;
    if (item.hidden) continue;
    let roadCls = 2;
    let roadZ: number | undefined;
    let prefabNodes: { x: number; y: number; z: number; cls: number }[] = [];
    if (item.type === 3 /* ItemType.Road */) {
      roadCls = lookClass(item.roadLookToken!);
      if (roadCls < 0) continue;
      const a = nodeZ(item.startNodeUid!), b = nodeZ(item.endNodeUid!);
      roadZ = a !== undefined && b !== undefined ? (a + b) / 2 : a ?? b;
    } else {
      prefabNodes = (item.nodeUids ?? []).flatMap(uid => {
        const n = tsMapData.nodes.get(uid);
        return n ? [{ x: n.x, y: n.y, z: n.z, cls: nodeClass.get(uid) ?? 1 }] : [];
      });
    }
    for (const line of entry.lines) {
      if (line.length < 2) continue;
      const pts = line.map(ll => fromWgs84ToEts2Coords([ll[0], ll[1]]));
      let cls = roadCls;
      let z = roadZ;
      if (item.type !== 3) {
        // prefab curve: motorway if both of its ends join motorway roads (a ramp joins a smaller road)
        const end = (p: number[]) => {
          let best: (typeof prefabNodes)[number] | undefined;
          let bd = 6;
          for (const n of prefabNodes) {
            const d = Math.hypot(n.x - p[0], n.y - p[1]);
            if (d < bd) { bd = d; best = n; }
          }
          return best;
        };
        const a = end(pts[0]), b = end(pts[pts.length - 1]);
        const ca = a?.cls ?? b?.cls, cb = b?.cls ?? a?.cls;
        cls = ca === 0 && cb === 0 ? 0 : (ca === 0 || ca === 3) && (cb === 0 || cb === 3) ? 3 : 2;
        const zs = [a?.z, b?.z].filter((v): v is number => v !== undefined);
        z = zs.length ? zs.reduce((s, v) => s + v, 0) / zs.length : prefabNodes[0]?.z;
      }
      const layer = Math.max(0, Math.min(200, Math.round(((z ?? 0) + 400) / LAYER_H)));
      const flat: number[] = [cls + 10 * layer];
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (const [x, y] of pts) {
        const rx = Math.round(x), rz = Math.round(y);
        const n = flat.length;
        if (n > 2 && flat[n - 2] === rx && flat[n - 1] === rz) continue;
        flat.push(rx, rz);
        minX = Math.min(minX, rx); maxX = Math.max(maxX, rx);
        minZ = Math.min(minZ, rz); maxZ = Math.max(maxZ, rz);
      }
      if (flat.length < 5) continue;
      lineCount++;
      for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) {
        for (let cz = Math.floor(minZ / CELL); cz <= Math.floor(maxZ / CELL); cz++) {
          const k = `${cx},${cz}`;
          let arr = roadCells.get(k);
          if (!arr) roadCells.set(k, (arr = []));
          arr.push(flat);
        }
      }
    }
  }
  console.log(`indexed ${lineCount} road lines into ${roadCells.size} cells in ${Date.now() - t} ms`);
}

// lod 0: everything in one CELL, full detail. lod 1: everything, decimated.
// lod 2: motorways only, 4x4 cells merged, decimated.
const roadsCache = new Map<string, string>();
function roadsJson(cx: number, cz: number, lod: number): string {
  const key = `${lod}|${cx},${cz}`;
  const hit = roadsCache.get(key);
  if (hit) return hit;
  const span = lod === 2 ? 4 : 1;
  const step = lod === 0 ? 1 : lod === 1 ? 2 : 4;
  const seen = new Set<number[]>();
  const lines: number[][] = [];
  for (let x = cx * span; x < (cx + 1) * span; x++) {
    for (let z = cz * span; z < (cz + 1) * span; z++) {
      for (const l of roadCells.get(`${x},${z}`) ?? []) {
        if (seen.has(l)) continue;
        seen.add(l);
        // lod 1 keeps intersection/prefab curves too: motorways run through prefab pieces (bridges, tolls)
        if (lod === 2 && l[0] % 10 !== 0 && l[0] % 10 !== 3) continue;
        if (step === 1) {
          lines.push(l);
          continue;
        }
        const pts = (l.length - 1) / 2;
        const out = [l[0]];
        for (let i = 0; i < pts; i++) {
          if (i % step === 0 || i === pts - 1) out.push(l[1 + i * 2], l[2 + i * 2]);
        }
        lines.push(out);
      }
    }
  }
  const json = JSON.stringify({ ok: true, cell: span * CELL, lines });
  roadsCache.set(key, json);
  if (roadsCache.size > 3000) roadsCache.delete(roadsCache.keys().next().value!);
  return json;
}

// --- map POIs (fuel, parking, service, companies, road shields...) with the game's own icons ---
type PoiRow = [string, number, number, string]; // [icon, x, z, type]
const poiCells = new Map<string, PoiRow[]>();
{
  const file = path.join(DATA_DIR, 'europe-pois.json');
  let count = 0;
  if (fs.existsSync(file)) {
    const pois = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      x: number;
      y: number;
      type: string;
      icon?: string;
    }[];
    for (const p of pois) {
      if (!p.icon) continue;
      const k = `${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`;
      let arr = poiCells.get(k);
      if (!arr) poiCells.set(k, (arr = []));
      arr.push([p.icon, Math.round(p.x), Math.round(p.y), p.type]);
      count++;
    }
  }
  console.log(`indexed ${count} POIs`);
}
const ICON_DIR = path.join(DATA_DIR, 'icons');

// lod 1 (zoomed-out phone map): 4x4 cells merged, only facilities (fuel, service, ...) and ferry/train
const poiBig = new Map<string, string>();
function poisJson(cx: number, cz: number, lod: number): string {
  if (lod !== 1) return JSON.stringify({ ok: true, pois: poiCells.get(`${cx},${cz}`) ?? [] });
  const key = `${cx},${cz}`;
  let hit = poiBig.get(key);
  if (hit) return hit;
  const out: PoiRow[] = [];
  for (let x = cx * 4; x < cx * 4 + 4; x++) {
    for (let z = cz * 4; z < cz * 4 + 4; z++) {
      for (const p of poiCells.get(`${x},${z}`) ?? []) {
        if ((p[3] === 'facility' && p[0] !== 'parking_ico') || p[3] === 'ferry' || p[3] === 'train') out.push(p);
      }
    }
  }
  hit = JSON.stringify({ ok: true, pois: out });
  poiBig.set(key, hit);
  return hit;
}

// --- route cache + routing service -------------------------------------------
const cache = new Map<RouteKey, Route>();
const routing = {
  findRouteFromKey(key: RouteKey): Promise<Route> {
    let r = cache.get(key);
    if (!r) {
      r = findRouteFromKey(key, context);
      cache.set(key, r);
      if (cache.size > 500) cache.delete(cache.keys().next().value!);
    }
    return Promise.resolve(r);
  },
};
const silentSink = { publish: () => undefined };

// --- destination lookups -------------------------------------------------------
const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');

const cityTokensByName = new Map<string, string[]>();
for (const city of tsMapData.cities.values()) {
  for (const n of new Set([city.name, city.nameLocalized].filter(Boolean))) {
    const k = norm(n);
    cityTokensByName.set(k, [...(cityTokensByName.get(k) ?? []), city.token]);
  }
}
const companyTokensByName = new Map<string, string[]>();
for (const def of tsMapData.companyDefs.values()) {
  const k = norm(def.name);
  companyTokensByName.set(k, [...(companyTokensByName.get(k) ?? []), def.token]);
}
const graphNodeUids = [...graphData.graph.keys()];

// The telemetry reports city names in the game's display language/spelling
// (e.g. "Antwerpen"), while parsed data may say "Antwerp" (token "antwerp").
function cityMatches(query: string, cityToken: string): boolean {
  const q = norm(query);
  const city = tsMapData.cities.get(cityToken);
  const names = [cityToken, city?.name ?? '', city?.nameLocalized ?? '']
    .map(norm)
    .filter(Boolean);
  return names.some(
    n => n === q || (Math.min(n.length, q.length) >= 4 && (q.startsWith(n) || n.startsWith(q))),
  );
}

function findCompanyNodes(
  city: string,
  company: string,
  truckPos: [number, number],
  nav: number,
): bigint[] {
  const companyTokens = new Set(companyTokensByName.get(norm(company)) ?? []);
  const depots = [...tsMapData.companies.values()].filter(
    c => companyTokens.has(c.token) && graphData.graph.has(c.nodeUid),
  );
  const inCity = depots.filter(c => cityMatches(city, c.cityToken));
  if (inCity.length) return inCity.map(c => c.nodeUid);

  // City name not recognised: take the company's depots whose straight-line
  // distance best fits the game's nav distance (world units * ~19 map scale,
  // roads ~1.3x longer than straight).
  const fit = (c: (typeof depots)[number]) => {
    const n = tsMapData.nodes.get(c.nodeUid);
    if (!n || !(nav > 0)) return 0;
    return Math.abs(Math.hypot(n.x - truckPos[0], n.y - truckPos[1]) * 19 * 1.3 - nav);
  };
  return depots
    .sort((a, b) => fit(a) - fit(b))
    .slice(0, 4)
    .map(c => c.nodeUid);
}

function nearestGraphNode(x: number, z: number): bigint | undefined {
  let best: bigint | undefined;
  let bestD = Infinity;
  for (const uid of graphNodeUids) {
    const n = tsMapData.nodes.get(uid);
    if (!n) continue;
    const d = (n.x - x) ** 2 + (n.y - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = uid;
    }
  }
  return best;
}

// --- route -> mobile-friendly JSON ---------------------------------------------
type Pt = [number, number];
const toGame = (lonLat: number[]): Pt => {
  const [x, z] = fromWgs84ToEts2Coords([lonLat[0], lonLat[1]]);
  return [Math.round(x * 10) / 10, Math.round(z * 10) / 10];
};

function toMobile(route: Awaited<ReturnType<typeof generateRoutes>>[number]) {
  const points: Pt[] = [];
  const steps: {
    dist: number;
    dir: number;
    text?: string;
    exit?: number;
    at: Pt;
    idx: number;
  }[] = [];
  for (const seg of route.segments) {
    for (const step of seg.steps) {
      const m = step.maneuver as {
        direction: number;
        lonLat: number[];
        banner?: { text?: string };
        exitNumber?: number;
      };
      steps.push({
        dist: Math.round(step.distanceMeters),
        dir: m.direction,
        text: m.banner?.text,
        exit: m.exitNumber,
        at: toGame(m.lonLat),
        idx: points.length,
      });
      // polyline.encode was called with [lon, lat] pairs, so decode returns them in the same order
      for (const p of polyline.decode(step.geometry)) {
        const g = toGame(p);
        const last = points.at(-1);
        if (!last || last[0] !== g[0] || last[1] !== g[1]) points.push(g);
      }
    }
  }
  return {
    distance: Math.round(route.distanceMeters),
    duration: Math.round(route.duration),
    points,
    steps,
  };
}

type Truck = {
  position: { X: number; Y: number; Z: number };
  orientation: { heading: number };
};
type GeneratedRoute = Awaited<ReturnType<typeof generateRoutes>>[number];

async function generateOne(nodeUid: bigint, truck: Truck) {
  try {
    const [r] = await generateRoutes(nodeUid, ['fastest'], {
      graphAndMapData: graphAndMapData as never,
      routing: routing as never,
      truck: truck as never,
      domainEventSink: silentSink,
    });
    return r;
  } catch (e) {
    console.warn('route failed', nodeUid.toString(16), String(e));
    return undefined;
  }
}

/**
 * How well the start of a route agrees with the truck's heading:
 * +1 = route leaves straight ahead, -1 = route starts by going backwards.
 */
function startAlignment(r: GeneratedRoute, truck: Truck): number {
  const pts = toMobile(r).points;
  const tx = truck.position.X;
  const tz = truck.position.Z;
  let near = 0;
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = (pts[i][0] - tx) ** 2 + (pts[i][1] - tz) ** 2;
    if (d < best) {
      best = d;
      near = i;
    }
  }
  // first point ~60 world units further along the route
  let j = near;
  while (j < pts.length - 1 && Math.hypot(pts[j][0] - pts[near][0], pts[j][1] - pts[near][1]) < 60) j++;
  const dx = pts[j][0] - pts[near][0];
  const dz = pts[j][1] - pts[near][1];
  const len = Math.hypot(dx, dz);
  if (len < 1) return 1;
  // game heading: 0 = north (-z), counter-clockwise, 0.25 = west (-x)
  const a = truck.orientation.heading * Math.PI * 2;
  return (dx * -Math.sin(a) + dz * -Math.cos(a)) / len;
}

/**
 * TruckSim Maps picks the start node/direction itself and sometimes guesses
 * wrong (e.g. inside an intersection prefab), giving a route that starts behind
 * the truck. If so, retry from points slightly ahead of the truck along its heading.
 */
async function routeFacingForward(nodeUid: bigint, truck: Truck) {
  const first = await generateOne(nodeUid, truck);
  if (!first || startAlignment(first, truck) > -0.2) return first;
  const a = truck.orientation.heading * Math.PI * 2;
  let best = first;
  let bestScore = startAlignment(first, truck);
  for (const ahead of [25, 50, 90, 150]) {
    const moved = {
      ...truck,
      position: {
        ...truck.position,
        X: truck.position.X - Math.sin(a) * ahead,
        Z: truck.position.Z - Math.cos(a) * ahead,
      },
    };
    const r = await generateOne(nodeUid, moved);
    if (!r) continue;
    const score = startAlignment(r, truck);
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
    if (score > 0.3) break;
  }
  return best;
}

async function route(q: URLSearchParams) {
  const num = (k: string) => {
    const v = Number(q.get(k));
    if (!Number.isFinite(v)) throw new Error(`bad or missing param ${k}`);
    return v;
  };
  const truck = {
    position: { X: num('x'), Y: Number(q.get('y') ?? 0), Z: num('z') },
    orientation: { heading: num('h') },
    speed: { value: 0, kph: 0, mph: 0 },
    acceleration: {
      linearVelocity: { X: 0, Y: 0, Z: 0 },
      linearAcceleration: { X: 0, Y: 0, Z: 0 },
      angularVelocity: { X: 0, Y: 0, Z: 0 },
      angularAcceleration: { X: 0, Y: 0, Z: 0 },
    },
  };

  if (q.get('via')) return routeVia(q.get('via')!, truck);

  let candidates: bigint[];
  if (q.get('company') && q.get('city')) {
    candidates = findCompanyNodes(
      q.get('city')!,
      q.get('company')!,
      [truck.position.X, truck.position.Z],
      Number(q.get('nav') ?? 0),
    );
    if (!candidates.length) return { ok: false, error: 'destination not found' };
  } else {
    const n = nearestGraphNode(num('tx'), num('tz'));
    if (n == null) return { ok: false, error: 'no road near point' };
    candidates = [n];
  }

  const nav = Number(q.get('nav') ?? 0);
  const results = [];
  for (const nodeUid of candidates.slice(0, 6)) {
    const r = await routeFacingForward(nodeUid, truck);
    if (r) results.push(r);
  }
  if (!results.length) return { ok: false, error: 'no route found' };

  // several depots of the same company in one city: pick the one matching the game's own nav distance.
  // Route distances are world units; the game's nav distance is shown at map scale (~1:19 in ETS2).
  const MAP_SCALE = 19;
  results.sort((a, b) =>
    nav > 0
      ? Math.abs(a.distanceMeters * MAP_SCALE - nav) -
        Math.abs(b.distanceMeters * MAP_SCALE - nav)
      : a.distanceMeters - b.distanceMeters,
  );
  return { ok: true, ...toMobile(results[0]) };
}

/** Route through a chain of waypoints: truck -> w1 -> w2 -> ... (one leg per waypoint). */
async function routeVia(via: string, truck: Truck) {
  const wps = via
    .split(';')
    .map(s => s.split(',').map(Number))
    .filter(p => p.length === 2 && p.every(Number.isFinite))
    .slice(0, 12);
  if (!wps.length) return { ok: false, error: 'bad via' };
  const points: Pt[] = [];
  const steps: ReturnType<typeof toMobile>['steps'] = [];
  const stops: { x: number; z: number; idx: number }[] = [];
  let distance = 0;
  let duration = 0;
  let from = truck;
  for (let i = 0; i < wps.length; i++) {
    const n = nearestGraphNode(wps[i][0], wps[i][1]);
    if (n == null) return { ok: false, error: 'no road near waypoint ' + (i + 1) };
    const r = i === 0 ? await routeFacingForward(n, from) : await generateOne(n, from);
    if (!r) return { ok: false, error: 'no route to waypoint ' + (i + 1) };
    const m = toMobile(r);
    const base = points.length;
    for (const st of m.steps) {
      // intermediate arrivals become "waypoint" steps (-5) so the phone can tell them apart from the final one
      const dir = st.dir === -3 && i < wps.length - 1 ? -5 : st.dir;
      if (i > 0 && st.dir === -2) continue; // DEPART of follow-up legs
      steps.push({ ...st, dir, idx: st.idx + base });
    }
    for (const p of m.points) {
      const last = points.at(-1);
      if (!last || last[0] !== p[0] || last[1] !== p[1]) points.push(p);
    }
    stops.push({ x: wps[i][0], z: wps[i][1], idx: points.length - 1 });
    distance += m.distance;
    duration += m.duration;
    // next leg starts at the end of this one, facing along its last stretch
    const end = points.at(-1)!;
    let j = points.length - 2;
    while (j > 0 && Math.hypot(points[j][0] - end[0], points[j][1] - end[1]) < 20) j--;
    const dx = end[0] - points[Math.max(0, j)][0];
    const dz = end[1] - points[Math.max(0, j)][1];
    // game heading: 0 = north (-z), counter-clockwise; forward = (-sin a, -cos a)
    let h = Math.atan2(-dx, -dz) / (Math.PI * 2);
    if (h < 0) h += 1;
    from = { ...truck, position: { X: end[0], Y: truck.position.Y, Z: end[1] }, orientation: { heading: h } };
  }
  return { ok: true, distance, duration, points, steps, stops };
}

// --- http ----------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const send = (code: number, body: unknown) => {
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(body));
  };
  try {
    if (url.pathname === '/health') return send(200, { ok: true, map: 'europe', roads: true, gps: true, cell: CELL });
    if (url.pathname === '/gps') return send(200, gpsState('ets2'));
    if (url.pathname === '/pois') {
      const cx = Number(url.searchParams.get('cx'));
      const cz = Number(url.searchParams.get('cz'));
      if (!Number.isInteger(cx) || !Number.isInteger(cz)) return send(400, { ok: false, error: 'cx/cz required' });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'max-age=3600',
      });
      return res.end(poisJson(cx, cz, Number(url.searchParams.get('lod') ?? 0)));
    }
    const icon = /^\/icons\/([a-z0-9_]+)\.png$/i.exec(url.pathname);
    if (icon) {
      const file = path.join(ICON_DIR, `${icon[1]}.png`);
      if (!fs.existsSync(file)) return send(404, { ok: false, error: 'no such icon' });
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'max-age=86400',
      });
      return res.end(fs.readFileSync(file));
    }
    if (url.pathname === '/roads') {
      const cx = Number(url.searchParams.get('cx'));
      const cz = Number(url.searchParams.get('cz'));
      const lod = Math.max(0, Math.min(2, Number(url.searchParams.get('lod') ?? 0)));
      if (!Number.isInteger(cx) || !Number.isInteger(cz)) return send(400, { ok: false, error: 'cx/cz required' });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'max-age=3600',
      });
      return res.end(roadsJson(cx, cz, lod));
    }
    if (url.pathname === '/route') {
      const start = Date.now();
      const out = await route(url.searchParams);
      console.log(`route ${url.search} -> ${out.ok ? 'ok' : out.error} (${Date.now() - start} ms)`);
      return send(out.ok ? 200 : 404, out);
    }
    send(404, { ok: false, error: 'not found' });
  } catch (e) {
    send(400, { ok: false, error: String(e instanceof Error ? e.message : e) });
  }
});

// --- static tile export (EXPORT_TILES=<dir>): same JSON as /roads, /pois and /icons, as files ---
// Lets the dashboard draw game roads when opened over https (Vercel), where it cannot call this
// server (mixed content). Layout: roads/<lod>/<cx>_<cz>.json, pois/<lod>/<cx>_<cz>.json,
// icons/<name>.png, plus index.json listing which cells exist (so the page never asks for a 404).
function exportTiles(outDir: string) {
  const t = Date.now();
  const write = (rel: string, body: string | Buffer) => {
    const file = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  const big = (keys: Iterable<string>) => {
    const out = new Set<string>();
    for (const k of keys) {
      const [x, z] = k.split(',').map(Number);
      out.add(`${Math.floor(x / 4)},${Math.floor(z / 4)}`);
    }
    return [...out];
  };
  const index: Record<string, string[]> = { r0: [], r1: [], r2: [], p0: [], p1: [] };
  let bytes = 0;
  const emit = (kind: 'roads' | 'pois', lod: number, key: string, json: string) => {
    const empty = kind === 'roads' ? json.endsWith('"lines":[]}') : json.endsWith('"pois":[]}');
    if (empty) return;
    const [x, z] = key.split(',');
    write(`${kind}/${lod}/${x}_${z}.json`, json);
    bytes += json.length;
    index[(kind === 'roads' ? 'r' : 'p') + lod].push(key);
  };
  for (const k of roadCells.keys()) {
    const [x, z] = k.split(',').map(Number);
    emit('roads', 0, k, roadsJson(x, z, 0));
    emit('roads', 1, k, roadsJson(x, z, 1));
  }
  for (const k of big(roadCells.keys())) {
    const [x, z] = k.split(',').map(Number);
    emit('roads', 2, k, roadsJson(x, z, 2));
  }
  const icons = new Set<string>();
  for (const [k, rows] of poiCells) {
    const [x, z] = k.split(',').map(Number);
    rows.forEach(r => icons.add(r[0]));
    emit('pois', 0, k, poisJson(x, z, 0));
  }
  for (const k of big(poiCells.keys())) {
    const [x, z] = k.split(',').map(Number);
    emit('pois', 1, k, poisJson(x, z, 1));
  }
  for (const name of icons) {
    const file = path.join(ICON_DIR, `${name}.png`);
    if (/^[a-z0-9_]+$/i.test(name) && fs.existsSync(file)) write(`icons/${name}.png`, fs.readFileSync(file));
  }
  write('index.json', JSON.stringify({ ok: true, map: 'europe', cell: CELL, builtAt: new Date().toISOString(), cells: index }));
  console.log(`exported tiles to ${outDir}: ${(bytes / 1e6).toFixed(1)} MB JSON, ${icons.size} icons in ${Date.now() - t} ms`);
}
if (process.env.EXPORT_TILES) {
  exportTiles(path.resolve(process.env.EXPORT_TILES));
  process.exit(0);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`route data loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log(`route server listening on http://0.0.0.0:${PORT}`);
});

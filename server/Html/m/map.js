/*
 * Lightweight canvas map for ETS2 / ATS.
 * Tiles: TsMap2 tile sets (https://github.com/Unicor-p/SCS_Map_Tiles), whose tile grid
 * covers the square extent [x1, y1, x2, y2] given in game coordinates (x = east, z = south).
 * Looks for local tiles at ./map/<game>/ first, then falls back to the remote collection.
 */
(function () {
  'use strict';

  var REMOTE = 'https://raw.githubusercontent.com/Unicor-p/SCS_Map_Tiles/master/{game}/latest/';
  var LOCAL = 'map/{game}/';
  var ATS_MAKES = /kenworth|peterbilt|freightliner|western star|mack|international|intl/i;
  var MAX_OVERZOOM = 2;     // allow zooming 2 levels past the deepest tiles
  var TRAIL_MAX = 600;
  var CACHE_MAX = 400;

  var canvas, ctx, wrap;
  var active = false, rafId = 0;
  var info = null, base = null, game = null, gameOverride = null, loadingGame = null;
  var tiles = {}, tileOrder = [];
  var view = { x: 0, z: 0, zoom: 6, rot: 0 };       // what is drawn
  var target = { x: 0, z: 0, heading: 0, speed: 0, has: false };
  // what is drawn for the truck: dead-reckoned from the last sample + velocity, then eased (no 10 Hz stepping)
  var pos = { x: 0, z: 0, heading: 0 }, samp = null, vel = { x: 0, z: 0, h: 0 }, snapFollow = true;
  var sampGap = 0.1;   // seconds between samples: 0.1 from local telemetry, ~1 from the room
  function wrap1(h) { return h - Math.floor(h); }
  function onSample(x, z, h) {
    var now = performance.now();
    if (!samp || Math.hypot(x - samp.x, z - samp.z) > 500) {
      // first sample or teleport/ferry: jump
      pos.x = x; pos.z = z; pos.heading = h; vel = { x: 0, z: 0, h: 0 };
    } else {
      var dt = (now - samp.t) / 1000;
      if (dt > 0.02 && dt < 3) sampGap = sampGap * 0.7 + dt * 0.3;
      if (dt > 0.02 && dt < 3) {
        var dh = h - samp.h; dh -= Math.round(dh);
        vel.x = vel.x * 0.4 + (x - samp.x) / dt * 0.6;
        vel.z = vel.z * 0.4 + (z - samp.z) / dt * 0.6;
        vel.h = vel.h * 0.4 + dh / dt * 0.6;
      }
    }
    samp = { x: x, z: z, h: h, t: now };
  }
  function advancePos(dt) {
    if (!samp) return;
    // predict up to a bit past the usual gap between samples (longer for 1/s room updates)
    var ahead = Math.min(Math.max(0.3, Math.min(2, sampGap * 1.3)), (performance.now() - samp.t) / 1000);
    var px = samp.x + vel.x * ahead, pz = samp.z + vel.z * ahead, ph = samp.h + vel.h * ahead;
    var k = ease(dt, 90);
    pos.x += (px - pos.x) * k;
    pos.z += (pz - pos.z) * k;
    var d = ph - pos.heading; d -= Math.round(d);
    pos.heading = wrap1(pos.heading + d * k);
  }
  var follow = true, headingUp = true, autoZoom = true;
  var trail = [];
  var statusEl, compassEl, recenterEl, gameEl, noticeEl, destEl, viaEl;
  var DEMO = /[?&]demo\b/.test(location.search);

  // Google Maps-like palettes; 'auto' follows the in-game clock
  var THEMES = {
    day: { bg: '#eef0f2', road: '#ffffff', roadCase: '#cfd3d9', mw: '#fdd77c', mwCase: '#e3a535', tk: '#fff1c2', tkCase: '#e8c46a', route: '#1a73e8', routeCase: '#1558c0',
           routeDone: 'rgba(95,99,104,.35)', label: '#3c4043', halo: 'rgba(255,255,255,.95)', pill: '#ffffff', pillText: '#202124', truck: '#1a73e8' },
    night: { bg: '#1b222c', road: '#3b4451', roadCase: '#262d38', mw: '#8f7346', mwCase: '#5a4628', tk: '#6b604c', tkCase: '#4a4133', route: '#4d90fe', routeCase: '#1c4fa5',
             routeDone: 'rgba(200,210,220,.25)', label: '#c9ced6', halo: 'rgba(20,26,34,.92)', pill: '#2b323d', pillText: '#e8eaed', truck: '#4d90fe' }
  };
  var themeMode = 'auto', gameHour = 12, T = THEMES.day;
  function applyTheme() {
    var night = themeMode === 'night' || (themeMode === 'auto' && (gameHour >= 20 || gameHour < 6));
    T = night ? THEMES.night : THEMES.day;
    if (wrap) wrap.classList.toggle('night', night);
  }

  function storeGet(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
  function storeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  // ---------- tile set loading ----------
  function loadInfo(g) {
    if (loadingGame === g) return;
    loadingGame = g;
    info = null; tiles = {}; tileOrder = []; trail = [];
    setStatus('Loading ' + g.toUpperCase() + ' map…');
    var local = LOCAL.replace('{game}', g), remote = REMOTE.replace('{game}', g);
    fetchJson(local + 'TileMapInfo.json')
      .then(function (j) { return { j: j, base: local }; })
      .catch(function () { return fetchJson(remote + 'TileMapInfo.json').then(function (j) { return { j: j, base: remote }; }); })
      .then(function (r) {
        if (loadingGame !== g) return;
        info = r.j.map; base = r.base; game = g;
        setStatus('');
        gameEl.textContent = g.toUpperCase();
      })
      .catch(function () {
        if (loadingGame !== g) return;
        if (g === 'ets2') {
          // offline: keep the map working with roads from the PC route server (no tile images)
          info = { x1: -94621.8047, x2: 79370.13, y1: -80209.1641, y2: 93782.77, tileSize: 512, minZoom: 0, maxZoom: 8 };
          base = 'about:blank#'; game = g; gameEl.textContent = 'ETS2';
          setStatus('');
          return;
        }
        loadingGame = null;
        setStatus('Map tiles unavailable — phone needs internet, or put tiles in server/Html/m/map/' + g + '/');
      });
  }
  function fetchJson(url) {
    return fetch(url, { cache: 'force-cache' }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
  }

  function getTile(z, x, y) {
    var key = z + '/' + x + '/' + y, t = tiles[key];
    if (t) return t;
    t = tiles[key] = { img: new Image(), ok: false, bad: false };
    t.img.onload = function () { t.ok = true; };
    t.img.onerror = function () { t.bad = true; };
    t.img.src = base + 'Tiles/' + key + '.png';
    tileOrder.push(key);
    if (tileOrder.length > CACHE_MAX) {
      var old = tileOrder.shift();
      if (tiles[old]) { tiles[old].img.src = ''; delete tiles[old]; }
    }
    return t;
  }

  // ---------- drawing ----------
  function size() {
    var dpr = window.devicePixelRatio || 1, r = wrap.getBoundingClientRect();
    var w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    return { w: r.width, h: r.height, dpr: dpr };
  }

  function extentSize() { return info.x2 - info.x1; }
  function pxPerUnit(zoom) { return info.tileSize * Math.pow(2, zoom) / extentSize(); }

  // screen anchor of the view center (truck sits lower when heading-up so you see ahead)
  // landscape: the trip panel floats on the left, so centre the truck in the area right of it
  var sheetEl = null;
  function anchor(s) {
    var side = s.w > s.h && s.w >= 560 && sheetEl ? sheetEl.offsetLeft + sheetEl.offsetWidth : 0;
    return { x: side + (s.w - side) / 2, y: s.h * (headingUp && follow ? (side ? 0.62 : 0.68) : 0.5) };
  }

  function draw() {
    rafId = 0;
    if (!active) return;
    // keep the loop alive even if one frame throws (otherwise the map freezes until reload)
    rafId = requestAnimationFrame(draw);
    try { drawFrame(); } catch (e) { if (window.console) console.error(e); }
  }
  function drawFrame() {
    var s = size();
    ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
    ctx.fillStyle = T.bg;
    ctx.fillRect(0, 0, s.w, s.h);

    if (info && target.has) {
      step();
      var a = anchor(s), scale = pxPerUnit(view.zoom);
      ctx.save();
      ctx.translate(a.x, a.y);
      ctx.rotate(view.rot);
      ctx.scale(scale, scale);
      ctx.translate(-view.x, -view.z);
      if (vectorOK && game === 'ets2') drawVector(s, scale); else drawTiles(s, scale);
      drawTrail(scale);
      drawRoomRoutes(scale);
      drawRoute(scale);
      ctx.restore();
      if (vectorOK && game === 'ets2') { drawPois(s); drawCityLabels(s); }
      drawTargets(s);
      drawFriends(s);
      drawTruck(a);
    }
  }

  var lastFrame = 0;
  function ease(dt, tau) { return 1 - Math.exp(-dt / tau); }
  function step() {
    // time-based smoothing between 100ms telemetry updates
    var now = performance.now(), dt = lastFrame ? Math.min(1000, now - lastFrame) : 1000;
    lastFrame = now;
    advancePos(dt);
    advanceFriends(dt);
    // camera target: our truck, or the friend picked in the list
    var watched = watchName && friendView[watchName], fp = watched || pos;
    if (watchName && !watched) watchName = null;
    if (follow) {
      // locked to the truck; only glide back after re-center
      var k = snapFollow ? 1 : ease(dt, 220);
      view.x += (fp.x - view.x) * k;
      view.z += (fp.z - view.z) * k;
      if (Math.hypot(fp.x - view.x, fp.z - view.z) < 3 || Math.abs(fp.x - view.x) > 2000) { view.x = fp.x; view.z = fp.z; snapFollow = true; }
    }
    var wantRot = headingUp && follow ? fp.heading * Math.PI * 2 : 0;
    var d = wantRot - view.rot;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    // heading-up: turn the map slowly and never faster than ~40 deg/s, so steering wiggles and
    // roundabouts don't spin the whole screen
    var stepRot = d * ease(dt, 650), maxStep = 0.7 * dt / 1000;
    if (Math.abs(d) < 0.035 && follow) stepRot *= 0.3;   // ignore tiny wobble (< 2 deg)
    view.rot += Math.max(-maxStep, Math.min(maxStep, stepRot));
    if (follow && autoZoom) {
      var kmh = watched ? watched.s : target.speed;
      var z = kmh < 15 ? 8.6 : kmh < 40 ? 8 : kmh < 70 ? 7.3 : 6.8;
      view.zoom += (z - view.zoom) * ease(dt, 1500);
    }
  }

  // ---------- vector roads from the route server (matches the installed game version) ----------
  // Source: the PC route server, else static tiles exported next to this page (routing/export-tiles.cmd).
  // An https page (Vercel) cannot call http://<pc>:25556 at all (mixed content), so it only uses tiles.
  var HTTPS = location.protocol === 'https:';
  var TILES = 'tiles/ets2/';
  var vectorOK = false, tileSrc = null, tileIndex = null, roadCache = {}, roadOrder = [], roadInflight = 0;
  function checkVector() {
    var server = HTTPS ? Promise.reject(new Error('https')) :
      fetch('http://' + routeHost() + ':25556/health', { cache: 'no-store' }).then(function (r) { return r.json(); });
    server
      .then(function (d) { if (!d || !d.roads) throw new Error('no roads'); tileSrc = 'server'; vectorOK = true; })
      .catch(function () {
        if (tileIndex) { tileSrc = 'static'; vectorOK = true; return; }
        return fetchJson(TILES + 'index.json').then(function (j) {
          tileIndex = {};
          Object.keys(j.cells).forEach(function (k) {
            var set = {};
            j.cells[k].forEach(function (c) { set[c] = 1; });
            tileIndex[k] = set;
          });
          tileSrc = 'static'; vectorOK = true;
        });
      })
      .catch(function () { vectorOK = false; tileSrc = null; });
  }
  // static tiles exist only for cells that have something in them (index.json)
  function tileUrl(kind, lod, cx, cz) {
    if (tileSrc !== 'static') return 'http://' + routeHost() + ':25556/' + kind + '?v=2&cx=' + cx + '&cz=' + cz + '&lod=' + lod;
    var set = tileIndex[(kind === 'roads' ? 'r' : 'p') + lod];
    return set && set[cx + ',' + cz] ? TILES + kind + '/' + lod + '/' + cx + '_' + cz + '.json' : null;
  }
  function roadCell(lod, cx, cz) {
    var key = lod + '|' + cx + ',' + cz, c = roadCache[key];
    if (c) return c;
    var url = tileUrl('roads', lod, cx, cz);
    if (!url) return (roadCache[key] = { lines: [] });
    if (roadInflight >= 6) return null;
    c = roadCache[key] = { lines: null };
    roadOrder.push(key);
    if (roadOrder.length > 600) delete roadCache[roadOrder.shift()];
    roadInflight++;
    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (d) { c.lines = d.lines || []; })
      .catch(function () { delete roadCache[key]; })
      .then(function () { roadInflight--; });
    return c;
  }
  function strokeLines(lines) {
    ctx.beginPath();
    lines.forEach(function (l) {
      ctx.moveTo(l[1], l[2]);
      for (var j = 3; j < l.length; j += 2) ctx.lineTo(l[j], l[j + 1]);
    });
  }
  // line code = class + 10 * layer (route server). class 0 motorway, 1 road, 2 junction curve, 3 expressway.
  var RANK = { 0: 2, 1: 0, 2: 0, 3: 1 };
  function drawVector(s, scale) {
    var lod = view.zoom >= 7.2 ? 0 : view.zoom >= 5.6 ? 1 : 2;
    var cell = lod === 2 ? 8000 : 2000;
    var r = Math.hypot(s.w, s.h) / scale;
    var x0 = Math.floor((view.x - r) / cell), x1 = Math.floor((view.x + r) / cell);
    var z0 = Math.floor((view.z - r) / cell), z1 = Math.floor((view.z + r) / cell);
    // group by (elevation layer, rank): lower layers first, so an overpass is drawn with its casing over the road below
    var groups = {}, keys = [];
    for (var cz = z0; cz <= z1; cz++) for (var cx = x0; cx <= x1; cx++) {
      var c = roadCell(lod, cx, cz);
      if (!c || !c.lines) continue;
      for (var i = 0; i < c.lines.length; i++) {
        var l = c.lines[i], code = l[0], rk = RANK[code % 10], key = Math.floor(code / 10) * 3 + rk;
        var g = groups[key];
        if (!g) { g = groups[key] = { rk: rk, lines: [] }; keys.push(key); }
        g.lines.push(l);
      }
    }
    keys.sort(function (a, b) { return a - b; });
    var grow = Math.max(0.7, Math.min(2.2, Math.pow(2, view.zoom - 7.5)));
    var STY = [[T.roadCase, T.road, 4.2], [T.tkCase, T.tk, 5], [T.mwCase, T.mw, 6]];
    ctx.lineJoin = 'round';
    for (var k = 0; k < keys.length; k++) {
      var gr = groups[keys[k]], st = STY[gr.rk], w = st[2] * grow;
      strokeLines(gr.lines);
      // butt-capped casing avoids grey seams where one road continues into the next layer
      ctx.lineCap = 'butt'; ctx.strokeStyle = st[0]; ctx.lineWidth = (w + 2.4) / scale; ctx.stroke();
      ctx.lineCap = 'round'; ctx.strokeStyle = st[1]; ctx.lineWidth = w / scale; ctx.stroke();
    }
  }
  // ---------- POIs with the game's own map icons (from the route server) ----------
  var poiCache = {}, poiOrder = [], poiInflight = 0, iconCache = {};
  function poiCell(cx, cz, lod) {
    var key = lod + '|' + cx + ',' + cz, c = poiCache[key];
    if (c) return c;
    var url = tileUrl('pois', lod, cx, cz);
    if (!url) return (poiCache[key] = { pois: [] });
    if (poiInflight >= 4) return null;
    c = poiCache[key] = { pois: null };
    poiOrder.push(key);
    if (poiOrder.length > 800) delete poiCache[poiOrder.shift()];
    poiInflight++;
    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (d) { c.pois = d.pois || []; })
      .catch(function () { delete poiCache[key]; })
      .then(function () { poiInflight--; });
    return c;
  }
  function icon(name) {
    var ic = iconCache[name];
    if (!ic) {
      ic = iconCache[name] = { img: new Image(), ok: false };
      ic.img.onload = function () { ic.ok = true; };
      ic.img.src = (tileSrc === 'static' ? TILES : 'http://' + routeHost() + ':25556/') + 'icons/' + name + '.png';
    }
    return ic;
  }
  // minimum zoom and on-screen height (px) per POI kind
  function poiStyle(p) {
    var name = p[0], type = p[3];
    if (type === 'road') return { minZoom: 5.6, h: 40 };   // shield PNGs have transparent padding
    if (type === 'company') return { minZoom: 6.6, h: 28 };
    if (type === 'ferry' || type === 'train') return { minZoom: 4.2, h: 30 };
    if (name === 'parking_ico') return { minZoom: 6.6, h: 26 };
    if (type === 'facility') return { minZoom: 4.6, h: 30 };
    return { minZoom: 6.8, h: 24 };   // landmarks, viewpoints
  }
  function drawPois(s) {
    if (view.zoom < 4.2) return;
    // zoomed out: big cells with only facilities / ferries (server side lod 1)
    var lod = view.zoom < 6.4 ? 1 : 0, cell = lod ? 8000 : 2000;
    var scale = pxPerUnit(view.zoom), r = Math.hypot(s.w, s.h) / scale;
    var x0 = Math.floor((view.x - r) / cell), x1 = Math.floor((view.x + r) / cell);
    var z0 = Math.floor((view.z - r) / cell), z1 = Math.floor((view.z + r) / cell);
    // icons shrink a little when zoomed far out, never below 70%
    var zs = Math.max(0.7, Math.min(1.15, 0.7 + (view.zoom - 4.5) * 0.12));
    // Declutter in world space (distances between POIs don't change when the map pans or rotates),
    // in a fixed order, and only re-run when zoom or the loaded set changes: no flicker while driving.
    var list = [];
    for (var cz = z0; cz <= z1; cz++) for (var cx = x0; cx <= x1; cx++) {
      var c = poiCell(cx, cz, lod);
      if (c && c.pois) list = list.concat(c.pois);
    }
    var zq = Math.round(view.zoom * 20) / 20, sig = lod + '|' + zq + '|' + list.length;
    if (sig !== poiSig) {
      poiSig = sig;
      var minPx = 30 * zs, minW = minPx / pxPerUnit(zq), grid = {}, keep = [];
      list.sort(poiCompare);
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        if (zq < poiStyle(p).minZoom) continue;
        var gx = Math.floor(p[1] / minW), gz = Math.floor(p[2] / minW), hit = false;
        for (var dx = -1; dx <= 1 && !hit; dx++) for (var dz = -1; dz <= 1 && !hit; dz++) {
          var cellList = grid[(gx + dx) + ',' + (gz + dz)];
          if (cellList) for (var k = 0; k < cellList.length; k++) {
            if (Math.hypot(cellList[k][1] - p[1], cellList[k][2] - p[2]) < minW) { hit = true; break; }
          }
        }
        if (hit) continue;
        (grid[gx + ',' + gz] = grid[gx + ',' + gz] || []).push(p);
        keep.push(p);
      }
      poiKeep = keep;
    }
    poiKeep.forEach(function (p) {
      var sp = toScreen(p[1], p[2], s);
      if (sp.x < -40 || sp.y < -40 || sp.x > s.w + 40 || sp.y > s.h + 40) return;
      var ic = icon(p[0]);
      if (!ic.ok) return;
      var h = poiStyle(p).h * zs, w = h * ic.img.naturalWidth / (ic.img.naturalHeight || 1);
      ctx.drawImage(ic.img, sp.x - w / 2, sp.y - h / 2, w, h);
    });
  }
  // important kinds first so they win the declutter; ties broken by position so the order never changes
  var POI_RANK = { ferry: 0, train: 0, road: 1, facility: 2, company: 3 };
  var poiSig = '', poiKeep = [];
  function poiCompare(a, b) {
    var ra = POI_RANK[a[3]] !== undefined ? POI_RANK[a[3]] : 4, rb = POI_RANK[b[3]] !== undefined ? POI_RANK[b[3]] : 4;
    return ra - rb || a[1] - b[1] || a[2] - b[2];
  }

  function drawCityLabels(s) {
    if (!places || view.zoom > 9.2) return;
    ctx.save();
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    Object.keys(places.cities).forEach(function (k) {
      var c = places.cities[k], p = toScreen(c.p[0], c.p[1], s);
      if (p.x < -60 || p.y < -20 || p.x > s.w + 60 || p.y > s.h + 20) return;
      ctx.lineWidth = 4; ctx.strokeStyle = T.halo; ctx.strokeText(c.name, p.x, p.y);
      ctx.fillStyle = T.label; ctx.fillText(c.name, p.x, p.y);
    });
    ctx.restore();
  }

  function drawTiles(s, scale) {
    var maxZ = info.maxZoom, tz = Math.max(info.minZoom || 0, Math.min(maxZ, Math.round(view.zoom)));
    var n = Math.pow(2, tz), tileUnits = extentSize() / n;
    var r = Math.hypot(s.w, s.h) / scale;             // generous radius in game units
    var x0 = Math.floor((view.x - r - info.x1) / tileUnits), x1 = Math.floor((view.x + r - info.x1) / tileUnits);
    var y0 = Math.floor((view.z - r - info.y1) / tileUnits), y1 = Math.floor((view.z + r - info.y1) / tileUnits);
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(n - 1, x1); y1 = Math.min(n - 1, y1);
    var pad = 1 / scale;                              // hide hairline seams
    for (var ty = y0; ty <= y1; ty++) {
      for (var tx = x0; tx <= x1; tx++) {
        var gx = info.x1 + tx * tileUnits, gy = info.y1 + ty * tileUnits;
        var t = getTile(tz, tx, ty);
        if (t.ok) { ctx.drawImage(t.img, gx, gy, tileUnits + pad, tileUnits + pad); continue; }
        // fallback: draw the part of a loaded parent tile
        for (var pz = tz - 1, k = 2; pz >= 0; pz--, k *= 2) {
          var px = Math.floor(tx / k), py = Math.floor(ty / k), p = tiles[pz + '/' + px + '/' + py];
          if (p && p.ok) {
            var sz = info.tileSize / k;
            ctx.drawImage(p.img, (tx % k) * sz, (ty % k) * sz, sz, sz, gx, gy, tileUnits + pad, tileUnits + pad);
            break;
          }
        }
      }
    }
  }

  function drawTrail(scale) {
    if (trail.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(trail[0][0], trail[0][1]);
    for (var i = 1; i < trail.length; i++) ctx.lineTo(trail[i][0], trail[i][1]);
    ctx.strokeStyle = T.routeDone;
    ctx.lineWidth = 5 / scale;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.stroke();
  }

  function drawTruck(a) {
    var s = size(), scale = pxPerUnit(view.zoom), p;
    {
      // project truck position into screen space
      var dx = (pos.x - view.x) * scale, dy = (pos.z - view.z) * scale;
      var c = Math.cos(view.rot), sn = Math.sin(view.rot);
      p = { x: a.x + dx * c - dy * sn, y: a.y + dx * sn + dy * c };
      if (p.x < -30 || p.y < -30 || p.x > s.w + 30 || p.y > s.h + 30) return;
    }
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(-pos.heading * Math.PI * 2 + view.rot);
    ctx.beginPath();
    ctx.arc(0, 0, 26, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(26,115,232,.15)';
    ctx.fill();
    // Google-style navigation arrow: blue chevron, thick white border, soft shadow
    ctx.beginPath();
    ctx.moveTo(0, -17); ctx.lineTo(13, 14); ctx.lineTo(0, 7); ctx.lineTo(-13, 14); ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 2;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 6; ctx.stroke();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = T.truck; ctx.fill();
    ctx.restore();
  }

  function kick() { if (active && !rafId) rafId = requestAnimationFrame(draw); }

  // ---------- interaction ----------
  function setFollow(on) {
    follow = on;
    if (on) snapFollow = false;
    if (!on) watchName = null;
    recenterEl.classList.toggle('hidden', on);
    if (on) autoZoom = true;
  }
  function zoomBy(dz) {
    if (!info) return;
    autoZoom = false;
    var maxZ = info.maxZoom + MAX_OVERZOOM;
    view.zoom = Math.max(info.minZoom || 0, Math.min(maxZ, view.zoom + dz));
  }
  function panBy(dxPx, dyPx) {
    if (!info) return;
    var scale = pxPerUnit(view.zoom), c = Math.cos(-view.rot), sn = Math.sin(-view.rot);
    view.x -= (dxPx * c - dyPx * sn) / scale;
    view.z -= (dxPx * sn + dyPx * c) / scale;
  }

  // ---------- destinations & pins ----------
  var lastNavMeters = 0, demoCur = null;
  var places = null, placesGame = null, jobDest = null, toastTimer = 0;

  function norm(s) { return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, ''); }

  function loadPlaces(g) {
    placesGame = g; places = null; jobDest = null;
    fetchJson('data/' + g + '-places.json').then(function (d) {
      if (placesGame !== g) return;
      var cities = {}, companies = {};
      Object.keys(d.cities).forEach(function (k) { cities[norm(k)] = { name: k, p: d.cities[k] }; });
      d.companies.forEach(function (c) {
        var key = norm(c[0]) + '|' + norm(c[1]);
        (companies[key] = companies[key] || []).push([c[2], c[3]]);
      });
      places = { cities: cities, companies: companies };
    }).catch(function () { /* no place data: job pin disabled */ });
  }

  // ---------- in-game GPS waypoints (route server reads them from the newest save, see /gps) ----------
  var gps = { ok: false, savedAt: 0, ahead: [], reached: 0 };
  function pollGps() {
    if (DEMO || remote || HTTPS) return;
    fetch('http://' + routeHost() + ':25556/gps', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) { gps.ok = false; return; }
        if (d.savedAt !== gps.savedAt) {
          gps = { ok: true, savedAt: d.savedAt, ahead: (d.ahead || []).map(function (w) { return { x: w.x, z: w.z }; }), reached: 0 };
        } else gps.ok = true;
      })
      .catch(function () { gps.ok = false; });
  }
  function demoGps() {
    // demo: pretend the game GPS goes Linz -> a point on the way -> Salzburg
    gps = { ok: true, savedAt: 1, ahead: [{ x: 11300, z: 15300 }, { x: 9146, z: 16019 }], reached: 0 };
  }
  function gpsRemaining() { return gps.ok ? gps.ahead.slice(gps.reached) : []; }
  // passing a waypoint (close to it, or our position on the route is past its stop index) drops it
  function checkReached() {
    var rem = gpsRemaining();
    if (!rem.length) return;
    var w = rem[0], near = Math.hypot(w.x - target.x, w.z - target.z) < 120;
    var passed = route && route.gps && route.stops && route.stops[0] && rem.length > 1 && routeIdx >= route.stops[0].idx - 1;
    if (near || passed) { gps.reached++; toast(rem.length > 1 ? 'ผ่านจุดแวะแล้ว' : 'ถึงปลายทางแล้ว'); }
  }

  // job destination: company depot (pick the candidate whose straight distance best fits the route distance), else city centre
  function resolveJob(job, navMeters) {
    if (!places || !job || !job.destinationCity) { jobDest = null; return; }
    var key = norm(job.destinationCity) + '|' + norm(job.destinationCompany);
    if (jobDest && jobDest.key === key && !jobDest.ambiguous) return;
    var cands = places.companies[key], best = null;
    if (!cands) {
      // game display names can differ from the data (e.g. "Antwerpen" vs "Antwerp"): fuzzy city match
      var qc = norm(job.destinationCity), qco = norm(job.destinationCompany);
      Object.keys(places.companies).some(function (k) {
        var parts = k.split('|');
        if (parts[1] === qco && Math.min(parts[0].length, qc.length) >= 4 && (qc.indexOf(parts[0]) === 0 || parts[0].indexOf(qc) === 0)) { cands = places.companies[k]; return true; }
        return false;
      });
    }
    if (cands && cands.length) {
      best = cands[0];
      if (cands.length > 1 && navMeters > 0) {
        var bestErr = Infinity;
        cands.forEach(function (c) {
          var err = Math.abs(Math.hypot(c[0] - target.x, c[1] - target.z) * gameScale() * 1.25 - navMeters);
          if (err < bestErr) { bestErr = err; best = c; }
        });
      }
      jobDest = { key: key, x: best[0], z: best[1], label: job.destinationCompany + ' · ' + job.destinationCity, ambiguous: cands.length > 1 };
    } else {
      var city = places.cities[norm(job.destinationCity)];
      jobDest = city ? { key: key, x: city.p[0], z: city.p[1], label: job.destinationCity, ambiguous: false } : null;
    }
  }

  function toScreen(wx, wz, s) {
    var a = anchor(s), scale = pxPerUnit(view.zoom), dx = (wx - view.x) * scale, dy = (wz - view.z) * scale;
    var c = Math.cos(view.rot), sn = Math.sin(view.rot);
    return { x: a.x + dx * c - dy * sn, y: a.y + dx * sn + dy * c };
  }
  function toWorld(px, py, s) {
    var a = anchor(s), scale = pxPerUnit(view.zoom), dx = (px - a.x) / scale, dy = (py - a.y) / scale;
    var c = Math.cos(-view.rot), sn = Math.sin(-view.rot);
    return { x: view.x + dx * c - dy * sn, z: view.z + dx * sn + dy * c };
  }

  // the game shows distances at map scale (ETS2 ~1:19, ATS ~1:20); world units are metres
  function gameScale() { return placesGame === 'ats' ? 20 : 19; }
  function fmtKm(units) {
    var m = units * gameScale();
    var mph = storeGet('units', 'kmh') === 'mph', v = m / 1000 * (mph ? 0.621371 : 1);
    return (v < 10 ? v.toFixed(1) : Math.round(v)) + (mph ? ' mi' : ' km');
  }

  // markers to draw: remaining in-game waypoints (last one = destination), else the job destination
  function targets() {
    var rem = gpsRemaining();
    if (rem.length) {
      return rem.map(function (w, i) {
        var last = i === rem.length - 1;
        var isJob = last && jobDest && Math.hypot(jobDest.x - w.x, jobDest.z - w.z) < 2500;
        return { x: w.x, z: w.z, final: last, n: i + 1, label: last ? (isJob ? jobDest.label : 'ปลายทาง') : 'จุดแวะ ' + (i + 1) };
      });
    }
    if (jobDest) return [{ x: jobDest.x, z: jobDest.z, final: true, label: jobDest.label, job: true }];
    // following the group's route (no waypoints / job of our own): its pins
    if (route && route.group) {
      var gp = route.group.plan, n = gp.wps.length;
      return gp.wps.map(function (w, i) {
        var last = i === n - 1;
        return { x: w[0], z: w[1], final: last, n: i + 1, label: last ? (gp.label || 'ปลายทาง') + ' (' + route.group.name + ')' : 'จุดแวะ ' + (i + 1) };
      });
    }
    return [];
  }

  // No route of our own (no waypoints, no job), e.g. a convoy guest whose game never saves: drive by the
  // group's route instead (pins, blue line and turn banner, matched to our position along it).
  function followGroup() {
    var L = room ? room.leader() : null;
    if (!L || L.name === selfName || !L.plan || !L.plan.route || L.plan.route.length < 2) return false;
    var key = 'group|' + L.name + '|' + L.plan.savedAt + '|' + L.plan.routeAt;
    if (routeKey !== key) {
      routeKey = key;
      route = buildRoute(key, L.plan.route, L.plan.steps, L.plan.stops, true);
      routeIdx = 0;
    }
    route.group = L;
    var n = nearestOnRoute(target.x, target.z);
    routeIdx = n.idx;
    routeBefore = n.beforeStart && n.dist > 15;
    showTurn(nextStep());
    return true;
  }

  // ---------- road routing (routing/route-server, port 25556) ----------
  var ROUTE_PORT = 25556;
  var route = null;            // { key, points:[[x,z]], steps:[{dist,dir,text,at,idx}], cum:[] }
  var routeBefore = false;
  var routeIdx = 0, routeBusy = false, routeNextTry = 0, routeLastReq = 0, offSince = 0, routeKey = '';
  var turnEl, turnIcon, turnDist, turnText;

  function routeHost() {
    var p = new URLSearchParams(location.search).get('server') || storeGet('server', '');
    var h = p ? p.replace(/^https?:\/\//, '').split(':')[0] : location.hostname;
    return h || 'localhost';
  }

  // what we route to: job destination (by company) first, else the first pin
  function routeTarget(job, nav) {
    // in-game GPS waypoints win: same route as the game (as of the newest save)
    var rem = gpsRemaining();
    if (rem.length && (nav > 0 || DEMO)) {
      return { key: 'gps|' + gps.savedAt + '|' + gps.reached, gps: true,
               q: 'via=' + rem.map(function (w) { return w.x.toFixed(1) + ',' + w.z.toFixed(1); }).join(';') };
    }
    // route to the job even if the phone-side place lookup failed; the route server resolves the depot itself
    if (job && job.destinationCity) {
      return { key: 'job|' + norm(job.destinationCity) + '|' + norm(job.destinationCompany), job: job, q: 'city=' + encodeURIComponent(job.destinationCity) + '&company=' + encodeURIComponent(job.destinationCompany) + '&nav=' + Math.round(nav || 0) };
    }
    return null;
  }

  function nearestOnRoute(x, z) {
    // Search only a short stretch ahead of the current position along the route, so a route
    // that loops back near the truck doesn't make us skip its beginning. Full scan only when lost.
    var pts = route.points, cum = route.cum, best = -1, bestD = Infinity, bestT = 0;
    var from = Math.max(0, routeIdx - 5), to = routeIdx;
    while (to < pts.length - 1 && cum[to] - cum[routeIdx] < 400) to++;
    for (var pass = 0; pass < 2 && bestD > 300 * 300; pass++) {
      if (pass === 1) { from = 0; to = pts.length - 1; }
      for (var i = from; i < to; i++) {
        var a = pts[i], b = pts[i + 1], dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz;
        var t = L ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L)) : 0;
        var px = a[0] + t * dx - x, pz = a[1] + t * dz - z, d = px * px + pz * pz;
        if (d < bestD) { bestD = d; best = i; bestT = t; }
      }
    }
    return { idx: Math.max(0, best), dist: Math.sqrt(bestD), beforeStart: best <= 0 && bestT === 0 };
  }

  function buildRoute(key, points, steps, stops, isGps) {
    var cum = [0];
    for (var i = 1; i < points.length; i++) cum.push(cum[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
    return { key: key, points: points, steps: steps || [], cum: cum, stops: stops || null, gps: !!isGps };
  }

  // remote (room) mode: no route server here; this player's own bridge sent waypoints + road route
  var remote = false, selfPlan = null;
  function updateRemoteRoute(nav) {
    var p = selfPlan;
    if (!p || !p.wps || !p.wps.length) {
      if (gps.ok) gps = { ok: false, savedAt: 0, ahead: [], reached: 0 };
      if (followGroup()) return;
      route = null; routeKey = ''; showTurn(null); return;
    }
    if (gps.savedAt !== p.savedAt) gps = { ok: true, savedAt: p.savedAt, ahead: p.wps.map(function (w) { return { x: w[0], z: w[1] }; }), reached: 0 };
    var key = 'remote|' + p.savedAt + '|' + p.routeAt;
    if (routeKey !== key) {
      routeKey = key;
      route = p.route && p.route.length > 1 ? buildRoute(key, p.route, p.steps, p.stops, true) : null;
      routeIdx = 0;
      if (route) routeIdx = nearestOnRoute(target.x, target.z).idx;
    }
    if (!route) { showTurn(null); return; }
    var n = nearestOnRoute(target.x, target.z);
    routeIdx = n.idx;
    routeBefore = n.beforeStart && n.dist > 15;
    showTurn(nextStep());
  }

  function updateRoute(job, nav) {
    if (remote) return updateRemoteRoute(nav);
    var t = routeTarget(job, nav), now = Date.now();
    if (!t) {
      if (followGroup()) return;
      route = null; routeKey = ''; showTurn(null); return;
    }
    var need = t.key !== routeKey;
    if (route && !need) {
      var n = nearestOnRoute(target.x, target.z);
      routeIdx = n.idx;
      routeBefore = n.beforeStart && n.dist > 15;
      // off route for 3s -> reroute
      // the route may begin a little ahead of the truck (next road node): approaching its start is not "off route"
      var off = n.dist > 40 && !(n.beforeStart && n.dist < 400);
      if (off) { if (!offSince) offSince = now; if (now - offSince > 3000) need = true; } else offSince = 0;
      showTurn(nextStep());
      checkMismatch(nav, now);
    }
    if (need && !routeBusy && now > routeNextTry && now - routeLastReq > 4000) requestRoute(t);
  }

  function requestRoute(t) {
    routeBusy = true; routeLastReq = Date.now();
    var url = 'http://' + routeHost() + ':' + ROUTE_PORT + '/route?x=' + target.x.toFixed(1) + '&z=' + target.z.toFixed(1) + '&h=' + target.heading.toFixed(4) + '&' + t.q;
    fetch(url, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        routeKey = t.key; offSince = 0;
        if (!d.ok || !d.points || d.points.length < 2) { route = null; routeNextTry = Date.now() + 15000; return; }
        route = buildRoute(t.key, d.points, d.steps, d.stops, t.gps);
        if (t.job) {
          // the server knows the exact depot: put the job pin at the route's end
          var end = d.points[d.points.length - 1];
          jobDest = { key: norm(t.job.destinationCity) + '|' + norm(t.job.destinationCompany), x: end[0], z: end[1], label: t.job.destinationCompany + ' · ' + t.job.destinationCity, ambiguous: false };
        }
        routeIdx = 0;
        routeIdx = nearestOnRoute(target.x, target.z).idx;
      })
      .catch(function () { routeNextTry = Date.now() + 30000; })   // route server not running: fall back to straight line
      .then(function () { routeBusy = false; });
  }

  // the game's own nav distance disagrees with our route for a while -> the in-game GPS changed since the last save
  var mismatchSince = 0;
  function checkMismatch(nav, now) {
    var ours = remainingUnits() * gameScale();
    var bad = !DEMO && nav > 0 && ours > 0 && Math.abs(ours - nav) > Math.max(4000, nav * 0.25);
    if (bad) { if (!mismatchSince) mismatchSince = now; } else mismatchSince = 0;
    notice(mismatchSince && now - mismatchSince > 6000
      ? 'เส้นทางในเกมไม่ตรงกับแมพ — กด <b>F5</b> (Quick save) ในเกมเพื่ออัปเดต waypoint'
      : '');
  }
  function notice(html) {
    if (!noticeEl || noticeEl._h === html) return;
    noticeEl._h = html; noticeEl.innerHTML = html; noticeEl.classList.toggle('hidden', !html);
  }

  function remainingUnits() { return route ? route.cum[route.cum.length - 1] - route.cum[routeIdx] : 0; }

  function nextStep() {
    if (!route) return null;
    for (var i = 0; i < route.steps.length; i++) {
      var st = route.steps[i];
      // skip DEPART, "continue straight" and already-passed steps: show the next real maneuver
      if (st.dir === -2 || st.dir === 0 || st.idx <= routeIdx) continue;
      return { step: st, units: route.cum[Math.min(st.idx, route.cum.length - 1)] - route.cum[routeIdx] };
    }
    return null;
  }

  // left-hand shapes; right turns reuse them mirrored
  var TURN_SVG = {
    straight: 'M12 21V4M6 10l6-6 6 6',
    slight: 'M15 21v-6.5L8.5 8M8 13.5V8h5.5',
    turn: 'M16 21v-8a4 4 0 0 0-4-4H5M9 5 5 9l4 4',
    sharp: 'M16 3v9l-8.5 8.5M7 14v6.5h6.5',
    uturn: 'M16 21V9a4 4 0 0 0-8 0v8M4 14l4 4 4-4',
    round: 'M12 21v-5M12 16a4 4 0 1 1 4-4M16 12V4M13 7l3-3 3 3',
    merge: 'M8 21c0-6 4-8 4-15M16 21c0-4-2-6-4-8M8 9l4-4 4 4',
    flag: 'M6 21V4M6 4h12l-2.5 4.5L18 13H6',
    ferry: 'M3 18c2 2 4 2 6 0s4-2 6 0 4 2 6 0M5 15l1-5h12l1 5M9 10V6h6v4'
  };
  function turnShape(d) {
    if (d >= 21 && d <= 29) return ['round', false];
    var m = { 0: ['straight', false], 1: ['slight', false], 2: ['turn', false], 3: ['sharp', false], 4: ['uturn', false],
              11: ['slight', true], 12: ['turn', true], 13: ['sharp', true], 14: ['uturn', true],
              '-1': ['merge', false], '-3': ['flag', false], '-5': ['flag', false], '-4': ['ferry', false] }[d];
    return m || ['straight', false];
  }
  function turnWord(d) {
    if (d >= 21 && d <= 29) return 'วงเวียน';
    return { 0: 'ตรงไป', 1: 'ชิดซ้าย', 2: 'เลี้ยวซ้าย', 3: 'เลี้ยวซ้ายหักศอก', 4: 'กลับรถ', 11: 'ชิดขวา', 12: 'เลี้ยวขวา', 13: 'เลี้ยวขวาหักศอก', 14: 'กลับรถ',
             '-1': 'เข้าทางหลัก', '-3': 'ถึงปลายทาง', '-5': 'ถึงจุดแวะ', '-4': 'ขึ้นเรือ' }[d] || '';
  }
  function showTurn(n) {
    if (!turnEl) return;
    turnEl.classList.toggle('hidden', !n);
    if (!n) return;
    var d = n.step.dir;
    var sh = turnShape(d);
    if (turnIcon._s !== sh[0]) { turnIcon._s = sh[0]; turnIcon.innerHTML = '<svg viewBox="0 0 24 24"><path d="' + TURN_SVG[sh[0]] + '"/></svg>'; }
    turnIcon.classList.toggle('mirror', sh[1]);
    turnDist.textContent = fmtKm(n.units);
    var txt = turnWord(d);
    if (n.step.exit) txt += ' · ทางออก ' + n.step.exit;
    if (n.step.text && d !== -3 && d !== -5) txt += (txt ? ' · ' : '') + n.step.text;
    turnText.textContent = txt;
  }

  function drawRoute(scale) {
    if (!route) return;
    var pts = route.points;
    // blue = the group's route; our own colour when our waypoints differ from it
    var own = ownRouteDiffers() ? selfColor() : null;
    var col = own || T.route, casing = own ? 'rgba(0,0,0,.28)' : T.routeCase;
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    var startI = routeIdx + 1;
    if (routeBefore) {
      // truck is off the road (depot, parking): dashed connector to where the route starts
      ctx.beginPath();
      ctx.setLineDash([6 / scale, 6 / scale]);
      ctx.moveTo(pos.x, pos.z); ctx.lineTo(pts[0][0], pts[0][1]);
      ctx.strokeStyle = col; ctx.lineWidth = 3 / scale; ctx.stroke();
      ctx.setLineDash([]);
      startI = 1;
    }
    // Draw in ~120-unit pieces, farthest first, each with its own casing: where the route crosses
    // itself (loop ramps, coming back the same way) the nearer part visibly passes over the other.
    var chunks = [], cur = [routeBefore ? pts[0] : [pos.x, pos.z]], len = 0;
    for (var i = startI; i < pts.length; i++) {
      var prev = cur[cur.length - 1];
      cur.push(pts[i]);
      len += Math.hypot(pts[i][0] - prev[0], pts[i][1] - prev[1]);
      if (len > 120 && i < pts.length - 1) { chunks.push(cur); cur = [pts[i]]; len = 0; }
    }
    if (cur.length > 1) chunks.push(cur);
    for (var c = chunks.length - 1; c >= 0; c--) {
      var ch = chunks[c];
      ctx.beginPath();
      ctx.moveTo(ch[0][0], ch[0][1]);
      for (var j = 1; j < ch.length; j++) ctx.lineTo(ch[j][0], ch[j][1]);
      ctx.lineCap = 'butt'; ctx.strokeStyle = casing; ctx.lineWidth = 11 / scale; ctx.stroke();
      ctx.lineCap = 'round'; ctx.strokeStyle = col; ctx.lineWidth = 7.5 / scale; ctx.stroke();
    }
    ctx.restore();
  }

  // ---------- room: friends on the map, group route, diverging routes ----------
  var room = null, selfName = '', watchName = null;
  var friendView = {};       // name -> eased draw state { x, z, heading, s, color, name, online }
  var trimCache = {};        // name -> { key, idx, at }: where along its route a member currently is
  var alerts = {};           // name -> { stopSince, stopWarned, diverged }
  var friendsEl = null, friendsSig = '';

  function selfMember() { return room && selfName ? room.member(selfName) : null; }
  function selfColor() {
    var me = selfMember();
    return me ? me.color : window.RoomLink ? window.RoomLink.colorFor(selfName || '?') : '#e8710a';
  }
  function myWps() {
    if (remote) return selfPlan && selfPlan.wps ? selfPlan.wps : [];
    return gps.ok ? gps.ahead.map(function (w) { return [w.x, w.z]; }) : [];
  }
  function groupLeader() { return room ? room.leader() : null; }
  function ownRouteDiffers() {
    var L = groupLeader();
    if (!L || L.name === selfName || !route || !route.gps || route.group) return false;
    return !window.RoomLink.sameWps(myWps(), L.plan.wps);
  }
  function memberDiffers(m, L) {
    return !!(L && m.plan && m.plan.wps.length && m.name !== L.name && !window.RoomLink.sameWps(m.plan.wps, L.plan.wps));
  }

  // index of the member's position along its route (re-scanned every 500 ms, near the last hit)
  function trimIdx(m) {
    var r = m.plan.route, c = trimCache[m.name], now = Date.now(), key = m.plan.savedAt + '|' + m.plan.routeAt;
    if (c && c.key === key && now - c.at < 500) return c.idx;
    var p = friendView[m.name] || (m.pos ? { x: m.pos.x, z: m.pos.z } : null);
    if (!p) return 0;
    var from = c && c.key === key ? Math.max(0, c.idx - 20) : 0, best = from, bestD = Infinity;
    for (var pass = 0; pass < 2; pass++) {
      var to = pass ? r.length - 1 : Math.min(r.length - 1, from + 400);
      for (var i = pass ? 0 : from; i < to; i++) {
        var d = Math.hypot(r[i][0] - p.x, r[i][1] - p.z);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (bestD < 300) break;
    }
    trimCache[m.name] = { key: key, idx: best, at: now };
    return best;
  }
  function strokeRoute(pts, from, color, casing, w, scale) {
    if (pts.length - from < 2) return;
    ctx.beginPath();
    ctx.moveTo(pts[from][0], pts[from][1]);
    for (var i = from + 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt'; ctx.strokeStyle = casing; ctx.lineWidth = (w + 3) / scale; ctx.stroke();
    ctx.lineCap = 'round'; ctx.strokeStyle = color; ctx.lineWidth = w / scale; ctx.stroke();
  }
  function drawRoomRoutes(scale) {
    if (!room) return;
    var L = groupLeader();
    ctx.save();
    room.members().forEach(function (m) {
      if (!m.online || m.name === selfName || !m.plan || !m.plan.route || !memberDiffers(m, L)) return;
      ctx.globalAlpha = 0.85;
      strokeRoute(m.plan.route, trimIdx(m), m.color, 'rgba(0,0,0,.25)', 5, scale);
    });
    ctx.globalAlpha = 1;
    // the group route, unless it is the one we already draw as our own
    if (L && L.name !== selfName && L.plan.route && (ownRouteDiffers() || !route)) {
      strokeRoute(L.plan.route, trimIdx(L), T.route, T.routeCase, 7.5, scale);
    }
    ctx.restore();
  }

  // friends' trucks: dead-reckoned from their ~1/s updates (speed + heading), then eased
  function advanceFriends(dt) {
    if (!room) return;
    var now = Date.now(), seen = {};
    room.members().forEach(function (m) {
      if (!m.pos || m.name === selfName) return;
      seen[m.name] = 1;
      var p = m.pos, age = Math.min(2, Math.max(0, (now - m.seen) / 1000)), a = p.h * Math.PI * 2;
      var mv = m.online && !p.p ? p.s / 3.6 * age : 0;
      var px = p.x - Math.sin(a) * mv, pz = p.z - Math.cos(a) * mv;
      var v = friendView[m.name];
      if (!v || Math.hypot(px - v.x, pz - v.z) > 500) v = friendView[m.name] = { x: px, z: pz, heading: p.h };
      var k = ease(dt, 250);
      v.x += (px - v.x) * k; v.z += (pz - v.z) * k;
      var dh = p.h - v.heading; dh -= Math.round(dh);
      v.heading = wrap1(v.heading + dh * k);
      v.s = p.s; v.color = m.color; v.name = m.name; v.online = m.online;
    });
    Object.keys(friendView).forEach(function (k) { if (!seen[k]) delete friendView[k]; });
  }
  // off-screen friend: small coloured arrow on the screen edge pointing at them, with name + distance
  function drawFriendEdge(v, p, s) {
    var side = anchor(s).x * 2 - s.w;                  // landscape side panel width (0 in portrait)
    var L = side + 24, R = s.w - 70, Tp = side ? 24 : edgeTop(), B = side ? s.h - 24 : s.h - (wrap.classList.contains('room') ? 190 : 150);
    var c = toScreen(pos.x, pos.z, s);
    var ox = Math.max(L + 1, Math.min(R - 1, c.x)), oy = Math.max(Tp + 1, Math.min(B - 1, c.y));
    var ang = Math.atan2(p.y - oy, p.x - ox), dx = Math.cos(ang), dy = Math.sin(ang);
    var k = Math.min(dx > 0 ? (R - ox) / dx : dx < 0 ? (L - ox) / dx : Infinity,
                     dy > 0 ? (B - oy) / dy : dy < 0 ? (Tp - oy) / dy : Infinity);
    var ex = ox + dx * k, ey = oy + dy * k, col = v.online ? v.color : '#9aa0a6';
    ctx.save();
    ctx.translate(ex, ey);
    ctx.save(); ctx.rotate(ang);
    ctx.fillStyle = col; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(11, 0); ctx.lineTo(-7, -9); ctx.lineTo(-3, 0); ctx.lineTo(-7, 9); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
    var text = v.name + ' · ' + fmtKm(Math.hypot(v.x - pos.x, v.z - pos.z));
    label(text, Math.max(L + 40 - ex, Math.min(R - 40 - ex, 0)), ey < s.h / 2 ? 24 : -20, col);
    ctx.restore();
  }
  function drawFriends(s) {
    Object.keys(friendView).forEach(function (k) {
      var v = friendView[k], p = toScreen(v.x, v.z, s);
      if (p.x < -10 || p.y < -10 || p.x > s.w + 10 || p.y > s.h + 10) { drawFriendEdge(v, p, s); return; }
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.save();
      ctx.rotate(-v.heading * Math.PI * 2 + view.rot);
      ctx.beginPath();
      ctx.moveTo(0, -14); ctx.lineTo(11, 12); ctx.lineTo(0, 6); ctx.lineTo(-11, 12); ctx.closePath();
      ctx.lineJoin = 'round';
      ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 5; ctx.shadowOffsetY = 2;
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 5; ctx.stroke();
      ctx.shadowColor = 'transparent';
      ctx.fillStyle = v.online ? v.color : '#9aa0a6'; ctx.fill();
      ctx.restore();
      label(v.name + (v.online ? '' : ' · ออฟไลน์'), 0, -30, v.online ? v.color : null);
      ctx.restore();
    });
  }

  // friends list in the bottom sheet + "stopped for a while" / "left the group route" toasts
  function updateFriends() {
    if (!friendsEl) return;
    var on = !!room;
    wrap.classList.toggle('room', on);
    if (!on) return;
    var L = groupLeader(), me = target.has ? target : null;
    var list = room.members().filter(function (m) { return m.name !== selfName && m.pos; });
    list.sort(function (a, b) { return (b.online - a.online) || a.name.localeCompare(b.name); });
    var html = list.map(function (m) {
      var d = me ? fmtKm(Math.hypot(m.pos.x - me.x, m.pos.z - me.z)) : '';
      var tag = L && L.name === m.name ? ' ★' : memberDiffers(m, L) ? ' ⑂' : '';
      return '<button data-name="' + esc(m.name) + '" class="' + (m.online ? '' : 'off ') + (watchName === m.name ? 'on' : '') + '">' +
        '<i style="background:' + (m.online ? m.color : '#9aa0a6') + '"></i>' + esc(m.name) + tag + (m.online ? ' · ' + d : ' · ออฟไลน์') + '</button>';
    }).join('');
    if (!list.length) html = '<span class="none">ห้อง ' + esc(room.room) + ' · ' + (room.state() === 'ok' ? 'ยังไม่มีเพื่อนออนไลน์' : 'กำลังเชื่อมต่อ…') + '</span>';
    if (html !== friendsSig) { friendsSig = html; friendsEl.innerHTML = html; }

    var now = Date.now();
    list.forEach(function (m) {
      var a = alerts[m.name] || (alerts[m.name] = { stopSince: 0, stopWarned: false, diverged: false });
      var stopped = m.online && !m.pos.p && m.pos.s < 2;
      if (!stopped) { a.stopSince = 0; a.stopWarned = false; } else if (!a.stopSince) a.stopSince = now;
      if (stopped && !a.stopWarned && now - a.stopSince > 3 * 60000) { a.stopWarned = true; toast(m.name + ' หยุดนานแล้ว (3 นาที)', 4000); }
      var dv = m.online && memberDiffers(m, L);
      if (dv && !a.diverged) toast(m.name + ' ใช้เส้นทางต่างจากกลุ่ม', 4000);
      a.diverged = dv;
    });
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }

  function drawTargets(s) {
    var truck = toScreen(pos.x, pos.z, s), list = targets();
    var routed = !!route && (route.gps || route.key.indexOf('job|') === 0);
    for (var i = list.length - 1; i >= 0; i--) {
      var t = list[i], p = toScreen(t.x, t.z, s);
      if (!routed && i === 0) {
        // no road route yet: dashed straight line truck -> first target
        ctx.save();
        ctx.setLineDash([8, 8]); ctx.strokeStyle = T.route; ctx.globalAlpha = 0.7; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(truck.x, truck.y); ctx.lineTo(p.x, p.y); ctx.stroke();
        ctx.restore();
      }
      var pad = 30, inside = p.x > pad && p.y > pad && p.x < s.w - pad && p.y < s.h - pad;
      if (inside) {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.shadowColor = 'rgba(0,0,0,.3)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 1;
        if (t.final) {
          ctx.fillStyle = '#ea4335';
          ctx.beginPath();
          ctx.moveTo(0, 0); ctx.bezierCurveTo(-4, -10, -13, -14, -13, -24); ctx.arc(0, -24, 13, Math.PI, 0); ctx.bezierCurveTo(13, -14, 4, -10, 0, 0);
          ctx.fill();
          ctx.shadowColor = 'transparent';
          ctx.fillStyle = '#a50e0e'; ctx.beginPath(); ctx.arc(0, -24, 5, 0, Math.PI * 2); ctx.fill();
          label(t.label, 0, -50);
        } else {
          ctx.fillStyle = '#fff'; ctx.strokeStyle = '#5f6368'; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.arc(0, 0, 14, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          ctx.shadowColor = 'transparent';
          ctx.fillStyle = '#3c4043'; ctx.font = '700 14px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(String(t.n), 0, 0.5);
          label(t.label, 0, -30);
        }
        ctx.restore();
      } else if (t.final && !routed) {
        // edge arrow toward an off-screen destination (only without a drawn road route)
        var side = anchor(s).x * 2 - s.w;   // width taken by the landscape side panel (0 in portrait)
        var L = side + 30, R = s.w - 78, Tp = side ? 30 : edgeTop(), B = side ? s.h - 30 : s.h - 150;
        var ox = Math.max(L + 1, Math.min(R - 1, truck.x)), oy = Math.max(Tp + 1, Math.min(B - 1, truck.y));
        var ang = Math.atan2(p.y - oy, p.x - ox), dx = Math.cos(ang), dy = Math.sin(ang);
        var k = Math.min(dx > 0 ? (R - ox) / dx : dx < 0 ? (L - ox) / dx : Infinity,
                         dy > 0 ? (B - oy) / dy : dy < 0 ? (Tp - oy) / dy : Infinity);
        var ex = ox + dx * k, ey = oy + dy * k;
        ctx.save();
        ctx.translate(ex, ey);
        ctx.save(); ctx.rotate(ang);
        ctx.fillStyle = '#ea4335'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-8, -11); ctx.lineTo(-3, 0); ctx.lineTo(-8, 11); ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.restore();
        label(t.label + ' · ' + fmtKm(Math.hypot(t.x - target.x, t.z - target.z)), Math.max(L + 30 - ex, Math.min(R - 30 - ex, 0)), ey < s.h / 2 ? 30 : -22);
        ctx.restore();
      }
    }
  }

  // y below which edge indicators may sit (under the top-left banner/nav chips)
  function edgeTop() {
    var tl = wrap.querySelector('.map-top');
    return tl ? tl.offsetTop + tl.offsetHeight + 28 : 40;
  }

  function label(text, x, y, color) {
    ctx.save();
    ctx.font = '600 12px system-ui, sans-serif';
    var w = ctx.measureText(text).width + 16;
    ctx.shadowColor = 'rgba(0,0,0,.25)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 1;
    ctx.fillStyle = T.pill;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x - w / 2, y - 12, w, 24, 12); else ctx.rect(x - w / 2, y - 12, w, 24);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = color || T.pillText; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 0.5);
    ctx.restore();
  }

  function toast(t, ms) {
    setStatus(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { setStatus(''); }, ms || 1800);
  }

  function bindGestures() {
    var pts = {}, lastDist = 0, lastMid = null;
    function list() { return Object.keys(pts).map(function (k) { return pts[k]; }); }
    canvas.addEventListener('pointerdown', function (e) {
      canvas.setPointerCapture(e.pointerId);
      pts[e.pointerId] = { x: e.clientX, y: e.clientY };
      var l = list();
      if (l.length === 2) { lastDist = Math.hypot(l[0].x - l[1].x, l[0].y - l[1].y); lastMid = { x: (l[0].x + l[1].x) / 2, y: (l[0].y + l[1].y) / 2 }; }
    });
    canvas.addEventListener('pointermove', function (e) {
      var p = pts[e.pointerId];
      if (!p) return;
      var l = list();
      if (l.length === 1) {
        var dx = e.clientX - p.x, dy = e.clientY - p.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) { if (follow) setFollow(false); panBy(dx, dy); }
      }
      p.x = e.clientX; p.y = e.clientY;
      if (l.length === 2) {
        var d = Math.hypot(l[0].x - l[1].x, l[0].y - l[1].y);
        var mid = { x: (l[0].x + l[1].x) / 2, y: (l[0].y + l[1].y) / 2 };
        if (lastDist) zoomBy(Math.log2(d / lastDist));
        if (lastMid && !follow) panBy(mid.x - lastMid.x, mid.y - lastMid.y);
        lastDist = d; lastMid = mid;
      }
    });
    function up(e) { delete pts[e.pointerId]; lastDist = 0; lastMid = null; }
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    canvas.addEventListener('wheel', function (e) { e.preventDefault(); zoomBy(-e.deltaY / 400); }, { passive: false });
  }

  function setStatus(t) { statusEl.textContent = t; statusEl.classList.toggle('hidden', !t); }

  // ---------- public API ----------
  window.TruckMap = {
    init: function () {
      wrap = document.getElementById('mapWrap');
      canvas = document.getElementById('mapCanvas');
      ctx = canvas.getContext('2d');
      statusEl = document.getElementById('mapStatus');
      compassEl = document.getElementById('mapCompass');
      recenterEl = document.getElementById('mapRecenter');
      gameEl = document.getElementById('mapGame');
      turnEl = document.getElementById('mapTurn');
      turnIcon = document.getElementById('mapTurnIcon');
      turnDist = document.getElementById('mapTurnDist');
      turnText = document.getElementById('mapTurnText');
      noticeEl = document.getElementById('mapNotice');
      destEl = document.getElementById('mDest');
      sheetEl = document.getElementById('mapSheet');
      viaEl = document.getElementById('mVia');
      themeMode = storeGet('mapTheme', 'auto');
      applyTheme();
      var themeEl = document.getElementById('mapTheme');
      themeEl.addEventListener('click', function () {
        themeMode = { auto: 'day', day: 'night', night: 'auto' }[themeMode] || 'auto';
        storeSet('mapTheme', themeMode);
        applyTheme();
        toast('แผนที่: ' + { auto: 'อัตโนมัติตามเวลาในเกม', day: 'กลางวัน', night: 'กลางคืน' }[themeMode]);
      });
      // ?demo&guest: no waypoints of our own (like a convoy guest) -> follows the group route
      if (DEMO) { if (!/[?&]guest\b/.test(location.search)) demoGps(); } else { pollGps(); setInterval(pollGps, 3000); }
      headingUp = storeGet('mapHeadingUp', '1') === '1';
      gameOverride = storeGet('mapGame', '') || null;
      compassEl.classList.toggle('on', headingUp);
      bindGestures();
      checkVector();
      setInterval(checkVector, 30000);
      document.getElementById('mapZoomIn').addEventListener('click', function () { zoomBy(0.5); });
      document.getElementById('mapZoomOut').addEventListener('click', function () { zoomBy(-0.5); });
      recenterEl.addEventListener('click', function () { watchName = null; setFollow(true); });
      friendsEl = document.getElementById('mFriends');
      friendsEl.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-name]');
        if (b) window.TruckMap.watch(b.getAttribute('data-name'));
      });
      setInterval(updateFriends, 1000);
      compassEl.addEventListener('click', function () {
        headingUp = !headingUp;
        storeSet('mapHeadingUp', headingUp ? '1' : '0');
        compassEl.classList.toggle('on', headingUp);
      });
      gameEl.addEventListener('click', function () {
        gameOverride = (game || 'ets2') === 'ets2' ? 'ats' : 'ets2';
        storeSet('mapGame', gameOverride);
        loadInfo(gameOverride);
      });
      window.addEventListener('resize', kick);
    },
    setActive: function (on) {
      active = on;
      lastFrame = 0;
      if (on) kick();
    },
    update: function (data) {
      var t = data.truck, pl = t.placement;
      if (!pl) return;
      var g = gameOverride || (ATS_MAKES.test(t.make || '') ? 'ats' : 'ets2');
      if (g !== loadingGame) loadInfo(g);
      if (g !== placesGame) loadPlaces(g);
      var first = !target.has;
      target.x = pl.x; target.z = pl.z; target.heading = pl.heading; target.speed = Math.abs(t.speed); target.has = true;
      onSample(pl.x, pl.z, pl.heading);
      resolveJob(data.job, data.navigation ? data.navigation.estimatedDistance : 0);
      lastNavMeters = data.navigation ? data.navigation.estimatedDistance : 0;
      var gt = data.game && Date.parse(data.game.time);
      if (gt) { var hr = new Date(gt).getUTCHours(); if (hr !== gameHour) { gameHour = hr; applyTheme(); } }
      checkReached();
      updateRoute(data.job, lastNavMeters);
      var tl = targets(), fin = tl[tl.length - 1];
      if (destEl) {
        var dtxt = fin ? fin.label : '';
        var vtxt = route && route.group ? 'ตามเส้นกลุ่มของ ' + route.group.name
          : route && route.gps ? 'ตาม GPS ในเกม' + (tl.length > 1 ? ' · แวะ ' + (tl.length - 1) + ' จุด' : '') : (route ? 'ไปยังจุดส่งงาน' : '');
        if (destEl.textContent !== dtxt) destEl.textContent = dtxt;
        if (viaEl.textContent !== vtxt) viaEl.textContent = vtxt;
      }
      if (first) { view.x = pl.x; view.z = pl.z; view.rot = headingUp ? pl.heading * Math.PI * 2 : 0; snapFollow = true; }
      var last = trail[trail.length - 1];
      if (!last || Math.hypot(last[0] - pl.x, last[1] - pl.z) > 15) {
        if (last && Math.hypot(last[0] - pl.x, last[1] - pl.z) > 3000) trail = []; // teleport / ferry
        trail.push([pl.x, pl.z]);
        if (trail.length > TRAIL_MAX) trail.shift();
      }
      compassEl.querySelector('svg').style.transform = 'rotate(' + view.rot + 'rad)';
    },
    // room link (RoomLink.start(...)) and which member is "us"; null to leave the room
    setRoom: function (r, name) {
      room = r; selfName = name || '';
      if (!r) { friendView = {}; watchName = null; }
      updateFriends();
    },
    setSelf: function (name) { selfName = name || ''; },
    // remote mode: our truck and route come from the room instead of this PC (page opened on Vercel)
    setRemote: function (on) { remote = !!on; },
    setSelfPlan: function (p) { selfPlan = p || null; },
    // camera on a friend (tap again, or "กลับตำแหน่งรถ", to come back)
    watch: function (name) {
      watchName = watchName === name || !friendView[name] ? null : name;
      follow = true; snapFollow = false; autoZoom = true;
      recenterEl.classList.toggle('hidden', !watchName);
      friendsSig = '';
      updateFriends();
      if (watchName) toast('กำลังดู ' + watchName);
    },
    // camera state, for checking motion smoothness from the console
    debugView: function () { return { x: view.x, z: view.z, rot: view.rot, zoom: view.zoom }; },
    // demo: drive along the current route (returns null until a route exists)
    demoFollow: function (units) {
      if (!route) return null;
      if (!demoCur || demoCur.key !== route.key) demoCur = { key: route.key, d: route.cum[routeIdx] || 0 };
      demoCur.d = Math.min(demoCur.d + units, route.cum[route.cum.length - 1]);
      var c = route.cum, p = route.points, i = 0;
      while (i < c.length - 2 && c[i + 1] < demoCur.d) i++;
      var seg = c[i + 1] - c[i] || 1, f = Math.max(0, Math.min(1, (demoCur.d - c[i]) / seg));
      var dx = p[i + 1][0] - p[i][0], dz = p[i + 1][1] - p[i][1], h = Math.atan2(-dx, -dz) / (Math.PI * 2);
      return { x: p[i][0] + dx * f, z: p[i][1] + dz * f, heading: h < 0 ? h + 1 : h };
    }
  };
})();

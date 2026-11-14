/*
 * Room link: Supabase Realtime (Broadcast) client for the multi-player map. No dependencies:
 * speaks the Phoenix channel protocol over a plain WebSocket.
 *
 * Every player's PC runs tools/bridge.js, which broadcasts into channel "room:<code>":
 *   pos  { name, x, z, h, s, ... }            truck state, ~1/s while moving, every 5 s when parked
 *   plan { name, savedAt, wps, route, steps } in-game GPS waypoints + road route, on change and every 10 s
 * The page only listens. There is no database: a member is online while its pos keeps arriving.
 *
 * window.RoomLink.start({ url, key, room, onChange }) -> { members(), leader(), close() }
 */
(function () {
  'use strict';

  var OFFLINE_MS = 10000;
  var HEARTBEAT_MS = 25000;
  var COLORS = ['#e8710a', '#d01884', '#188038', '#9334e6', '#c5221f', '#12b5cb', '#b06000', '#3949ab'];
  var DIFF_UNITS = 150;   // waypoints further apart than this = a different route

  function colorFor(name) {
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return COLORS[h % COLORS.length];
  }

  // same waypoint chain (point by point, within DIFF_UNITS)
  function sameWps(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]) > DIFF_UNITS) return false;
    }
    return true;
  }

  function start(opts) {
    var members = {};      // name -> { name, color, pos, seen, plan }
    var ws = null, ref = 0, joinRef = null, hb = 0, retry = 0, closed = false, state = 'connecting';
    var topic = 'realtime:room:' + opts.room;
    var base = opts.url.replace(/^http/, 'ws').replace(/\/+$/, '');
    var changeTimer = 0;

    function changed() {
      if (changeTimer) return;
      changeTimer = setTimeout(function () { changeTimer = 0; if (opts.onChange) opts.onChange(api); }, 0);
    }
    function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

    function connect() {
      if (closed) return;
      state = 'connecting'; changed();
      try {
        ws = new WebSocket(base + '/realtime/v1/websocket?apikey=' + encodeURIComponent(opts.key) + '&vsn=1.0.0');
      } catch (e) { return later(); }
      ws.onopen = function () {
        joinRef = String(++ref);
        var payload = { config: { broadcast: { self: false, ack: false }, presence: { key: '' }, private: false } };
        // legacy anon key is a JWT and doubles as the access token; new "sb_publishable_" keys are not JWTs
        if (/^eyJ/.test(opts.key)) payload.access_token = opts.key;
        send({ topic: topic, event: 'phx_join', ref: joinRef, join_ref: joinRef, payload: payload });
        clearInterval(hb);
        hb = setInterval(function () { send({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(++ref) }); }, HEARTBEAT_MS);
      };
      ws.onmessage = function (e) {
        var m;
        try { m = JSON.parse(e.data); } catch (err) { return; }
        if (m.topic !== topic) return;
        if (m.event === 'phx_reply' && m.ref === joinRef) {
          var ok = m.payload && m.payload.status === 'ok';
          state = ok ? 'ok' : 'error';
          if (ok) retry = 0;
          changed();
        } else if (m.event === 'broadcast' && m.payload) {
          onBroadcast(m.payload.event, m.payload.payload);
        } else if (m.event === 'phx_error' || m.event === 'phx_close') {
          ws.close();
        }
      };
      ws.onclose = function () { clearInterval(hb); if (!closed) { state = 'offline'; changed(); later(); } };
      ws.onerror = function () { /* onclose follows */ };
    }
    function later() { setTimeout(connect, Math.min(30000, 1000 * Math.pow(2, retry++))); }

    function member(name) {
      var m = members[name];
      if (!m) {
        m = members[name] = { name: name, color: COLORS[0], pos: null, seen: 0, plan: null };
        // colours by name order: no two members share one, and every phone that sees the same people agrees
        Object.keys(members).sort().forEach(function (k, i) { members[k].color = COLORS[i % COLORS.length]; });
      }
      return m;
    }
    function onBroadcast(event, p) {
      if (!p || typeof p.name !== 'string' || !p.name) return;
      var m = member(p.name.slice(0, 24));
      if (event === 'pos') {
        if (typeof p.x !== 'number' || typeof p.z !== 'number') return;
        m.pos = p; m.seen = Date.now();
      } else if (event === 'plan') {
        if (!Array.isArray(p.wps)) return;
        if (!m.plan || m.plan.savedAt !== p.savedAt || m.plan.routeAt !== p.routeAt) m.plan = p;
        if (!m.seen) m.seen = Date.now();
      } else return;
      changed();
    }

    // shared route = waypoints of the online member who saved most recently ("whoever saved last")
    function leader() {
      var best = null, now = Date.now();
      Object.keys(members).forEach(function (k) {
        var m = members[k];
        if (now - m.seen > OFFLINE_MS || !m.plan || !m.plan.wps.length) return;
        if (!best || m.plan.savedAt > best.plan.savedAt) best = m;
      });
      return best;
    }

    var api = {
      state: function () { return state; },
      room: opts.room,
      members: function () {
        var now = Date.now();
        return Object.keys(members).map(function (k) {
          var m = members[k];
          m.online = now - m.seen < OFFLINE_MS;
          return m;
        });
      },
      member: function (name) { return members[name] || null; },
      leader: leader,
      close: function () { closed = true; clearInterval(hb); if (ws) ws.close(); }
    };
    connect();
    // online -> offline transitions happen without a message
    setInterval(changed, 2000);
    return api;
  }

  window.RoomLink = { start: start, colorFor: colorFor, sameWps: sameWps, OFFLINE_MS: OFFLINE_MS };
})();

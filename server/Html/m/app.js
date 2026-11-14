(function () {
  'use strict';

  // ---------- config ----------
  var params = new URLSearchParams(location.search);
  var DEMO = params.has('demo');
  var POLL_MS = 100;
  var EPOCH = Date.parse('0001-01-01T00:00:00Z');
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function storeGet(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
  function storeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  // ?server=192.168.1.10:25555 lets you open this page from anywhere (server has CORS enabled)
  var server = params.get('server') || storeGet('server', '');
  if (params.get('server')) storeSet('server', server);
  if (!server && location.protocol === 'http:') server = location.host;
  // an https page (Vercel) can't fetch http://<PC>:25555 (mixed content): room mode only
  // ?remote: act like the https page (room only), for testing on a LAN
  var API = server && location.protocol !== 'https:' && !params.has('remote') ? 'http://' + server.replace(/^https?:\/\//, '') + '/api/ets2/telemetry' : null;

  // room (multi-player): ?room=CODE&name=ME, remembered. ?room= (empty) leaves the room.
  if (params.has('room')) storeSet('room', (params.get('room') || '').trim().toUpperCase());
  if (params.has('name')) storeSet('name', (params.get('name') || '').trim());
  var ROOM = storeGet('room', ''), MY_NAME = storeGet('name', '');
  var RC = window.ROOM_CONFIG || {};
  var ROOM_ON = !!(ROOM && RC.supabaseUrl && RC.supabaseAnonKey && window.RoomLink);
  var CONN_PREFIX = '';   // "Name · " in the top bar when our truck comes from the room

  var units = storeGet('units', 'kmh'); // kmh | mph

  // ---------- helpers ----------
  var $ = function (id) { return document.getElementById(id); };
  var cache = {};
  function setText(id, v) { if (cache[id] !== v) { cache[id] = v; $(id).textContent = v; } }
  function toggle(id, cls, on) { $(id).classList.toggle(cls, !!on); }
  function pct(x) { return Math.max(0, Math.min(100, x * 100)); }
  function setW(id, frac) { $(id).style.width = pct(frac).toFixed(1) + '%'; }
  function setH(id, frac) { $(id).style.height = pct(frac).toFixed(1) + '%'; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function durMs(iso) { var t = Date.parse(iso); return isNaN(t) ? 0 : Math.max(0, t - EPOCH); }
  function fmtDur(ms) {
    var m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d > 0) return d + 'd ' + (h % 24) + 'h';
    return h + 'h ' + pad(m % 60) + 'm';
  }
  function fmtTrip(ms) {
    var m = Math.round(ms / 60000), h = Math.floor(m / 60);
    if (h >= 24) return Math.floor(h / 24) + ' วัน ' + (h % 24) + ' ชม.';
    return h > 0 ? h + ' ชม. ' + (m % 60) + ' นาที' : Math.max(1, m) + ' นาที';
  }
  // The plugin counts game minutes from 0001-01-01 (a Monday in JS), but the game's own clock is one weekday
  // earlier (checked in game: plugin day 32 -> game shows Thu). In convoy the plugin's time also drifts from
  // the clock on screen, so it is shown as approximate, next to the real clock.
  function fmtGameTime(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '--';
    return DAYS[(d.getUTCDay() + 6) % 7] + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
  }
  function tickRealClock() {
    var n = new Date();
    setText('realTime', pad(n.getHours()) + ':' + pad(n.getMinutes()));
  }
  tickRealClock();
  setInterval(tickRealClock, 5000);
  var KM_MI = 0.621371;
  function spd(kmh) { return units === 'mph' ? kmh * KM_MI : kmh; }
  function dist(km) {
    var v = units === 'mph' ? km * KM_MI : km;
    var u = units === 'mph' ? ' mi' : ' km';
    return (v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString()) + u;
  }
  function money(n) { return '€' + Math.round(n).toLocaleString(); }

  // ---------- RPM gauge geometry ----------
  var CX = 150, CY = 150, R = 130, START = 135, SWEEP = 270;
  function pt(deg, r) { var a = deg * Math.PI / 180; return [CX + r * Math.cos(a), CY + r * Math.sin(a)]; }
  var p0 = pt(START, R), p1 = pt(START + SWEEP, R);
  var arcD = 'M' + p0[0].toFixed(2) + ' ' + p0[1].toFixed(2) + ' A' + R + ' ' + R + ' 0 1 1 ' + p1[0].toFixed(2) + ' ' + p1[1].toFixed(2);
  document.querySelector('.gauge .track').setAttribute('d', arcD);
  var rpmArc = $('rpmArc');
  rpmArc.setAttribute('d', arcD);
  var ARC_LEN = rpmArc.getTotalLength();
  rpmArc.style.strokeDasharray = ARC_LEN;
  rpmArc.style.strokeDashoffset = ARC_LEN;

  var ticksFor = 0;
  function buildTicks(rpmMax) {
    if (ticksFor === rpmMax || !rpmMax) return;
    ticksFor = rpmMax;
    var g = $('ticks'), html = '';
    var step = rpmMax > 4000 ? 1000 : 500;
    for (var r = 0; r <= rpmMax + 1; r += step) {
      var deg = START + SWEEP * (r / rpmMax);
      var a = pt(deg, R - 16), b = pt(deg, R - 24), t = pt(deg, R - 38);
      html += '<line x1="' + a[0] + '" y1="' + a[1] + '" x2="' + b[0] + '" y2="' + b[1] + '"/>';
      html += '<text x="' + t[0] + '" y="' + t[1] + '">' + (r / 1000).toFixed(r % 1000 ? 1 : 0) + '</text>';
    }
    g.innerHTML = html;
  }

  // ---------- render ----------
  function render(d) {
    var g = d.game, t = d.truck, tr = d.trailer, j = d.job, n = d.navigation;

    setText('gameClock', 'เกม ~' + fmtGameTime(g.time) + (g.paused ? ' · หยุด' : ''));
    setText('connText', CONN_PREFIX + (t.make ? t.make + ' ' + t.model : 'Connected'));

    // speed
    var kmh = Math.abs(t.speed);
    var v = Math.round(spd(kmh));
    setText('speed', String(v));
    setText('speedUnit', units === 'mph' ? 'mph' : 'km/h');
    var limit = n.speedLimit;
    $('limit').classList.toggle('hidden', !limit);
    if (limit) setText('limitVal', String(Math.round(spd(limit))));
    toggle('speed', 'over', limit && kmh > limit + 2);

    // rpm
    var max = t.engineRpmMax || 2500;
    buildTicks(max);
    var frac = Math.max(0, Math.min(1, t.engineRpm / max));
    rpmArc.style.strokeDashoffset = (ARC_LEN * (1 - frac)).toFixed(1);
    toggle('rpmArc', 'redline', frac > 0.9);
    setText('rpm', Math.round(t.engineRpm) + ' rpm');

    // gear
    var gear = t.displayedGear, gt;
    if (gear > 0) gt = (t.shifterType === 'automatic' || t.shifterType === 'arcade') ? 'D' + gear : String(gear);
    else if (gear < 0) gt = t.reverseGears > 1 ? 'R' + (-gear) : 'R';
    else gt = 'N';
    setText('gear', gt);
    toggle('gear', 'r', gear < 0);

    // indicators
    toggle('iBlinkL', 'on', t.blinkerLeftOn);
    toggle('iBlinkR', 'on', t.blinkerRightOn);
    toggle('iPark', 'on', t.parkBrakeOn);
    toggle('iCruise', 'on', t.cruiseControlOn);
    setText('ccSpeed', t.cruiseControlOn ? String(Math.round(spd(t.cruiseControlSpeed))) : '');
    toggle('iLow', 'on', t.lightsBeamLowOn);
    toggle('iHigh', 'on', t.lightsBeamHighOn);
    toggle('iMotor', 'on', t.motorBrakeOn);
    toggle('iRetarder', 'on', t.retarderBrake > 0);
    setText('retStep', String(t.retarderBrake));
    toggle('iBeacon', 'on', t.lightsBeaconOn);
    toggle('iWipers', 'on', t.wipersOn);
    toggle('iFuelW', 'on', t.fuelWarningOn);
    toggle('iAirW', 'on', t.airPressureWarningOn || t.airPressureEmergencyOn);

    // fuel
    var ff = t.fuelCapacity ? t.fuel / t.fuelCapacity : 0;
    setW('fuelBar', ff);
    toggle('fuelBar', 'low', t.fuelWarningOn || ff < (t.fuelWarningFactor || 0.15));
    setText('fuelPct', Math.round(ff * 100) + '%');
    setText('fuelL', Math.round(t.fuel) + ' L');
    setText('fuelRange', t.fuelAverageConsumption > 0 ? '≈ ' + dist(t.fuel / t.fuelAverageConsumption) : '-- km');

    // navigation
    var navKm = n.estimatedDistance / 1000;
    setText('navDist', navKm > 0 ? dist(navKm) : '--');
    var eta = durMs(n.estimatedTime);
    // the game's ETA is in game time; game time runs timeScale x faster (~15-19x) -> real minutes / clock
    var scale = g.timeScale > 0 ? g.timeScale : 19;
    var etaReal = eta > 0 ? eta / scale : 0;
    var arriveReal = etaReal > 0 ? new Date(Date.now() + etaReal) : null;
    var arriveTxt = arriveReal ? pad(arriveReal.getHours()) + ':' + pad(arriveReal.getMinutes()) : '';
    setText('navTime', eta > 0 ? 'ถึง ' + arriveTxt + ' · ' + fmtTrip(etaReal) : '--');

    // job
    var hasJob = !!(j && j.destinationCity);
    setText('jmFrom', hasJob ? j.sourceCity : '--');
    setText('jmTo', hasJob ? j.destinationCity : '--');
    var remain = hasJob ? durMs(j.remainingTime) : 0;
    setText('jmRemain', hasJob ? money(j.income) + ' · ' + fmtDur(remain) + ' left' : 'No active job');
    document.querySelector('#jobMini .route').classList.toggle('hidden', !hasJob);

    setText('jFromCity', hasJob ? j.sourceCity : '--');
    setText('jFromCo', hasJob ? j.sourceCompany : '--');
    setText('jToCity', hasJob ? j.destinationCity : '--');
    setText('jToCo', hasJob ? j.destinationCompany : '--');
    setText('jIncome', hasJob ? money(j.income) : '--');
    setText('jRemain', hasJob ? fmtDur(remain) : '--');
    setText('jDeadline', hasJob ? 'Deadline ' + fmtGameTime(j.deadlineTime) : '--');
    setText('jDist', navKm > 0 ? dist(navKm) : '--');
    setText('jEta', eta > 0 ? arriveTxt : '--');
    setText('jEtaSub', eta > 0 ? 'อีก ' + fmtTrip(etaReal) + ' · เกม ' + fmtDur(eta) : '');

    setText('trName', tr.attached ? (tr.name || tr.id) : 'No trailer');
    setText('trMass', tr.attached ? (tr.mass / 1000).toFixed(1) + ' t' : '');
    setW('trWear', tr.wear);
    setText('trWearT', Math.round(tr.wear * 100) + '%');
    setText('restIn', fmtDur(durMs(g.nextRestStopTime)));

    // map
    setText('mSpeed', String(v));
    setText('mUnit', units === 'mph' ? 'mph' : 'km/h');
    $('mLimit').classList.toggle('hidden', !limit);
    if (limit) setText('mLimitVal', String(Math.round(spd(limit))));
    // Google-style bottom sheet: big real trip time, then distance · real arrival clock · game arrival
    var hasNav = navKm > 0;
    setText('mEta', hasNav && eta > 0 ? fmtTrip(etaReal) : (hasNav ? dist(navKm) : 'ไม่มีเส้นทาง'));
    var arrive = new Date(Date.parse(g.time) + eta);
    var gameArr = !isNaN(arrive) ? ' · เกม ~' + pad(arrive.getUTCHours()) + ':' + pad(arrive.getUTCMinutes()) : '';
    setText('mDist', hasNav ? dist(navKm) + (eta > 0 ? ' · ถึง ' + arriveTxt + gameArr : '') : 'ปัก waypoint ในเกม แล้วกด F5');
    toggle('mapSheet', 'idle', !hasNav);
    window.TruckMap.update(d);

    // truck tab
    setText('truckName', (t.make || '') + ' ' + (t.model || ''));
    setText('odo', dist(t.odometer));
    setH('pThrottle', t.gameThrottle);
    setH('pBrake', t.gameBrake);
    setH('pClutch', t.gameClutch);
    $('steerWheel').style.transform = 'rotate(' + (-t.gameSteer * 450).toFixed(1) + 'deg)';

    setText('vAir', Math.round(t.airPressure));
    setText('vOilP', Math.round(t.oilPressure));
    setText('vOilT', Math.round(t.oilTemperature));
    setText('vWater', Math.round(t.waterTemperature));
    setText('vBatt', t.batteryVoltage.toFixed(1));
    setText('vBrakeT', Math.round(t.brakeTemperature));
    setText('vAdblue', t.adblueCapacity ? Math.round(t.adblue) : 'n/a');
    setText('vAvg', (t.fuelAverageConsumption * 100).toFixed(1));
    toggle('gAir', 'warn', t.airPressureWarningOn || t.airPressureEmergencyOn);
    toggle('gOilP', 'warn', t.oilPressureWarningOn);
    toggle('gWater', 'warn', t.waterTemperatureWarningOn);
    toggle('gBatt', 'warn', t.batteryVoltageWarningOn);
    toggle('gAdblue', 'warn', t.adblueWarningOn);

    [['wEngine', t.wearEngine], ['wTrans', t.wearTransmission], ['wCabin', t.wearCabin],
     ['wChassis', t.wearChassis], ['wWheels', t.wearWheels]].forEach(function (w) {
      setW(w[0], w[1]);
      setText(w[0] + 'T', Math.round(w[1] * 100) + '%');
    });
  }

  // ---------- connection ----------
  function setStatus(state, text, hint) {
    $('conn').className = 'dot ' + (state === 'ok' ? 'ok' : state === 'game' ? 'warn' : '');
    $('overlay').classList.toggle('hidden', state === 'ok');
    if (state !== 'ok') {
      setText('connText', state === 'game' ? 'No game' : 'Offline');
      setText('overlayText', text);
      setText('overlayHint', hint || '');
    }
  }

  function handle(data) {
    if (!data || !data.game) return;
    if (!data.game.connected) {
      setStatus('game', 'Waiting for game…', 'Start ETS2 / ATS with the telemetry plugin installed.');
      return;
    }
    setStatus('ok');
    data.job = activeJob(data);
    render(data);
  }

  // The (old) telemetry plugin never clears the job after delivery/cancel, so the last job sticks.
  // While a job is active the in-game GPS always routes to it, so treat the job as finished once
  // the GPS has had no route for a few seconds (and show it again if the GPS route comes back).
  var noNavSince = 0;
  var EMPTY_JOB = { income: 0, deadlineTime: '', remainingTime: '', sourceCity: '', sourceCompany: '', destinationCity: '', destinationCompany: '' };
  function activeJob(data) {
    var job = data.job, nav = data.navigation;
    if (!job || !job.destinationCity) return EMPTY_JOB;
    if (nav && nav.estimatedDistance > 0) { noNavSince = 0; return job; }
    var now = Date.now();
    if (!noNavSince) noNavSince = now;
    return now - noNavSince > 5000 ? EMPTY_JOB : job;
  }

  var fails = 0;
  function poll() {
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 2000);
    fetch(API, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { return r.json(); })
      .then(function (data) { fails = 0; handle(data); })
      .catch(function () {
        if (++fails >= 3) setStatus('off', 'Cannot reach server', 'Run Ets2Telemetry.exe on your PC and open http://<PC-IP>:25555/m/index.html on the same Wi-Fi.');
      })
      .then(function () { clearTimeout(timer); setTimeout(poll, fails ? 1000 : POLL_MS); });
  }

  // ---------- demo data (?demo) ----------
  var demoPos = { x: 13475, z: 14618, h: 0.2 };
  var demoLast = 0;
  function demoPlacement(s, speed) {
    var dt = Math.min(0.5, s - demoLast); demoLast = s;
    demoPos.h += 0.004 * Math.sin(s / 9) * dt * 10;          // gentle curves
    var a = demoPos.h * Math.PI * 2, m = speed / 3.6 * dt * 4; // metres moved (4x faster for demo)
    // once the map has a road route, drive along it
    var f = window.TruckMap.demoFollow && window.TruckMap.demoFollow(m);
    if (f) { demoPos.x = f.x; demoPos.z = f.z; demoPos.h = f.heading; return { x: f.x, y: 0, z: f.z, heading: f.heading }; }
    demoPos.x -= Math.sin(a) * m;
    demoPos.z -= Math.cos(a) * m;
    return { x: demoPos.x, y: 0, z: demoPos.z, heading: ((demoPos.h % 1) + 1) % 1 };
  }
  function demoLoop() {
    var t0 = Date.now(), game = Date.parse('0001-01-08T08:00:00Z');
    setInterval(function () {
      var s = (Date.now() - t0) / 1000;
      var speed = 62 + 28 * Math.sin(s / 6);
      var gear = Math.min(12, Math.max(1, Math.round(speed / 8)));
      var blink = Math.floor(s * 2) % 2 === 0 && Math.floor(s / 8) % 3 === 0;
      handle({
        game: { connected: true, paused: false, timeScale: 19, time: new Date(game + s * 19000).toISOString().replace(/^\+?0*(\d{4})/, '$1'), nextRestStopTime: '0001-01-01T07:40:00Z' },
        truck: {
          make: 'Demo', model: 'Truck', speed: speed, cruiseControlSpeed: 80, cruiseControlOn: speed > 75,
          odometer: 105830 + s * 0.02, displayedGear: gear, reverseGears: 1, shifterType: 'arcade',
          engineRpm: 1100 + 900 * ((speed % 8) / 8), engineRpmMax: 2500,
          fuel: 520 - s * 0.05, fuelCapacity: 700, fuelAverageConsumption: 0.32, fuelWarningFactor: 0.15, fuelWarningOn: false,
          wearEngine: 0.03, wearTransmission: 0.02, wearCabin: 0.05, wearChassis: 0.08, wearWheels: 0.12,
          gameSteer: 0.05 * Math.sin(s / 2), gameThrottle: Math.max(0, Math.cos(s / 6)), gameBrake: Math.max(0, -Math.cos(s / 6)) * 0.6, gameClutch: 0,
          wipersOn: false, retarderBrake: speed > 85 ? 2 : 0, parkBrakeOn: false, motorBrakeOn: speed > 85, brakeTemperature: 40,
          adblue: 60, adblueCapacity: 80, adblueWarningOn: false,
          airPressure: 128, airPressureWarningOn: false, airPressureEmergencyOn: false,
          oilTemperature: 92, oilPressure: 68, oilPressureWarningOn: false, waterTemperature: 86, waterTemperatureWarningOn: false,
          batteryVoltage: 27.6, batteryVoltageWarningOn: false,
          placement: demoPlacement(s, speed),
          blinkerLeftOn: blink, blinkerRightOn: false, lightsBeamLowOn: true, lightsBeamHighOn: false, lightsBeaconOn: false
        },
        trailer: { attached: true, name: 'Excavator', mass: 22000, wear: 0.04 },
        job: params.has('guest') ? EMPTY_JOB : { income: 12850, deadlineTime: '0001-01-09T03:34:00Z', remainingTime: '0001-01-01T06:25:00Z',
               sourceCity: 'Linz', sourceCompany: 'DPD', destinationCity: 'Salzburg', destinationCompany: 'Renat' },
        navigation: { estimatedTime: '0001-01-01T03:01:40Z', estimatedDistance: 62500 - s * 18, speedLimit: 80 }
      });
    }, POLL_MS);
  }

  // ---------- UI wiring ----------
  window.TruckMap.init();
  document.querySelectorAll('.tabbar button').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('.tabbar button').forEach(function (x) { x.classList.toggle('active', x === b); });
      document.querySelectorAll('.tab').forEach(function (s) { s.classList.toggle('active', s.id === 'tab-' + b.dataset.tab); });
      storeSet('tab', b.dataset.tab);
      window.TruckMap.setActive(b.dataset.tab === 'map');
    });
  });
  var savedTab = document.querySelector('.tabbar button[data-tab="' + (params.get('tab') || storeGet('tab', 'drive')) + '"]');
  if (savedTab) savedTab.click();

  function paintUnits() { setText('btnUnits', units === 'mph' ? 'mph' : 'km/h'); }
  $('btnUnits').addEventListener('click', function () {
    units = units === 'mph' ? 'kmh' : 'mph';
    storeSet('units', units);
    paintUnits();
  });
  paintUnits();

  // fullscreen: Fullscreen API on Android/desktop; iPhone Safari has none -> show "Add to Home Screen" steps
  var standalone = window.matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || navigator.standalone;
  var docEl = document.documentElement;
  var fsSupported = !!(docEl.requestFullscreen || docEl.webkitRequestFullscreen);
  function isFs() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
  if (standalone) $('btnFull').classList.add('hidden');
  $('btnFull').addEventListener('click', function (e) {
    e.stopPropagation();
    if (isFs()) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      return;
    }
    if (!fsSupported) {
      if (!/iphone|ipad|ipod/i.test(navigator.userAgent)) {
        $('fsSteps').innerHTML = '<li>เปิดเมนู browser (⋮)</li><li>เลือก <b>Add to Home screen</b> / <b>Install app</b></li><li>เปิดจากไอคอนบนหน้าจอโฮม</li>';
      }
      $('fsSheet').classList.remove('hidden');
      return;
    }
    try {
      var r = docEl.requestFullscreen ? docEl.requestFullscreen({ navigationUI: 'hide' }) : docEl.webkitRequestFullscreen();
      if (r && r.catch) r.catch(function () { $('fsSheet').classList.remove('hidden'); });
    } catch (err) { $('fsSheet').classList.remove('hidden'); }
  });
  $('fsClose').addEventListener('click', function () { $('fsSheet').classList.add('hidden'); });

  // keep screen awake while dashboard is open
  var wakeLock = null;
  function requestWake() {
    if (!('wakeLock' in navigator) || wakeLock) return;
    navigator.wakeLock.request('screen').then(function (l) {
      wakeLock = l;
      l.addEventListener('release', function () { wakeLock = null; });
    }).catch(function () {});
  }
  document.addEventListener('click', requestWake);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') requestWake(); });

  // ---------- room ----------
  // Room-only mode (no local telemetry, e.g. opened from Vercel): "our" truck is the member named
  // MY_NAME, fed from its ~1/s broadcasts. Without a name (spectator) follow the first one online.
  var DEF = {
    game: { connected: true, paused: false, time: '', nextRestStopTime: '', timeScale: 19 },
    truck: {
      make: '', model: '', speed: 0, cruiseControlSpeed: 0, cruiseControlOn: false, odometer: 0, displayedGear: 0, reverseGears: 1, shifterType: '',
      engineRpm: 0, engineRpmMax: 2500, fuel: 0, fuelCapacity: 0, fuelAverageConsumption: 0, fuelWarningFactor: 0.15, fuelWarningOn: false,
      wearEngine: 0, wearTransmission: 0, wearCabin: 0, wearChassis: 0, wearWheels: 0, gameSteer: 0, gameThrottle: 0, gameBrake: 0, gameClutch: 0,
      wipersOn: false, retarderBrake: 0, parkBrakeOn: false, motorBrakeOn: false, brakeTemperature: 0, adblue: 0, adblueCapacity: 0, adblueWarningOn: false,
      airPressure: 0, airPressureWarningOn: false, airPressureEmergencyOn: false, oilTemperature: 0, oilPressure: 0, oilPressureWarningOn: false,
      waterTemperature: 0, waterTemperatureWarningOn: false, batteryVoltage: 0, batteryVoltageWarningOn: false,
      blinkerLeftOn: false, blinkerRightOn: false, lightsBeamLowOn: false, lightsBeamHighOn: false, lightsBeaconOn: false
    },
    trailer: { attached: false, name: '', mass: 0, wear: 0 },
    navigation: { estimatedTime: '', estimatedDistance: 0, speedLimit: 0 }
  };
  function merge(a, b) { var o = {}, k; for (k in a) o[k] = a[k]; for (k in b || {}) if (b[k] !== undefined && b[k] !== null) o[k] = b[k]; return o; }
  // The bridge sends every field (wear, temperatures, job, trailer...) every 5 s ("full") and only the
  // fast-changing ones in between: keep the last full copy per member and lay the light updates over it.
  var dashCache = {};
  function fromRoom(name, p) {
    var d = p.d || {}, c = dashCache[name] || (dashCache[name] = { game: {}, truck: {}, trailer: {}, job: {}, navigation: {} });
    ['game', 'truck', 'trailer', 'job', 'navigation'].forEach(function (k) {
      if (d.full) c[k] = merge({}, d[k]);          // full snapshot replaces (a finished job really clears)
      else c[k] = merge(c[k], d[k]);
    });
    var truck = merge(DEF.truck, c.truck);
    truck.placement = { x: p.x, y: 0, z: p.z, heading: p.h };
    return {
      game: merge(DEF.game, c.game), truck: truck, trailer: merge(DEF.trailer, c.trailer),
      job: c.job && c.job.destinationCity ? c.job : null, navigation: merge(DEF.navigation, c.navigation)
    };
  }

  var roomLink = null, lastSelfT = 0;
  // Who "we" are in the room = the member whose name matches ours (case / spaces ignored). Never guess:
  // showing somebody else's truck as ours (same values on every phone) is worse than asking.
  function key(n) { return String(n || '').trim().toLowerCase(); }
  function roomSelf() {
    var k = key(MY_NAME);
    if (!k) return null;
    return roomLink.members().filter(function (m) { return key(m.name) === k; })[0] || null;
  }
  function pickName(n) {
    MY_NAME = n; storeSet('name', n);
    lastSelfT = 0;
    window.TruckMap.setRoom(roomLink, n);
    onRoom();
  }
  // overlay list "which one is you?" of the members currently in the room
  function showPicker(list) {
    var el = $('overlayPick'), sig = list.map(function (m) { return m.name; }).join('|');
    if (el._sig === sig) return;
    el._sig = sig;
    el.innerHTML = '';
    list.forEach(function (m) {
      var b = document.createElement('button');
      b.innerHTML = '<i style="background:' + m.color + '"></i>';
      b.appendChild(document.createTextNode(m.name));
      b.addEventListener('click', function () { pickName(m.name); });
      el.appendChild(b);
    });
    el.classList.toggle('hidden', !list.length);
  }
  function onRoom() {
    if (API) return;   // local telemetry drives our truck; the room only adds friends
    var me = roomSelf();
    window.TruckMap.setSelf(me ? me.name : MY_NAME);
    if (roomLink.state() === 'error') { showPicker([]); setStatus('off', 'เข้าห้องไม่ได้', 'เช็ค Supabase URL / anon key ใน room-config.js'); return; }
    var online = roomLink.members().filter(function (m) { return m.online && m.pos; });
    if (!me || !me.online || !me.pos) {
      CONN_PREFIX = ''; roomCur = roomPrev = null;
      if (roomLink.state() !== 'ok') { showPicker([]); setStatus('game', 'กำลังเชื่อมต่อห้อง…', 'ห้อง ' + ROOM); return; }
      if (online.length && !me) {
        // name missing or not in the room: let the player say who they are
        showPicker(online);
        setStatus('game', MY_NAME ? 'ไม่พบชื่อ "' + MY_NAME + '" ในห้อง' : 'คุณคือใคร?',
          'แตะชื่อของคุณ (ชื่อเดียวกับที่ตั้งใน Truck Dash บน PC) · ห้อง ' + ROOM);
        return;
      }
      showPicker(online.filter(function (m) { return !me || m.name !== me.name; }));
      setStatus('game', MY_NAME ? 'รอ ' + MY_NAME + ' เข้าเกม…' : 'ยังไม่มีใครออนไลน์ในห้อง',
        'ห้อง ' + ROOM + ' · เปิด Truck Dash บน PC ของคุณ แล้วเข้าเกม' + (online.length ? ' · หรือแตะชื่อด้านล่างถ้าตั้งชื่อไว้ต่างกัน' : ''));
      return;
    }
    showPicker([]);
    CONN_PREFIX = me.name + ' · ';
    window.TruckMap.setSelfPlan(me.plan);
    if (me.pos.t !== lastSelfT) { lastSelfT = me.pos.t; roomSample(fromRoom(me.name, me.pos)); }
  }

  // Room updates arrive ~4/s: render 10/s, sliding gauges and position from the previous sample to the
  // newest over the time between them (one update behind, but no jumps).
  var roomPrev = null, roomCur = null;
  var LERP = ['speed', 'engineRpm', 'gameSteer', 'gameThrottle', 'gameBrake', 'gameClutch', 'fuel', 'airPressure'];
  function roomSample(d) {
    roomPrev = roomCur;
    roomCur = { d: d, t: performance.now() };
    if (!roomPrev) handle(d);
  }
  function roomFrame() {
    if (!roomCur || !roomPrev) return;
    var span = Math.min(3000, Math.max(100, roomCur.t - roomPrev.t));
    var f = Math.min(1, (performance.now() - roomCur.t) / span);
    var a = roomPrev.d.truck, b = roomCur.d.truck, t = {}, k;
    for (k in b) t[k] = b[k];
    LERP.forEach(function (n) { if (typeof a[n] === 'number' && typeof b[n] === 'number') t[n] = a[n] + (b[n] - a[n]) * f; });
    var pa = a.placement, pb = b.placement;
    if (pa && pb && Math.hypot(pb.x - pa.x, pb.z - pa.z) < 500) {
      var dh = pb.heading - pa.heading; dh -= Math.round(dh);
      t.placement = { x: pa.x + (pb.x - pa.x) * f, y: 0, z: pa.z + (pb.z - pa.z) * f, heading: ((pa.heading + dh * f) % 1 + 1) % 1 };
    }
    var d = {}; for (k in roomCur.d) d[k] = roomCur.d[k];
    d.truck = t;
    handle(d);
  }
  setInterval(roomFrame, 100);

  // ?demo&friends: a fake room (same API as RoomLink) to preview the multi-player map without Supabase
  // Routes come from the route server (real roads), like a real bridge would send them:
  //   Bee: same waypoints as the demo truck, saved last (= group route), driving ~1.5 km ahead
  //   Tom: his own destination (Vienna) = a diverging route, driving it
  //   Kai: parked on the group route, drops offline after 40 s
  function fakeRoom() {
    var t0 = Date.now(), C = function (n) { return { Bee: '#e8710a', Tom: '#188038', Kai: '#9334e6' }[n]; };
    var wps = [[11300, 15300], [9146, 16019]];
    var RS = 'http://' + (location.hostname || 'localhost') + ':25556/route?';
    var m = {
      Bee: { name: 'Bee', color: C('Bee'), seen: 0, pos: null, plan: null },
      Tom: { name: 'Tom', color: C('Tom'), seen: 0, pos: null, plan: null },
      Kai: { name: 'Kai', color: C('Kai'), seen: 0, pos: null, plan: null }
    };
    function getRoute(q) {
      return fetch(RS + q).then(function (r) { return r.json(); }).then(function (d) {
        if (!d.ok || !d.points || d.points.length < 2) throw new Error('no route');
        var cum = [0];
        for (var i = 1; i < d.points.length; i++) cum.push(cum[i - 1] + Math.hypot(d.points[i][0] - d.points[i - 1][0], d.points[i][1] - d.points[i - 1][1]));
        return { points: d.points, cum: cum };
      });
    }
    // position + heading at distance d along a route
    function along(r, d) {
      var c = r.cum, p = r.points, i = 0;
      d = Math.max(0, Math.min(d, c[c.length - 1]));
      while (i < c.length - 2 && c[i + 1] < d) i++;
      var f = (d - c[i]) / ((c[i + 1] - c[i]) || 1), dx = p[i + 1][0] - p[i][0], dz = p[i + 1][1] - p[i][1];
      var h = Math.atan2(-dx, -dz) / (Math.PI * 2);
      return { x: p[i][0] + dx * f, z: p[i][1] + dz * f, h: h < 0 ? h + 1 : h, end: d >= c[c.length - 1] };
    }
    // demo runs 4x speed; s is sent 4x too so the map's prediction between updates matches
    var bee = null, tom = null, U = 4 / 3.6;   // units per second per km/h
    getRoute('x=13475&z=14618&h=0.2&via=' + wps.join(';')).then(function (r) {
      bee = r;
      m.Bee.plan = { name: 'Bee', savedAt: 2, routeAt: 1, wps: wps, route: r.points };
      var k = along(r, r.cum[r.cum.length - 1] * 0.15);
      m.Kai.pos = { x: k.x, z: k.z, h: k.h, s: 0, p: false, t: Date.now() };
    }).catch(function () {});
    getRoute('x=13700&z=13950&h=0.75&via=20825,13966').then(function (r) {
      tom = r;
      m.Tom.plan = { name: 'Tom', savedAt: 1, routeAt: 1, wps: [[20825, 13966]], route: r.points };
    }).catch(function () {});
    setInterval(function () {
      var s = (Date.now() - t0) / 1000, now = Date.now();
      if (bee) { var b = along(bee, 1500 + s * 66 * U); m.Bee.pos = { x: b.x, z: b.z, h: b.h, s: b.end ? 0 : 66 * 4, p: false, t: now }; m.Bee.seen = now; }
      if (tom) { var o = along(tom, s * 58 * U); m.Tom.pos = { x: o.x, z: o.z, h: o.h, s: o.end ? 0 : 58 * 4, p: false, t: now }; m.Tom.seen = now; }
      if (m.Kai.pos && s < 40) m.Kai.seen = now;
    }, 1000);
    return {
      room: 'DEMO-ROOM', state: function () { return 'ok'; },
      members: function () { var now = Date.now(); return Object.keys(m).map(function (k) { m[k].online = now - m[k].seen < 10000; return m[k]; }); },
      member: function (n) { return m[n] || null; },
      leader: function () { return m.Bee.online ? m.Bee : null; },
      close: function () {}
    };
  }

  // ---------- start ----------
  if (DEMO && params.has('friends') && window.RoomLink) window.TruckMap.setRoom(fakeRoom(), 'ฉัน');
  if (ROOM_ON && !DEMO) {
    roomLink = window.RoomLink.start({ url: RC.supabaseUrl, key: RC.supabaseAnonKey, room: ROOM, onChange: onRoom });
    window.TruckMap.setRoom(roomLink, MY_NAME);
    if (!API) window.TruckMap.setRemote(true);
  }
  if (DEMO) { demoLoop(); }
  else if (API) { poll(); }
  else if (!ROOM_ON) {
    var why = ROOM && !(RC.supabaseUrl && RC.supabaseAnonKey) ? 'ยังไม่ได้ตั้งค่า Supabase ใน room-config.js' : 'ยังไม่ได้เลือกห้อง';
    setStatus('off', why, 'เปิดหน้า connect.html เพื่อใส่ชื่อ + room code หรือเปิดผ่าน ?server=<PC-IP>:25555 · ?demo เพื่อดูตัวอย่าง');
  }
})();

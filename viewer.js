'use strict';

// First-person view from a ground spot: PLATEAU buildings and bridge decks
// (the same data as the visibility analysis), the landmark, distant mountains
// (a skyline from the GSI DEM, e.g. Mt. Fuji) and the moon or sun.
// deck.gl is loaded on first use so the map page stays light.
(() => {
  const DECK_URL = 'https://unpkg.com/deck.gl@9.1.14/dist.min.js';
  const NEAR_M = 600;        // load every building this close to the eye
  const CORRIDOR_M = 350;    // and within this distance of the line to the tower
  const FAR = 60000;
  const MOON_DIST = 40000;   // where the moon/sun disk is placed for projection

  let deckLib = null;
  let deckgl = null;
  let tileIndex = null;
  const tileCache = new Map();
  let ctx = null;            // current view: spot, time, body, viewState, fovy...
  const SKY_SPAN = 30;       // skyline azimuths computed on each side of the landmark [deg]
  const SKY_STEP = 0.04;     // [deg]
  const SKY_NEAR = 2000;     // nearer terrain is flat city; buildings cover it
  const SKY_FAR = 160000;
  const DEM_Z = 12;
  const demTiles = new Map();
  const drop = (d) => d * d * (1 - 0.13) / (2 * 6371000);   // curvature minus refraction

  const $ = (id) => document.getElementById(id);
  const D2R = Math.PI / 180;

  function loadDeck() {
    if (!deckLib) {
      deckLib = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = DECK_URL;
        s.onload = () => resolve(window.deck);
        s.onerror = () => reject(new Error('deck.gl を読み込めませんでした'));
        document.head.append(s);
      });
    }
    return deckLib;
  }

  function mPerDeg(lat) {
    const p = lat * D2R;
    return [111132.954 - 559.822 * Math.cos(2 * p), 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p)];
  }
  function move(lat, lon, bearing, d) {
    const [a, b] = mPerDeg(lat);
    return [lat + d * Math.cos(bearing * D2R) / a, lon + d * Math.sin(bearing * D2R) / b];
  }
  // accurate far out: local plane at the midpoint plus the meridian convergence
  function destination(lat, lon, az, d) {
    let la = lat, lo = lon, conv = 0;
    for (let i = 0; i < 3; i++) {
      const mid = (lat + la) / 2;
      const [a, b] = mPerDeg(mid);
      const t = (az + conv / 2) * D2R;
      la = lat + d * Math.cos(t) / a;
      lo = lon + d * Math.sin(t) / b;
      conv = (lo - lon) * Math.sin(mid * D2R);
    }
    return [la, lo];
  }
  function tileXY(lat, lon, z) {
    const n = 2 ** z;
    const s = Math.sin(lat * D2R);
    return [Math.floor((lon + 180) / 360 * n), Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n)];
  }
  function tileNW(x, y, z) {
    const n = 2 ** z;
    return [Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) / D2R, x / n * 360 - 180];
  }

  // ---------- building tiles ----------
  async function neededTiles(spot, target, dist, bearing) {
    if (!tileIndex) {
      const meta = await (await fetch(`${window.viewerConfig.viewTiles}/index.json?v=${window.viewerConfig.version}`)).json();
      tileIndex = { zoom: meta.zoom, keys: new Set(meta.tiles) };
    }
    const z = tileIndex.zoom;
    const keys = new Set();
    const add = (lat, lon) => {
      const [x, y] = tileXY(lat, lon, z);
      const k = `${x}/${y}`;
      if (tileIndex.keys.has(k)) keys.add(k);
    };
    for (let a = 0; a < 360; a += 20) for (const r of [0, NEAR_M / 2, NEAR_M]) add(...move(spot.lat, spot.lon, a, r));
    for (let d = 0; d <= dist + 300; d += 150) {
      const [la, lo] = move(spot.lat, spot.lon, bearing, d);
      for (const side of [-CORRIDOR_M, 0, CORRIDOR_M]) add(...move(la, lo, bearing + 90, side));
    }
    return [...keys];
  }

  function loadTile(key) {
    if (!tileCache.has(key)) {
      const [x, y] = key.split('/').map(Number);
      tileCache.set(key, fetch(`${window.viewerConfig.viewTiles}/${tileIndex.zoom}/${key}.json?v=${window.viewerConfig.version}`)
        .then((r) => r.json())
        .then((t) => {
          const [lat0, lon0] = tileNW(x, y, tileIndex.zoom);
          const ring = (a, from, z) => {
            const pts = [];
            for (let i = from; i < a.length; i += 2) pts.push([lon0 + a[i] * 1e-6, lat0 - a[i + 1] * 1e-6, z]);
            return pts;
          };
          return {
            buildings: t.b.map((a) => ({ polygon: ring(a, 2, a[0] / 10), h: a[1] / 10 })),
            decks: t.d.map((a) => ({ polygon: ring(a, 1, a[0] / 10 - 0.6), h: 1.2 })),
          };
        })
        .catch(() => ({ buildings: [], decks: [] })));
    }
    return tileCache.get(key);
  }

  // ---------- distant terrain skyline (GSI DEM) ----------
  function demTile(key) {
    if (!demTiles.has(key)) {
      const [x, y] = key.split('/');
      demTiles.set(key, null);
      fetch(`https://cyberjapandata.gsi.go.jp/xyz/dem_png/${DEM_Z}/${x}/${y}.png`)
        .then((r) => (r.ok ? r.blob() : null))
        .then((b) => (b ? createImageBitmap(b, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }) : null))
        .then((bmp) => {
          const h = new Float32Array(256 * 256);   // sea / missing tiles stay 0
          if (bmp) {
            const c = document.createElement('canvas');
            c.width = c.height = 256;
            const g = c.getContext('2d', { willReadFrequently: true });
            g.drawImage(bmp, 0, 0);
            const p = g.getImageData(0, 0, 256, 256).data;
            for (let i = 0; i < h.length; i++) {
              const v = p[i * 4] * 65536 + p[i * 4 + 1] * 256 + p[i * 4 + 2];
              h[i] = v === 8388608 ? 0 : (v < 8388608 ? v : v - 16777216) * 0.01;
            }
          }
          demTiles.set(key, h);
          scheduleSkyline();
        })
        .catch(() => demTiles.set(key, new Float32Array(256 * 256)));
    }
    return demTiles.get(key);
  }
  function demAt(lat, lon) {
    const n = 256 * 2 ** DEM_Z;
    const s = Math.sin(lat * D2R);
    const x = (lon + 180) / 360 * n, y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
    const tx = Math.floor(x / 256), ty = Math.floor(y / 256);
    const t = demTile(`${tx}/${ty}`);
    return t ? t[(Math.floor(y) - ty * 256) * 256 + (Math.floor(x) - tx * 256)] : undefined;
  }
  // highest apparent elevation of the terrain in each direction around the landmark
  function computeSkyline() {
    if (!ctx) return;
    const az0 = ctx.towerBearing - SKY_SPAN;
    const n = Math.round(2 * SKY_SPAN / SKY_STEP) + 1;
    const alts = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const az = az0 + i * SKY_STEP;
      let best = -1;
      for (let d = SKY_NEAR; d < SKY_FAR; d += Math.max(60, d * 0.01)) {
        const [la, lo] = destination(ctx.spot.lat, ctx.spot.lon, az, d);
        const h = demAt(la, lo);
        if (h === undefined) continue;   // tile still loading; redrawn when it arrives
        const alt = Math.atan2(h - drop(d) - ctx.eye, d) / D2R;
        if (alt > best) best = alt;
      }
      alts[i] = best;
    }
    ctx.skyline = { az0, alts };
    placeOverlay();
  }
  let skylineTimer = null;
  function scheduleSkyline() {
    clearTimeout(skylineTimer);
    skylineTimer = setTimeout(computeSkyline, 120);
  }
  function drawSkyline(vp) {
    const cv = $('viewer-skyline');
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(vp.width * dpr) || cv.height !== Math.round(vp.height * dpr)) {
      cv.width = Math.round(vp.width * dpr);
      cv.height = Math.round(vp.height * dpr);
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, vp.width, vp.height);
    const sl = ctx.skyline;
    if (!sl) return;
    const pts = [];
    sl.alts.forEach((alt, i) => {
      const az = sl.az0 + i * SKY_STEP;
      if (Math.cos((az - ctx.viewState.bearing) * D2R) < 0.2) return;
      const [la, lo] = move(ctx.spot.lat, ctx.spot.lon, az, MOON_DIST * Math.cos(alt * D2R));
      const [x, y] = vp.project([lo, la, ctx.eye + MOON_DIST * Math.sin(alt * D2R)]);
      pts.push([x, y]);
    });
    if (pts.length < 2) return;
    const night = ctx.sunAlt < -4;
    g.fillStyle = night ? '#121827' : ctx.sunAlt < 4 ? '#2a3550' : '#7b8aa3';
    g.beginPath();
    g.moveTo(pts[0][0], vp.height);
    pts.forEach(([x, y]) => g.lineTo(x, y));
    g.lineTo(pts.at(-1)[0], vp.height);
    g.closePath();
    g.fill();
  }

  // ---------- sky / bodies ----------
  function skyGradient(sunAlt) {
    if (sunAlt > 6) return 'linear-gradient(#5b8fd1 0%, #a9c9ec 55%, #dfe9f3 100%)';
    if (sunAlt > -2) return 'linear-gradient(#36537e 0%, #c97b5a 70%, #f2b36b 100%)';
    if (sunAlt > -8) return 'linear-gradient(#141f3d 0%, #34406a 60%, #8a6a73 100%)';
    return 'linear-gradient(#050814 0%, #0d1530 65%, #1d2746 100%)';
  }

  function bodyAt(date) {
    const obs = new Astronomy.Observer(ctx.spot.lat, ctx.spot.lon, ctx.eye);
    const eq = Astronomy.Equator(ctx.body, date, obs, true, true);
    const hor = Astronomy.Horizon(date, obs, eq.ra, eq.dec, 'normal');
    const km = ctx.body === 'Moon' ? 1737.4 : 695700;
    const sun = Astronomy.Horizon(date, obs, ...(() => { const s = Astronomy.Equator('Sun', date, obs, true, true); return [s.ra, s.dec]; })(), 'normal');
    return { az: hor.azimuth, alt: hor.altitude, sd: Math.asin(km / (eq.dist * 149597870.7)) / D2R, sunAlt: sun.altitude };
  }

  // ---------- layers ----------
  function layers(data) {
    const { SolidPolygonLayer, ColumnLayer, BitmapLayer } = window.deck;
    const night = ctx.sunAlt < -2;
    const [lat, lon] = [ctx.spot.lat, ctx.spot.lon];
    const g = ctx.ground;
    const big = 0.25;
    const out = [
      new SolidPolygonLayer({
        id: 'ground', data: [{ polygon: [[lon - big, lat - big, g], [lon + big, lat - big, g], [lon + big, lat + big, g], [lon - big, lat + big, g]] }],
        getPolygon: (d) => d.polygon, getFillColor: night ? [24, 28, 38] : [120, 124, 120],
      }),
    ];
    // aerial photo under the observer for orientation
    const z = 17;
    const [tx, ty] = tileXY(lat, lon, z);
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const [n, w] = tileNW(tx + dx, ty + dy, z);
        const [s, e] = tileNW(tx + dx + 1, ty + dy + 1, z);
        out.push(new BitmapLayer({
          id: `photo-${dx}-${dy}`, image: `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${z}/${tx + dx}/${ty + dy}.jpg`,
          bounds: [[w, s, g + 0.05], [w, n, g + 0.05], [e, n, g + 0.05], [e, s, g + 0.05]],
          tintColor: night ? [70, 75, 95] : [255, 255, 255], parameters: { depthTest: true },
        }));
      }
    }
    out.push(
      new SolidPolygonLayer({
        id: 'buildings', data: data.buildings, extruded: true, getPolygon: (d) => d.polygon, getElevation: (d) => d.h,
        getFillColor: night ? [52, 58, 74] : [196, 198, 204], material: { ambient: 0.45, diffuse: 0.6, shininess: 8 },
      }),
      new SolidPolygonLayer({
        id: 'decks', data: data.decks, extruded: true, getPolygon: (d) => d.polygon, getElevation: (d) => d.h,
        getFillColor: night ? [70, 70, 80] : [150, 150, 160],
      }),
    );
    // rough silhouette of the landmark: stacked columns [bottom, top, radius]
    const lm = window.viewerConfig.landmark;
    lm.model.forEach(([b, t, r], i) => out.push(new ColumnLayer({
      id: `tower-${i}`, data: [0], diskResolution: lm.sides, radius: r, angle: 45, extruded: true,
      getPosition: () => [lm.lon, lm.lat, lm.base + b], getElevation: () => t - b,
      getFillColor: night ? lm.night_color : lm.color, material: { ambient: night ? 0.9 : 0.5, diffuse: 0.5 },
    })));
    return out;
  }

  // ---------- overlay ----------
  // The moon/sun is an element stacked between the sky and the transparent 3D
  // canvas: it is infinitely far, so buildings and the tower drawn by deck.gl
  // cover it exactly where they should.
  function placeOverlay() {
    if (!deckgl || !ctx) return;
    const vp = deckgl.getViewports()[0];
    if (!vp) return;
    const lm = window.viewerConfig.landmark;
    const vs = ctx.viewState;
    const el = $('viewer-body');
    const b = ctx.bodyPos;
    const [blat, blon] = move(ctx.spot.lat, ctx.spot.lon, b.az, MOON_DIST * Math.cos(b.alt * D2R));
    const pos = vp.project([blon, blat, ctx.eye + MOON_DIST * Math.sin(b.alt * D2R)]);
    const up = -vs.pitch;  // deck.gl's first-person pitch is positive looking down
    const ahead = Math.cos((b.az - vs.bearing) * D2R) * Math.cos(b.alt * D2R) * Math.cos(up * D2R) +
      Math.sin(b.alt * D2R) * Math.sin(up * D2R) > 0.2;
    const rpx = vp.height / 2 / Math.tan(ctx.fovy / 2 * D2R) * Math.tan(b.sd * D2R);
    Object.assign(el.style, {
      display: ahead && b.alt > -1 ? 'block' : 'none', left: `${pos[0]}px`, top: `${pos[1]}px`,
      width: `${2 * rpx}px`, height: `${2 * rpx}px`,
    });
    el.className = ctx.body === 'Sun' ? 'sun' : 'moon';
    const [tla, tlo] = move(ctx.spot.lat, ctx.spot.lon, ctx.towerBearing, MOON_DIST * Math.cos(ctx.tipAlt * D2R));
    const tip = vp.project([tlo, tla, ctx.eye + MOON_DIST * Math.sin(ctx.tipAlt * D2R)]);
    drawSkyline(vp);
    const lab = $('viewer-label');
    const towerAhead = Math.cos((ctx.towerBearing - vs.bearing) * D2R) > 0.3;
    Object.assign(lab.style, { display: towerAhead ? 'block' : 'none', left: `${tip[0]}px`, top: `${tip[1]}px` });
  }

  function setTime(minutes) {
    const date = new Date(ctx.baseTime + minutes * 60000);
    ctx.bodyPos = bodyAt(date);
    ctx.sunAlt = ctx.bodyPos.sunAlt;
    $('viewer-sky').style.background = skyGradient(ctx.sunAlt);
    const fmt = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    $('viewer-time').textContent = fmt.format(date);
    $('viewer-offset').textContent = minutes === 0 ? '' : `（${minutes > 0 ? '+' : ''}${minutes}分）`;
    // where the moon/sun is relative to the landmark, so it can be found when off screen
    const name = ctx.body === 'Moon' ? '月' : '太陽';
    const b = ctx.bodyPos;
    const dAz = wrap180(b.az - ctx.towerBearing);
    const side = Math.abs(dAz) < 1 ? 'と同じ方向' : `の${dAz > 0 ? '右' : '左'}${Math.abs(dAz).toFixed(0)}°`;
    $('viewer-alt').textContent = b.alt < -0.5
      ? `${name}は地平線の下（${window.viewerConfig.landmark.short}${side}）`
      : `${name}は${window.viewerConfig.landmark.short}${side}・高さ${b.alt.toFixed(1)}°`;
    deckgl?.setProps({ layers: layers(ctx.data) });
    placeOverlay();
  }

  function setFocal(mm) {
    ctx.focal = mm;
    ctx.fovy = 2 * Math.atan(12 / mm) / D2R;   // 35mm frame, landscape (24 mm tall)
    $('viewer-focal-value').textContent = `${mm}mm`;
    deckgl?.setProps({ views: new window.deck.FirstPersonView({ fovy: ctx.fovy, near: 0.3, far: FAR }) });
    placeOverlay();
  }

  const wrap180 = (a) => ((a % 360) + 540) % 360 - 180;

  // Aim at the landmark itself. Only when the moon/sun is close enough to share
  // the frame is the view shifted to hold both; the top always stays in frame.
  function faceTower() {
    const b = ctx.bodyPos;
    const lm = window.viewerConfig.landmark;
    const el = $('viewer-canvas');
    const aspect = (el.clientWidth || 1) / (el.clientHeight || 1);
    const vfov = ctx.fovy;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2 * D2R) * aspect) / D2R;
    const baseAlt = Math.atan2(lm.base - ctx.eye - drop(ctx.dist), ctx.dist) / D2R;
    // a tower: its middle; a far mountain: just below the top (the foot is hidden by hills)
    let up = lm.far ? ctx.tipAlt - vfov * 0.2 : (ctx.tipAlt + baseAlt) / 2;
    let az = ctx.towerBearing;
    const dAz = wrap180(b.az - az);
    if (b.alt > -1 && Math.abs(dAz) < hfov * 0.4 && Math.abs(b.alt - ctx.tipAlt) < vfov * 0.8) {
      up = (up + b.alt) / 2;
      az += dAz / 2;
    }
    up = Math.min(Math.max(up, ctx.tipAlt - vfov * 0.4), ctx.tipAlt + vfov * 0.4);
    ctx.viewState = { ...ctx.viewState, bearing: (az + 360) % 360, pitch: -Math.min(80, Math.max(-20, up)) };
    deckgl?.setProps({ viewState: ctx.viewState });
    placeOverlay();
  }

  async function open(opts) {
    const root = $('viewer');
    root.hidden = false;
    $('viewer-label').textContent = window.viewerConfig.landmark.short;
    $('viewer-face').textContent = `${window.viewerConfig.landmark.short}を向く`;
    $('viewer-status').textContent = '3Dデータを読み込み中…';
    $('viewer-title').textContent = opts.title;
    const lm = window.viewerConfig.landmark;
    const [mLatM, mLonM] = mPerDeg((lm.lat + opts.lat) / 2);
    const dn = (lm.lat - opts.lat) * mLatM, de = (lm.lon - opts.lon) * mLonM;
    const dist = Math.hypot(dn, de);
    // azimuth at the observer (the meridian convergence matters far away)
    const towerAz = (Math.atan2(de, dn) / D2R - (lm.lon - opts.lon) * Math.sin((lm.lat + opts.lat) / 2 * D2R) / 2 + 360) % 360;
    ctx = {
      spot: { lat: opts.lat, lon: opts.lon }, ground: opts.ground, eye: opts.ground + 1.6, body: opts.body,
      baseTime: opts.time, towerBearing: towerAz,
      tipAlt: Math.atan2(lm.base + lm.height - opts.ground - 1.6 - drop(dist), dist) / D2R,
      dist,
      data: { buildings: [], decks: [] },
    };
    ctx.viewState = { longitude: opts.lon, latitude: opts.lat, position: [0, 0, ctx.eye], bearing: ctx.towerBearing, pitch: 0, maxPitch: 60, minPitch: -89 };
    $('viewer-time-slider').value = 0;
    $('viewer-focal').value = opts.focal;
    setFocal(opts.focal);
    setTime(0);
    faceTower();
    computeSkyline();

    try {
      const deck = await loadDeck();
      if (!deckgl) {
        deckgl = new deck.Deck({
          parent: $('viewer-canvas'), views: new deck.FirstPersonView({ fovy: ctx.fovy, near: 0.3, far: FAR }),
          viewState: ctx.viewState, controller: { keyboard: true, dragPan: true, scrollZoom: false },
          onViewStateChange: ({ viewState }) => { ctx.viewState = viewState; deckgl.setProps({ viewState }); },
          onAfterRender: placeOverlay, layers: [],
          parameters: { clearColor: [0, 0, 0, 0] },
        });
      }
      deckgl.setProps({ viewState: ctx.viewState, views: new deck.FirstPersonView({ fovy: ctx.fovy, near: 0.3, far: FAR }) });
      // buildings far beyond a few km cannot hide anything that is not already hidden
      const keys = await neededTiles(ctx.spot, lm, Math.min(dist, 10000), ctx.towerBearing);
      const tiles = await Promise.all(keys.map(loadTile));
      if (!ctx || root.hidden) return;
      ctx.data = { buildings: tiles.flatMap((t) => t.buildings), decks: tiles.flatMap((t) => t.decks) };
      deckgl.setProps({ layers: layers(ctx.data) });
      $('viewer-status').textContent = `建物 ${ctx.data.buildings.length.toLocaleString()}棟（${lm.short}の方向と周囲${NEAR_M}m）`;
    } catch (e) {
      $('viewer-status').textContent = e.message;
    }
  }

  function close() {
    $('viewer').hidden = true;
  }

  function setup() {
    $('viewer-close').addEventListener('click', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('viewer').hidden) close(); });
    $('viewer-time-slider').addEventListener('input', (e) => setTime(Number(e.target.value)));
    $('viewer-focal').addEventListener('input', (e) => setFocal(Number(e.target.value)));
    $('viewer-face').addEventListener('click', faceTower);
    window.addEventListener('resize', placeOverlay);
  }

  window.openViewer = open;
  document.addEventListener('DOMContentLoaded', setup);
})();

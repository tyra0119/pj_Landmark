'use strict';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const EARTH_R = 6371000;
const REFRACTION_K = 0.13;
const STEP_SEC = 15;          // time step of the alignment path
const SAMPLE_M = 2;           // spacing of visibility samples along the path
const MIN_DIST = 500;         // closer than this you look almost straight up
const MERGE_GAP = 3;          // hidden samples tolerated inside one spot
const SCAN_DAYS = 365;
const BUILDING = -1;
const OUTSIDE = -2;

const WARDS = {
  13101: '千代田区', 13102: '中央区', 13103: '港区', 13104: '新宿区', 13105: '文京区', 13106: '台東区',
  13107: '墨田区', 13108: '江東区', 13109: '品川区', 13110: '目黒区', 13111: '大田区', 13112: '世田谷区',
  13113: '渋谷区', 13114: '中野区', 13115: '杉並区', 13116: '豊島区', 13117: '北区', 13118: '荒川区',
  13119: '板橋区', 13120: '練馬区', 13121: '足立区', 13122: '葛飾区', 13123: '江戸川区',
};
const BODY_LABEL = { Moon: '月', Sun: '太陽' };

const state = { body: 'Moon', mode: 'center', date: null, meta: null, run: 0, pointRun: 0 };
let map, LM, zTop, obsLM, palette;
let timeMarkers = [];
let pointMarker = null;

// ---------- time formatting (always JST) ----------
const fmtTime = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtHM = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
const fmtDay = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short' });
const fmtYmd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' });
const jstMidnight = (ymd) => new Date(`${ymd}T00:00:00+09:00`);

// ---------- geometry ----------
function worldPx(lat, lon, z) {
  const n = 256 * 2 ** z;
  const s = Math.sin(lat * D2R);
  return [(lon + 180) / 360 * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}
function metersPerDeg(lat) {
  const p = lat * D2R;
  return [111132.954 - 559.822 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p),
    111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p)];
}
function offset(lat, lon, bearing, d) {
  const [mLat, mLon] = metersPerDeg(lat);
  return [lat + d * Math.cos(bearing * D2R) / mLat, lon + d * Math.sin(bearing * D2R) / mLon];
}
function distBearing(lat1, lon1, lat2, lon2) {
  const [mLat, mLon] = metersPerDeg((lat1 + lat2) / 2);
  const dn = (lat2 - lat1) * mLat;
  const de = (lon2 - lon1) * mLon;
  return [Math.hypot(dn, de), (Math.atan2(de, dn) * R2D + 360) % 360];
}
const drop = (d) => d * d * (1 - REFRACTION_K) / (2 * EARTH_R);
// apparent elevation [deg] of a point at absolute height z seen from distance d, eye height zO
const elevAngle = (z, zO, d) => Math.atan2(z - zO - drop(d), d) * R2D;
function solveDistance(alt, zO) {
  const t = Math.tan(alt * D2R);
  let d = (zTop - zO) / t;
  for (let i = 0; i < 3; i++) d = (zTop - zO - drop(d)) / t;
  return d;
}
function separation(az1, alt1, az2, alt2) {
  const c = Math.sin(alt1 * D2R) * Math.sin(alt2 * D2R) +
    Math.cos(alt1 * D2R) * Math.cos(alt2 * D2R) * Math.cos((az1 - az2) * D2R);
  return Math.acos(Math.min(1, Math.max(-1, c))) * R2D;
}
const compass = (b) => ['北', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東', '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西'][Math.round(b / 22.5) % 16];

// ---------- astronomy ----------
function bodyHor(body, date, obs = obsLM) {
  const eq = Astronomy.Equator(body, date, obs, true, true);
  const hor = Astronomy.Horizon(date, obs, eq.ra, eq.dec, 'normal');
  const radiusKm = body === 'Moon' ? 1737.4 : 695700;
  return { az: hor.azimuth, alt: hor.altitude, sd: Math.asin(radiusKm / (eq.dist * 149597870.7)) * R2D };
}
function skyLabel(date, obs = obsLM) {
  const s = bodyHor('Sun', date, obs).alt;
  if (s > 0) return { text: '日中', night: false };
  if (s > -6) return { text: '薄明（明るい）', night: true };
  if (s > -12) return { text: '薄明', night: true };
  return { text: '夜', night: true };
}
function moonPhaseText(date) {
  const ill = Astronomy.Illumination('Moon', date).phase_fraction;
  const waxing = Astronomy.MoonPhase(date) < 180;
  return `輝面${Math.round(ill * 100)}%${ill > 0.98 ? '（満月）' : waxing ? '・満ちていく' : '・欠けていく'}`;
}

// ---------- raster lookups ----------
const pixelCache = new Map();
function pixels(url) {
  if (!pixelCache.has(url)) {
    pixelCache.set(url, (async () => {
      const res = await fetch(url);
      if (!res.ok) return null;
      const bmp = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      return ctx.getImageData(0, 0, c.width, c.height).data;
    })().catch(() => null));
  }
  return pixelCache.get(url);
}
async function samplePixel(urlFor, lat, lon, z) {
  const [x, y] = worldPx(lat, lon, z);
  const tx = Math.floor(x / 256), ty = Math.floor(y / 256);
  const data = await pixels(urlFor(z, tx, ty));
  if (!data) return null;
  const i = ((Math.floor(y) - ty * 256) * 256 + (Math.floor(x) - tx * 256)) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
}
async function classAt(lat, lon) {
  const [w, s, e, n] = state.meta.bounds;
  if (lon < w || lon > e || lat < s || lat > n) return OUTSIDE;
  const p = await samplePixel((z, x, y) => state.meta.tiles.replace('{z}', z).replace('{x}', x).replace('{y}', y),
    lat, lon, state.meta.data_zoom);
  if (!p) return OUTSIDE;
  if (p[3] === 0) return distBearing(lat, lon, LM.lat, LM.lon)[0] > state.meta.radius_m ? OUTSIDE : BUILDING;
  if (p[3] < 255) return 0;  // "tip hidden" is the only translucent class
  const idx = palette.get(`${p[0]},${p[1]},${p[2]}`);
  return idx === undefined ? OUTSIDE : idx;
}
function decodeDem(p) {
  if (!p) return null;
  const v = p[0] * 65536 + p[1] * 256 + p[2];
  if (v === 8388608) return null;
  return (v < 8388608 ? v : v - 16777216) * 0.01;
}
async function elevationAt(lat, lon) {
  const gsi = (layer) => (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/${layer}/${z}/${x}/${y}.png`;
  const h = decodeDem(await samplePixel(gsi('dem5a_png'), lat, lon, 15)) ??
    decodeDem(await samplePixel(gsi('dem10b_png'), lat, lon, 14));
  return h ?? 0;
}
const geoCache = new Map();
async function placeName(lat, lon) {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (!geoCache.has(key)) {
    geoCache.set(key, fetch(`https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${lat}&lon=${lon}`)
      .then((r) => r.json())
      .then((j) => j.results ? `${WARDS[j.results.muniCd] ?? ''}${j.results.lv01Nm.replace('－', '')}` : '')
      .catch(() => ''));
  }
  return geoCache.get(key);
}

// ---------- alignment path for one day ----------
async function computeDay(ymd, body, mode, run) {
  const start = jstMidnight(ymd).getTime();
  const altMax = elevAngle(zTop, LM.base, MIN_DIST);
  const altMin = elevAngle(zTop, LM.base, state.meta.radius_m);

  // 1) where the observer would stand, assuming ground at the landmark's base
  const cands = [];
  for (let k = 0, t = start; t < start + 86400e3; k++, t += STEP_SEC * 1000) {
    const h = bodyHor(body, new Date(t));
    const target = mode === 'perch' ? h.alt - h.sd : h.alt;
    if (target < altMin - 0.2 || target > altMax) continue;
    const bearing = (h.az + 180) % 360;
    const [lat, lon] = offset(LM.lat, LM.lon, bearing, solveDistance(target, LM.base));
    cands.push({ k, t, h, target, bearing, lat, lon });
  }

  // 2) correct for the local ground height (tiles fetched in parallel)
  const ground = await Promise.all(cands.map((c) => elevationAt(c.lat, c.lon)));
  if (run !== state.run) return null;
  const passes = [];
  let cur = null, prevK = -2;
  cands.forEach((c, i) => {
    const zO = ground[i] + state.meta.eye_height;
    const d = solveDistance(c.target, zO);
    if (d > state.meta.radius_m || d < MIN_DIST) { prevK = -2; return; }
    const [lat, lon] = offset(LM.lat, LM.lon, c.bearing, d);
    // a new pass after a gap, or when the body crosses the meridian (south)
    if (c.k !== prevK + 1 || (cur && (cur.points.at(-1).az < 180) !== (c.h.az < 180))) { cur = { points: [] }; passes.push(cur); }
    prevK = c.k;
    cur.points.push({ t: c.t, lat, lon, d, az: c.h.az, alt: c.h.alt, sd: c.h.sd, zO });
  });

  // 3) sample visibility every SAMPLE_M metres along each pass
  for (const pass of passes) {
    pass.rising = pass.points[0].az < 180;
    pass.samples = [];
    const pts = pass.points;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[i + 1];
      const m = q ? Math.max(1, Math.ceil(distBearing(p.lat, p.lon, q.lat, q.lon)[0] / SAMPLE_M)) : 1;
      for (let j = 0; j < m; j++) {
        const f = j / m;
        const lerp = (key) => q ? p[key] + (q[key] - p[key]) * f : p[key];
        pass.samples.push({ t: lerp('t'), lat: lerp('lat'), lon: lerp('lon'), d: lerp('d'), alt: lerp('alt'), az: lerp('az'), sd: p.sd, zO: lerp('zO') });
      }
    }
  }
  const samples = passes.flatMap((p) => p.samples);
  const classes = await Promise.all(samples.map((s) => classAt(s.lat, s.lon)));
  if (run !== state.run) return null;
  samples.forEach((s, i) => { s.cls = classes[i]; });
  passes.forEach((p) => { p.spots = findSpots(p.samples); });
  return passes;
}

function findSpots(samples) {
  const spots = [];
  let run = null, gap = 0;
  const close = () => {
    if (run && run.end - run.start >= 1) spots.push(run);
    run = null;
  };
  samples.forEach((s, i) => {
    if (s.cls >= 1) {
      if (!run) run = { start: i, end: i, best: s.cls };
      run.end = i; run.best = Math.max(run.best, s.cls); gap = 0;
    } else if (run && ++gap > MERGE_GAP) close();
  });
  close();
  return spots.map((r) => {
    const a = samples[r.start], b = samples[r.end], mid = samples[Math.round((r.start + r.end) / 2)];
    return { from: a.t, to: b.t, mid, length: distBearing(a.lat, a.lon, b.lat, b.lon)[0], best: r.best, coords: samples.slice(r.start, r.end + 1).map((s) => [s.lon, s.lat]) };
  });
}

// ---------- rendering ----------
function pathGeoJSON(passes) {
  const features = [];
  for (const pass of passes) {
    let seg = null;
    pass.samples.forEach((s) => {
      const vis = s.cls >= 1 ? 'visible' : s.cls === 0 ? 'hidden' : s.cls === BUILDING ? 'building' : 'outside';
      if (!seg || seg.properties.vis !== vis) {
        if (seg) seg.geometry.coordinates.push([s.lon, s.lat]);
        seg = { type: 'Feature', properties: { vis }, geometry: { type: 'LineString', coordinates: [[s.lon, s.lat]] } };
        features.push(seg);
      } else seg.geometry.coordinates.push([s.lon, s.lat]);
    });
  }
  return { type: 'FeatureCollection', features: features.filter((f) => f.geometry.coordinates.length > 1) };
}

function spotDetails(s) {
  const tipAlt = elevAngle(zTop, s.zO, s.d);
  const baseAlt = elevAngle(LM.base, s.zO, s.d);
  const tower = tipAlt - baseAlt;
  const focal = 36 * 0.8 / (2 * Math.tan(tower * D2R / 2));
  return { tipAlt, tower, focal, moonMm: 2 * focal * Math.tan(s.sd * D2R) };
}

function visibleText(cls) {
  if (cls < 1) return '先端は見えません';
  if (cls === 1) return '先端付近だけ見えます';
  const lowest = state.meta.levels[cls - 1];
  return lowest <= 50 ? 'ほぼ全体が見えます' : `上から約${state.meta.landmark.height - lowest}m以上が見えます`;
}

function renderSpots(passes) {
  const list = document.getElementById('spots');
  list.innerHTML = '';
  timeMarkers.forEach((m) => m.remove());
  timeMarkers = [];
  const all = passes.flatMap((p) => p.spots);
  const label = BODY_LABEL[state.body];
  document.getElementById('summary').textContent = passes.length === 0
    ? `この日は、半径${state.meta.radius_m / 1000}km以内で${label}がスカイツリーの先端に重なる時間がありません。`
    : all.length === 0
      ? `${label}は重なりますが、建物に遮られて地上から見える場所が見つかりませんでした。`
      : `${all.length}か所。線の明るい部分に立つと、その時刻に${label}が先端に重なります。` +
        (state.body === 'Sun' ? '太陽を直接見たり、減光フィルターなしで撮影したりしないでください。' : '');

  for (const pass of passes) {
    const sky = state.body === 'Moon' ? skyLabel(new Date(pass.points[0].t)).text : '';
    const head = document.createElement('li');
    head.className = 'pass-head';
    const dir = state.body === 'Moon' ? (pass.rising ? '昇る月（東〜南の空）' : '沈む月（南〜西の空）') : (pass.rising ? '午前の太陽（東〜南の空）' : '午後の太陽（南〜西の空）');
    head.textContent = `${dir}　${fmtHM.format(pass.points[0].t)}〜${fmtHM.format(pass.points.at(-1).t)}${sky ? '・' + sky : ''}`;
    list.append(head);

    for (const spot of pass.spots) {
      const li = document.createElement('li');
      const det = spotDetails(spot.mid);
      const secs = Math.round((spot.to - spot.from) / 1000);
      const span = secs >= 1 ? `${secs}秒間` : '一瞬';
      li.innerHTML = `<span class="spot-time">${fmtTime.format(spot.from)}</span><span class="spot-place">…</span>
        <div class="spot-meta">${(spot.mid.d / 1000).toFixed(2)}km・${compass((spot.mid.az + 360) % 360)}向き・幅${Math.max(2, Math.round(spot.length))}m・${span}<br>
        ${visibleText(spot.best)}・目安${Math.round(det.focal)}mm</div>`;
      li.addEventListener('click', () => focusSpot(spot, li));
      list.append(li);
      spot.li = li;
      placeName(spot.mid.lat, spot.mid.lon).then((n) => { li.querySelector('.spot-place').textContent = n || ''; });
    }

    // time labels every 5 minutes along the path, skipped where they would crowd
    let last = -1, lastPt = null;
    for (const p of pass.points) {
      const minute = Math.floor(p.t / 60000);
      if (minute % 5 === 0 && minute !== last &&
        (!lastPt || distBearing(p.lat, p.lon, lastPt.lat, lastPt.lon)[0] > 500)) {
        last = minute;
        lastPt = p;
        const el = document.createElement('div');
        el.className = 'time-label';
        el.textContent = fmtHM.format(p.t);
        timeMarkers.push(new maplibregl.Marker({ element: el, anchor: 'left', offset: [8, 0] }).setLngLat([p.lon, p.lat]).addTo(map));
      }
    }
  }

  map.getSource('align').setData(pathGeoJSON(passes));
  map.getSource('spots').setData({
    type: 'FeatureCollection',
    features: all.map((s, i) => ({ type: 'Feature', id: i, properties: { i }, geometry: { type: 'Point', coordinates: [s.mid.lon, s.mid.lat] } })),
  });
  state.spots = all;
}

function spotPopupHTML(spot) {
  const s = spot.mid;
  const det = spotDetails(s);
  const date = new Date(s.t);
  const label = BODY_LABEL[state.body];
  const extra = state.body === 'Moon' ? `<dt>月</dt><dd>${moonPhaseText(date)}</dd><dt>空</dt><dd>${skyLabel(date).text}</dd>` : '';
  return `<strong>${fmtTime.format(spot.from)}〜${fmtTime.format(spot.to)}</strong>
    <dl class="kv" style="margin-top:6px">
      <dt>距離</dt><dd>${(s.d / 1000).toFixed(2)}km（スカイツリーは${compass((s.az + 360) % 360)}）</dd>
      <dt>${label}の高さ</dt><dd>${s.alt.toFixed(1)}°</dd>
      ${extra}
      <dt>見え方</dt><dd>${visibleText(spot.best)}</dd>
      <dt>塔の見かけ</dt><dd>${det.tower.toFixed(1)}°（${label}の${(det.tower / (2 * s.sd)).toFixed(0)}倍）</dd>
      <dt>焦点距離</dt><dd>約${Math.round(det.focal)}mm で塔が縦位置に収まる（35mm判）</dd>
    </dl>`;
}

function focusSpot(spot, li) {
  document.querySelectorAll('.spots li.active').forEach((e) => e.classList.remove('active'));
  li?.classList.add('active');
  map.flyTo({ center: [spot.mid.lon, spot.mid.lat], zoom: Math.max(map.getZoom(), 17) });
  new maplibregl.Popup({ maxWidth: '320px' }).setLngLat([spot.mid.lon, spot.mid.lat]).setHTML(spotPopupHTML(spot)).addTo(map);
  if (window.matchMedia('(max-width: 720px)').matches) document.getElementById('panel').classList.add('collapsed');
}

async function refresh() {
  const run = ++state.run;
  writeHash();
  document.getElementById('summary').textContent = '計算中…';
  document.getElementById('spots').innerHTML = '';
  const passes = await computeDay(state.date, state.body, state.mode, run);
  if (passes && run === state.run) renderSpots(passes);
  if (state.point) inspectPoint(state.point.lat, state.point.lon);
}

// ---------- reverse search from a chosen point ----------
async function inspectPoint(lat, lon) {
  const run = ++state.pointRun;
  state.point = { lat, lon };
  const section = document.getElementById('point-section');
  const info = document.getElementById('point-info');
  section.hidden = false;
  section.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  info.innerHTML = '<p class="muted">調べています…</p>';
  if (pointMarker) pointMarker.remove();
  pointMarker = new maplibregl.Marker({ color: '#38bdf8' }).setLngLat([lon, lat]).addTo(map);
  map.getSource('sight').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[lon, lat], [LM.lon, LM.lat]] } });

  const [d, bearing] = distBearing(lat, lon, LM.lat, LM.lon);
  const cls = await classAt(lat, lon);
  const zO = await elevationAt(lat, lon) + state.meta.eye_height;
  const tipAlt = elevAngle(zTop, zO, d);
  const place = await placeName(lat, lon);
  let status;
  if (cls === OUTSIDE) status = `<span class="badge ng">対象範囲外</span> 半径${state.meta.radius_m / 1000}km以内で選んでください`;
  else if (cls === BUILDING) status = '<span class="badge ng">建物の中</span> 道路や広場を選んでください';
  else status = cls >= 1 ? `<span class="badge ok">先端が見える</span> ${visibleText(cls)}` : '<span class="badge ng">見えない</span> 建物に遮られます';

  const head = `<p style="margin:0 0 6px">${place || ''}</p><p style="margin:0 0 8px">${status}</p>
    <dl class="kv"><dt>距離</dt><dd>${(d / 1000).toFixed(2)}km・${compass(bearing)}</dd><dt>先端の高さ</dt><dd>${tipAlt.toFixed(2)}°</dd></dl>`;
  info.innerHTML = head + '<p class="muted small">1年分の重なりを計算中…</p>';
  if (cls < 0 || d < MIN_DIST) { info.innerHTML = head; return; }

  const obs = new Astronomy.Observer(lat, lon, zO);
  const body = state.body;
  const events = [];
  const start = jstMidnight(fmtYmd.format(new Date())).getTime();
  const coarse = 10 * 60e3;
  for (let t = start; t < start + SCAN_DAYS * 86400e3; t += coarse) {
    if ((t - start) % (20 * 86400e3) === 0) {
      await new Promise((r) => setTimeout(r));
      if (run !== state.pointRun) return;
    }
    const h = bodyHor(body, new Date(t), obs);
    const target = state.mode === 'perch' ? tipAlt + h.sd : tipAlt;
    if (separation(h.az, h.alt, bearing, target) > 3) continue;
    let best = null;
    for (let u = t - coarse; u <= t + coarse; u += 10e3) {
      const g = bodyHor(body, new Date(u), obs);
      const sep = separation(g.az, g.alt, bearing, state.mode === 'perch' ? tipAlt + g.sd : tipAlt);
      if (!best || sep < best.sep) best = { t: u, sep, sd: g.sd };
    }
    if (best.sep < best.sd && !events.some((e) => Math.abs(e.t - best.t) < 3600e3)) events.push(best);
  }
  if (run !== state.pointRun) return;

  const items = events.map((e) => {
    const date = new Date(e.t);
    const sky = skyLabel(date, obs);
    const phase = body === 'Moon' ? `・${moonPhaseText(date)}` : '';
    const dim = body === 'Moon' && !sky.night;
    return `<li class="${dim ? 'day' : ''}">${fmtDay.format(date)} ${fmtTime.format(date)}　${sky.text}${phase}</li>`;
  });
  info.innerHTML = head + (items.length
    ? `<p class="small muted" style="margin:10px 0 0">これから1年で${BODY_LABEL[body]}が先端に重なる日時（${items.length}回）</p><ul class="events">${items.join('')}</ul>`
    : `<p class="small muted">これから1年、この地点では${BODY_LABEL[body]}が先端に重なりません。</p>`);
  if (cls === 0) info.insertAdjacentHTML('beforeend', '<p class="small muted">※この地点は建物で先端が隠れるため、実際には見えません。</p>');
}

// ---------- UI ----------
function setupControls() {
  document.querySelectorAll('[data-body]').forEach((b) => b.addEventListener('click', () => {
    state.body = b.dataset.body;
    syncControls();
    refresh();
  }));
  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
    state.mode = b.dataset.mode;
    syncControls();
    refresh();
  }));
  document.getElementById('date').addEventListener('change', (e) => {
    if (!e.target.value) return;
    state.date = e.target.value;
    syncControls();
    refresh();
  });
  document.getElementById('heat-toggle').addEventListener('change', (e) => {
    map.setLayoutProperty('heat', 'visibility', e.target.checked ? 'visible' : 'none');
  });
  document.getElementById('sheet-toggle').addEventListener('click', () => document.getElementById('panel').classList.toggle('collapsed'));
  document.getElementById('locate').addEventListener('click', () => {
    navigator.geolocation?.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        map.flyTo({ center: [longitude, latitude], zoom: 16 });
        inspectPoint(latitude, longitude);
      },
      () => alert('現在地を取得できませんでした。'),
      { enableHighAccuracy: true, timeout: 10000 });
  });

  // upcoming full moons
  const chips = document.getElementById('full-moons');
  let t = new Date();
  for (let i = 0; i < 6; i++) {
    const fm = Astronomy.SearchMoonPhase(180, t, 40);
    if (!fm) break;
    const ymd = fmtYmd.format(fm.date);
    const b = document.createElement('button');
    b.dataset.ymd = ymd;
    b.textContent = fmtDay.format(fm.date);
    b.title = '満月';
    b.addEventListener('click', () => { state.date = ymd; syncControls(); refresh(); });
    chips.append(b);
    t = new Date(fm.date.getTime() + 86400e3);
  }

  document.getElementById('legend-bar').innerHTML = state.meta.palette.map((c, i) => `<span style="background:${c};opacity:${i ? 1 : 0.35}"></span>`).join('');
}

function syncControls() {
  document.querySelectorAll('[data-body]').forEach((b) => {
    b.classList.toggle('active', b.dataset.body === state.body);
    b.setAttribute('aria-checked', b.dataset.body === state.body);
  });
  document.querySelectorAll('[data-mode]').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === state.mode);
    b.setAttribute('aria-checked', b.dataset.mode === state.mode);
  });
  document.querySelectorAll('#full-moons button').forEach((b) => b.classList.toggle('active', b.dataset.ymd === state.date));
  document.getElementById('full-moons').hidden = state.body !== 'Moon';
  document.getElementById('date').value = state.date;
  document.getElementById('title-body').textContent = BODY_LABEL[state.body];
  document.title = `スカイツリー × ${BODY_LABEL[state.body]}`;
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get('body') in BODY_LABEL) state.body = p.get('body');
  if (['center', 'perch'].includes(p.get('mode'))) state.mode = p.get('mode');
  if (/^\d{4}-\d{2}-\d{2}$/.test(p.get('date') || '')) state.date = p.get('date');
}
function writeHash() {
  history.replaceState(null, '', `#date=${state.date}&body=${state.body}&mode=${state.mode}`);
}

function setupMap() {
  const m = state.meta;
  map = new maplibregl.Map({
    container: 'map',
    center: [LM.lon, LM.lat],
    zoom: 12.6,
    maxZoom: 19,
    attributionControl: { compact: true },
    style: {
      version: 8,
      sources: {
        gsi: {
          type: 'raster', tiles: ['https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 18,
          attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル</a>',
        },
        heat: {
          type: 'raster', tiles: [new URL('.', location.href).href + m.tiles], tileSize: 256,
          minzoom: m.min_zoom, maxzoom: m.data_zoom, bounds: m.bounds,
          attribution: '<a href="https://www.mlit.go.jp/plateau/" target="_blank">PLATEAU</a>',
        },
        align: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
        spots: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
        sight: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      },
      layers: [
        { id: 'base', type: 'raster', source: 'gsi', paint: { 'raster-saturation': -0.5, 'raster-brightness-max': 0.8 } },
        { id: 'heat', type: 'raster', source: 'heat', minzoom: m.min_zoom, paint: { 'raster-opacity': 0.7, 'raster-resampling': 'nearest' } },
        { id: 'sight', type: 'line', source: 'sight', paint: { 'line-color': '#38bdf8', 'line-width': 1.5, 'line-dasharray': [2, 2] } },
        {
          id: 'align-other', type: 'line', source: 'align', filter: ['!=', ['get', 'vis'], 'visible'],
          paint: { 'line-color': '#334155', 'line-width': 2, 'line-dasharray': [1.5, 1.5] },
        },
        { id: 'align-casing', type: 'line', source: 'align', filter: ['==', ['get', 'vis'], 'visible'], layout: { 'line-cap': 'round' }, paint: { 'line-color': '#0f172a', 'line-width': 9 } },
        { id: 'align-visible', type: 'line', source: 'align', filter: ['==', ['get', 'vis'], 'visible'], layout: { 'line-cap': 'round' }, paint: { 'line-color': '#7dd3fc', 'line-width': 5 } },
        {
          id: 'spots', type: 'circle', source: 'spots',
          paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 4, 17, 9], 'circle-color': '#fde68a', 'circle-stroke-color': '#0f172a', 'circle-stroke-width': 2 },
        },
      ],
    },
  });
  // keep the camera centred in the part of the map the side panel does not cover
  const desktop = window.matchMedia('(min-width: 721px)');
  const pad = () => map.setPadding({ left: desktop.matches ? 392 : 0, top: 0, right: 0, bottom: 0 });
  pad();
  desktop.addEventListener('change', pad);
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
  const pin = document.createElement('div');
  pin.className = 'landmark-pin';
  pin.title = LM.name;
  new maplibregl.Marker({ element: pin }).setLngLat([LM.lon, LM.lat]).addTo(map);

  map.on('click', 'spots', (e) => {
    const spot = state.spots?.[e.features[0].properties.i];
    if (spot) { focusSpot(spot, spot.li); spot.li?.scrollIntoView({ block: 'nearest' }); }
  });
  map.on('click', (e) => {
    if (map.queryRenderedFeatures(e.point, { layers: ['spots'] }).length) return;
    inspectPoint(e.lngLat.lat, e.lngLat.lng);
  });
  map.on('mouseenter', 'spots', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'spots', () => { map.getCanvas().style.cursor = ''; });
  return new Promise((r) => map.on('load', r));
}

async function main() {
  state.meta = await (await fetch('data/skytree.json')).json();
  const m = state.meta;
  LM = { ...m.landmark, base: m.base_z };
  zTop = m.base_z + m.landmark.height;
  obsLM = new Astronomy.Observer(LM.lat, LM.lon, 0);
  palette = new Map(m.palette.map((c, i) => [`${parseInt(c.slice(1, 3), 16)},${parseInt(c.slice(3, 5), 16)},${parseInt(c.slice(5, 7), 16)}`, i]));
  document.getElementById('data-info').textContent = `PLATEAU建物 ${m.buildings.toLocaleString()}棟・半径${m.radius_m / 1000}km・${m.generated}作成`;

  const fm = Astronomy.SearchMoonPhase(180, new Date(), 40);
  state.date = fmtYmd.format(fm ? fm.date : new Date());
  readHash();
  setupControls();
  syncControls();
  await setupMap();
  refresh();
}

main();

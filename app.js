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
const WATER = -3;
const VIADUCT = -4;
const UNSTABLE = -5;
const RESTRICTED = -6;  // closed to the public (Imperial Palace)
const ROADWAY = -7;     // carriageway
const WHOLE = 7;
const TOP_SPOTS = 5;   // spots listed per time window before "show more"
const TOP_RECS = 10;       // class where the tower is visible down to its lowest level   // the standing height changes too fast here (edge of a bridge)

const WARDS = {
  13101: '千代田区', 13102: '中央区', 13103: '港区', 13104: '新宿区', 13105: '文京区', 13106: '台東区',
  13107: '墨田区', 13108: '江東区', 13109: '品川区', 13110: '目黒区', 13111: '大田区', 13112: '世田谷区',
  13113: '渋谷区', 13114: '中野区', 13115: '杉並区', 13116: '豊島区', 13117: '北区', 13118: '荒川区',
  13119: '板橋区', 13120: '練馬区', 13121: '足立区', 13122: '葛飾区', 13123: '江戸川区',
  14101: '横浜市鶴見区', 14102: '横浜市神奈川区', 14103: '横浜市西区', 14104: '横浜市中区', 14105: '横浜市南区',
  14106: '横浜市保土ケ谷区', 14107: '横浜市磯子区', 14108: '横浜市金沢区', 14109: '横浜市港北区', 14110: '横浜市戸塚区',
  14111: '横浜市港南区', 14112: '横浜市旭区', 14113: '横浜市緑区', 14114: '横浜市瀬谷区', 14115: '横浜市栄区',
  14116: '横浜市泉区', 14117: '横浜市青葉区', 14118: '横浜市都筑区',
  14131: '川崎市川崎区', 14132: '川崎市幸区', 14133: '川崎市中原区', 14134: '川崎市高津区', 14135: '川崎市多摩区',
  14136: '川崎市宮前区', 14137: '川崎市麻生区', 14382: '箱根町',
  19202: '富士吉田市', 19424: '忍野村', 19425: '山中湖村', 19429: '鳴沢村', 19430: '富士河口湖町',
  22207: '富士宮市', 22210: '富士市', 22215: '御殿場市', 22220: '裾野市', 22344: '小山町',
};
const BODY_LABEL = { Moon: '月', Sun: '太陽' };

// landmarks you can pick (pins on the map; their data is loaded when chosen)
const LANDMARK_PINS = {
  skytree: { short: 'スカイツリー', lat: 35.710139, lon: 139.810833 },
  tokyotower: { short: '東京タワー', lat: 35.658581, lon: 139.745433 },
  fuji: { short: '富士山', lat: 35.360628, lon: 138.727363 },
};
// Mt. Fuji is analysed separately for each area people watch it from
const FUJI_AREAS = { fuji: '都心', 'fuji-yokohama': '横浜', 'fuji-tanuki': '田貫湖・朝霧高原', 'fuji-gotemba': '御殿場' };
const LANDMARK_IDS = [...Object.keys(LANDMARK_PINS), ...Object.keys(FUJI_AREAS)];
const baseLandmark = (id) => (id in FUJI_AREAS ? 'fuji' : id);
const landmarkLabel = (id) => (id in FUJI_AREAS ? `富士山（${FUJI_AREAS[id]}から）` : LANDMARK_PINS[id].short);
const state = { landmark: 'skytree', body: 'Moon', mode: 'center', date: null, meta: null, run: 0, pointRun: 0 };
let map, LM, zTop, obsLM, palette, deckKeys;
const landmarkPins = {};
let recMarkers = [];
let timeMarkers = [];
let pointMarker = null;
let spotPopup = null;   // only one spot popup at a time
let geolocate = null;

// every publish stamps a version, so browsers never mix old data with new code
const APP_VERSION = document.querySelector('meta[name="app-version"]')?.content ?? '';
const dataUrl = (name) => `data/${name}?v=${APP_VERSION}`;

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
// Local tangent plane at the midpoint plus the meridian convergence: good to a
// few metres even 100 km out, where "north" turns by about half a degree.
function destination(lat, lon, bearing, d) {
  let la = lat, lo = lon, conv = 0;
  for (let i = 0; i < 3; i++) {
    const mid = (lat + la) / 2;
    const [mLat, mLon] = metersPerDeg(mid);
    const b = (bearing + conv / 2) * D2R;
    la = lat + d * Math.cos(b) / mLat;
    lo = lon + d * Math.sin(b) / mLon;
    conv = (lo - lon) * Math.sin(mid * D2R);
  }
  return [la, lo];
}
// azimuth at point 1 of the direction to point 2
function azimuthTo(lat1, lon1, lat2, lon2) {
  const bm = distBearing(lat1, lon1, lat2, lon2)[1];
  return (bm - (lon2 - lon1) * Math.sin((lat1 + lat2) / 2 * D2R) / 2 + 360) % 360;
}
// where to stand d metres from the landmark so that it lies at azimuth az; the
// returned bearing (from the landmark) is shared by nearby points on that line
function placeObserver(az, d) {
  let b = (az + 180) % 360, p;
  for (let i = 0; i < 3; i++) {
    p = destination(LM.lat, LM.lon, b, d);
    b += ((az - azimuthTo(p[0], p[1], LM.lat, LM.lon) + 540) % 360) - 180;
  }
  return [p[0], p[1], b];
}
// distances from the landmark where observers can be, and the area they cover
const distRange = () => state.meta.d_range ?? [MIN_DIST, state.meta.radius_m];
const tip = () => LM.tip ?? '先端';
const areaLabel = () => state.meta.area_label ?? `半径${state.meta.radius_m / 1000}km以内`;
function inArea(lat, lon) {
  const circles = state.meta.area ?? [{ lat: LM.lat, lon: LM.lon, r: state.meta.radius_m }];
  return circles.some((c) => distBearing(lat, lon, c.lat, c.lon)[0] <= c.r);
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

// ---------- weather: forecast when available, otherwise how often it is clear ----------
const FORECAST_DAYS = 14;
const weatherCache = new Map();
const jstHour = (t) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', hourCycle: 'h23' }).format(t));
// points whose sky matters: where people stand, plus a distant landmark itself
const weatherPoints = () => [state.meta.area_center ?? LM, ...(LM.far ? [LM] : [])];

function weatherFor(ymd) {
  const key = `${LM.id}/${ymd}`;
  if (!weatherCache.has(key)) weatherCache.set(key, (async () => {
    const days = (jstMidnight(ymd) - jstMidnight(fmtYmd.format(new Date()))) / 86400e3;
    if (days >= 0 && days <= FORECAST_DAYS) {
      try {
        const pts = weatherPoints();
        const url = 'https://api.open-meteo.com/v1/forecast?hourly=cloud_cover,cloud_cover_low&timezone=Asia%2FTokyo&models=jma_seamless' +
          `&latitude=${pts.map((p) => p.lat.toFixed(3)).join(',')}&longitude=${pts.map((p) => p.lon.toFixed(3)).join(',')}` +
          `&start_date=${ymd}&end_date=${ymd}`;
        const j = await (await fetch(url)).json();
        const sets = (Array.isArray(j) ? j : [j]).map((x) => x.hourly);
        if (sets.every((h) => h?.cloud_cover)) {
          // the worse of the points decides
          const hours = sets[0].time.map((_, i) => ({
            total: Math.max(...sets.map((h) => h.cloud_cover[i] ?? 0)),
            low: Math.max(...sets.map((h) => h.cloud_cover_low[i] ?? 0)),
          }));
          return { kind: 'forecast', hours };
        }
      } catch { /* fall back to the climatology */ }
    }
    const climate = await (await fetch(dataUrl(`${LM.id}_climate.json`))).json().catch(() => null);
    const month = Number(ymd.slice(5, 7));
    return climate ? { kind: 'climate', month, clear: climate.clear[month - 1], years: climate.years } : null;
  })());
  return weatherCache.get(key);
}

function weatherText(w, t) {
  if (!w) return '';
  const h = jstHour(t);
  if (w.kind === 'forecast') {
    const { total, low } = w.hours[h] ?? {};
    if (total === undefined) return '';
    const icon = total <= 30 ? '☀' : total <= 70 ? '⛅' : '☁';
    return `${icon} 雲量${Math.round(total)}%${low >= 50 ? '（低い雲が多い）' : ''}`;
  }
  return `晴れやすさ ${w.clear[h]}%`;
}

function weatherNote(w) {
  if (!w) return '';
  return w.kind === 'forecast'
    ? '天気は予報（気象庁モデル）の雲量です。直前にも確認してください。'
    : `天気予報は約2週間前から表示します。いまは過去10年（${w.years}）のこの月・時間帯に晴れていた割合を表示しています。`;
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
  // classes that are never drawn are told apart by their alpha value
  if (p[3] === 0) return inArea(lat, lon) ? BUILDING : OUTSIDE;
  if (p[3] === 1) return WATER;
  if (p[3] === 2) return VIADUCT;
  if (p[3] === 3) return RESTRICTED;
  if (p[3] === 4) return ROADWAY;
  if (p[3] < 255) return 0;  // "tip hidden" is the only visible translucent class
  const idx = palette.get(`${p[0]},${p[1]},${p[2]}`);
  return idx === undefined ? OUTSIDE : idx;
}
function decodeDem(p) {
  if (!p) return null;
  const v = p[0] * 65536 + p[1] * 256 + p[2];
  if (v === 8388608) return null;
  return (v < 8388608 ? v : v - 16777216) * 0.01;
}
// walkable bridge decks: all deck tiles are small, so they are loaded once and read synchronously
const deckData = new Map();
let decksLoaded = null;
const deckUrl = (x, y) => state.meta.deck_tiles.replace('{z}', state.meta.data_zoom).replace('{x}', x).replace('{y}', y);
function loadDecks() {
  decksLoaded ??= Promise.all([...deckKeys].map(async (k) => {
    const [x, y] = k.split('/');
    deckData.set(k, await pixels(deckUrl(x, y)));
  }));
  return decksLoaded;
}
function deckHeight(lat, lon) {
  const [x, y] = worldPx(lat, lon, state.meta.data_zoom);
  const tx = Math.floor(x / 256), ty = Math.floor(y / 256);
  const data = deckData.get(`${tx}/${ty}`);
  if (!data) return null;
  const i = ((Math.floor(y) - ty * 256) * 256 + (Math.floor(x) - tx * 256)) * 4;
  return data[i + 3] === 255 ? decodeDem([data[i], data[i + 1], data[i + 2]]) : null;
}
async function groundAt(lat, lon) {
  const gsi = (layer) => (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/${layer}/${z}/${x}/${y}.png`;
  const h = decodeDem(await samplePixel(gsi('dem5a_png'), lat, lon, 15)) ??
    decodeDem(await samplePixel(gsi('dem10b_png'), lat, lon, 14));
  return h ?? 0;
}
// height you stand at: the deck on a walkable bridge, otherwise the ground
async function elevationAt(lat, lon) {
  await loadDecks();
  return deckHeight(lat, lon) ?? groundAt(lat, lon);
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
  const [dMin, dMax] = distRange();
  const altMax = elevAngle(zTop, LM.base, dMin);
  const altMin = elevAngle(zTop, LM.base, dMax);

  // 1) where the observer would stand, assuming ground at the landmark's base
  const cands = [];
  for (let k = 0, t = start; t < start + 86400e3; k++, t += STEP_SEC * 1000) {
    const date = new Date(t);
    let h = bodyHor(body, date);
    let target = mode === 'perch' ? h.alt - h.sd : h.alt;
    if (target < altMin - 0.2 || target > altMax) continue;
    let pos = placeObserver(h.az, solveDistance(target, LM.base));
    // the sky's azimuth and altitude are those seen where the observer stands
    h = bodyHor(body, date, new Astronomy.Observer(pos[0], pos[1], 0));
    target = mode === 'perch' ? h.alt - h.sd : h.alt;
    if (target < altMin - 0.2 || target > altMax) continue;
    pos = placeObserver(h.az, solveDistance(target, LM.base));
    cands.push({ k, t, h, target, bearing: pos[2], lat: pos[0], lon: pos[1] });
  }

  // 2) correct for the local ground height (tiles fetched in parallel)
  const [ground] = await Promise.all([Promise.all(cands.map((c) => groundAt(c.lat, c.lon))), loadDecks()]);
  if (run !== state.run) return null;
  const passes = [];
  let cur = null, prevK = -2;
  cands.forEach((c, i) => {
    const zO = ground[i] + state.meta.eye_height;
    const d = solveDistance(c.target, zO);
    if (d > dMax || d < dMin) { prevK = -2; return; }
    const [lat, lon] = destination(LM.lat, LM.lon, c.bearing, d);
    // a new pass after a gap, or when the body crosses the meridian (south)
    if (c.k !== prevK + 1 || (cur && (cur.points.at(-1).az < 180) !== (c.h.az < 180))) { cur = { points: [] }; passes.push(cur); }
    prevK = c.k;
    cur.points.push({ t: c.t, lat, lon, d, az: c.h.az, alt: c.h.alt, sd: c.h.sd, zO, target: c.target, bearing: c.bearing });
  });

  // a time window whose line never enters the observer area (e.g. the sun on the
  // far side of Mt. Fuji) is not a time window anyone here can use
  for (let i = passes.length - 1; i >= 0; i--) {
    if (!passes[i].points.some((p) => inArea(p.lat, p.lon))) passes.splice(i, 1);
  }

  // 3) sample the ground-level line every SAMPLE_M metres, each with its own ground height
  for (const pass of passes) {
    pass.rising = pass.points[0].az < 180;
    pass.samples = [];
    const pts = pass.points;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[i + 1];
      const m = q ? Math.max(1, Math.ceil(distBearing(p.lat, p.lon, q.lat, q.lon)[0] / SAMPLE_M)) : 1;
      for (let j = 0; j < m; j++) pass.samples.push(lerpPoint(p, q, j / m));
    }
  }
  const samples = passes.flatMap((p) => p.samples);
  const relocate = (s, g) => {
    s.zO = g + state.meta.eye_height;
    s.d = solveDistance(s.target, s.zO);
    [s.lat, s.lon] = destination(LM.lat, LM.lon, s.bearing, s.d);
  };
  for (let round = 0; round < 2; round++) {
    const g = await Promise.all(samples.map((s) => groundAt(s.lat, s.lon)));
    samples.forEach((s, i) => relocate(s, g[i]));
  }
  const check = await Promise.all(samples.map((s) => groundAt(s.lat, s.lon)));
  const classes = await Promise.all(samples.map((s) => classAt(s.lat, s.lon)));
  if (run !== state.run) return null;
  samples.forEach((s, i) => {
    const stable = Math.abs(check[i] + state.meta.eye_height - s.zO) < 1;
    // on a bridge deck the ground-level answer does not apply (you would be under the deck)
    s.cls = !stable ? UNSTABLE : deckHeight(s.lat, s.lon) !== null ? UNSTABLE
      : s.d > dMax || s.d < dMin ? OUTSIDE : classes[i];
  });

  // 4) on a bridge the eye is higher, so the tip looks lower and the alignment happens
  //    closer in on the same ray: walk each ray inward and find where the deck height fits
  for (const pass of passes) {
    pass.deckSamples = findDeckRoots(pass.points);
  }
  const decks = passes.flatMap((p) => p.deckSamples);
  const deckClasses = await Promise.all(decks.map((s) => classAt(s.lat, s.lon)));
  if (run !== state.run) return null;
  decks.forEach((s, i) => { s.cls = deckClasses[i]; });
  passes.forEach((p) => {
    p.spots = [...findSpots(p.samples), ...findSpots(p.deckSamples, true)].sort((x, y) => x.from - y.from);
  });
  return passes;
}

function lerpPoint(p, q, f) {
  const lerp = (key) => q ? p[key] + (q[key] - p[key]) * f : p[key];
  return {
    t: lerp('t'), lat: lerp('lat'), lon: lerp('lon'), d: lerp('d'), alt: lerp('alt'), az: lerp('az'), sd: p.sd,
    zO: lerp('zO'), target: lerp('target'), bearing: lerp('bearing'),
  };
}

const DECK_STEP_SEC = 1;
const DECK_SEARCH_M = 450;   // decks are at most ~30 m above ground
// quick test: does the ray segment touch any tile that has a walkable deck?
function rayHasDeck(bearing, d0, d1) {
  for (let d = d0; d <= d1 + 100; d += 100) {
    const [lat, lon] = destination(LM.lat, LM.lon, bearing, Math.min(d, d1));
    const [x, y] = worldPx(lat, lon, state.meta.data_zoom);
    if (deckKeys.has(`${Math.floor(x / 256)}/${Math.floor(y / 256)}`)) return true;
  }
  return false;
}

function findDeckRoots(points) {
  const out = [];
  const eye = state.meta.eye_height;
  const dMin = distRange()[0];
  const nearDeck = points.map((p) => rayHasDeck(p.bearing, Math.max(p.d - DECK_SEARCH_M, dMin), p.d));
  for (let i = 0; i + 1 < points.length; i++) {
    // only the 15 s steps whose rays come near a walkable deck are searched second by second
    if (!nearDeck[i] && !nearDeck[i + 1]) continue;
    const p = points[i], q = points[i + 1];
    for (let t = p.t; t < q.t; t += DECK_STEP_SEC * 1000) {
      const s = lerpPoint(p, q, (t - p.t) / (q.t - p.t));
      const tan = Math.tan(s.target * D2R);
      const dEnd = Math.max(s.d - DECK_SEARCH_M, dMin);
      if (dEnd >= s.d) continue;
      // the ray is straight over a few hundred metres: place its ends exactly, interpolate between
      const a = destination(LM.lat, LM.lon, s.bearing, s.d);
      const b = destination(LM.lat, LM.lon, s.bearing, dEnd);
      const n = Math.ceil((s.d - dEnd) / 1.5);
      let prev = null;
      for (let k = 0; k <= n; k++) {
        const f = k / n;
        const lat = a[0] + (b[0] - a[0]) * f, lon = a[1] + (b[1] - a[1]) * f;
        const h = deckHeight(lat, lon);
        if (h === null) { prev = null; continue; }
        const d = s.d - (s.d - dEnd) * f;
        const gap = h + eye - (zTop - drop(d) - d * tan);   // > 0: eye above the line to the tip
        if (prev !== null && Math.sign(gap) !== Math.sign(prev)) {
          out.push({ ...s, d, lat, lon, zO: h + eye, onDeck: true });
          break;
        }
        prev = gap;
      }
    }
  }
  return out;
}

function findSpots(samples, onDeck = false) {
  const spots = [];
  let run = null, gap = 0;
  if (onDeck) {
    // deck roots are 1 s apart; split where time or place jumps
    samples.forEach((s, i) => {
      const prev = samples[i - 1];
      const jump = !prev || s.t - prev.t > 3000 || distBearing(prev.lat, prev.lon, s.lat, s.lon)[0] > 30;
      if (jump || s.cls < 1) { if (run) spots.push(run); run = null; }
      if (s.cls >= 1) {
        if (!run) run = { start: i, end: i, best: s.cls };
        run.end = i; run.best = Math.max(run.best, s.cls);
      }
    });
    if (run) spots.push(run);
    return spots.map((r) => toSpot(samples, r, true));
  }
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
  return spots.map((r) => toSpot(samples, r, false));
}

function toSpot(samples, r, onDeck) {
  const a = samples[r.start], b = samples[r.end], mid = samples[Math.round((r.start + r.end) / 2)];
  return { from: a.t, to: b.t, mid, onDeck, length: distBearing(a.lat, a.lon, b.lat, b.lon)[0], best: r.best };
}

// ---------- rendering ----------
function pathGeoJSON(passes) {
  const features = [];
  for (const pass of passes) {
    let seg = null, prev = null;
    pass.samples.forEach((s) => {
      const vis = s.cls >= 1 ? 'visible' : s.cls === 0 ? 'hidden' : 'blocked';
      const jump = prev && distBearing(prev.lat, prev.lon, s.lat, s.lon)[0] > 4 * SAMPLE_M;
      prev = s;
      if (jump) seg = null;  // e.g. where a bridge deck lifts the eye and moves the spot
      if (!seg || seg.properties.vis !== vis) {
        if (seg && !jump) seg.geometry.coordinates.push([s.lon, s.lat]);
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
  if (cls < 1) return `${tip()}は見えません`;
  if (cls === 1) return `${tip()}付近だけ見えます`;
  const lowest = state.meta.levels[cls - 1];
  return lowest <= 50 ? 'ほぼ全体が見えます' : `上から約${state.meta.landmark.height - lowest}m以上が見えます`;
}

async function renderSpots(passes) {
  const weather = await weatherFor(state.date);
  const list = document.getElementById('spots');
  list.innerHTML = '';
  timeMarkers.forEach((m) => m.remove());
  timeMarkers = [];
  const all = passes.flatMap((p) => p.spots);
  const label = BODY_LABEL[state.body];
  const whole = all.filter((s) => s.best >= WHOLE).length;
  document.getElementById('cat-whole-n').textContent = whole;
  document.getElementById('cat-part-n').textContent = all.length - whole;
  // open the category that has something, whole-tower first
  if (state.spotCat !== 'part' || all.length === whole) state.spotCat = whole ? 'whole' : 'part';
  document.getElementById('spot-cat').hidden = all.length === 0;
  const summary = document.getElementById('summary');
  if (all.length === 0) {
    // nothing to show: say so plainly, why, and what to try next
    const why = passes.length === 0
      ? `${label}が${LM.short}の${tip()}と同じ方向・高さに来る時間が、この日はありません（${areaLabel()}から見た場合）。`
      : `${label}が${tip()}に重なる時間帯はありますが、その位置はすべて${LM.far ? '建物や山' : '建物'}の陰・川の上・高架などで、地上から見える場所がありません。`;
    summary.innerHTML = `<div class="empty"><strong>この日は、重なって見える場所がありません</strong><p>${why}</p>
      <p>別の日や、${state.body === 'Moon' ? '太陽' : '月'}・別のランドマークで探してみてください。</p>
      <div class="empty-actions">
        <button class="btn" data-shift="-1">前の日</button><button class="btn" data-shift="1">次の日</button>
        <button class="btn" data-swap-body>${state.body === 'Moon' ? '太陽' : '月'}で探す</button>
      </div></div>`;
    summary.querySelectorAll('[data-shift]').forEach((b) => b.addEventListener('click', () => {
      const t = jstMidnight(state.date).getTime() + Number(b.dataset.shift) * 86400e3 + 12 * 3600e3;
      state.date = fmtYmd.format(new Date(t));
      syncControls();
      refresh();
    }));
    summary.querySelector('[data-swap-body]').addEventListener('click', () => {
      state.body = state.body === 'Moon' ? 'Sun' : 'Moon';
      syncControls();
      refresh();
    });
  } else {
    summary.textContent = `${all.length}か所。線の明るい部分に立つと、その時刻に${label}が${tip()}に重なります。` +
      (state.body === 'Sun' ? '太陽を直接見たり、減光フィルターなしで撮影したりしないでください。' : '');
  }
  document.getElementById('weather-note').textContent = weatherNote(weather);

  for (const pass of passes) {
    // one group per time window: a clear heading, the best few spots, the rest on request
    const sky = state.body === 'Moon' ? skyLabel(new Date(pass.points[0].t)).text : '';
    const dir = state.body === 'Moon' ? (pass.rising ? '昇る月（東〜南の空）' : '沈む月（南〜西の空）') : (pass.rising ? '午前の太陽（東〜南の空）' : '午後の太陽（南〜西の空）');
    const mid = (pass.points[0].t + pass.points.at(-1).t) / 2;
    const wx = weatherText(weather, mid);
    const group = document.createElement('li');
    group.className = 'pass';
    group.innerHTML = `<div class="pass-head"><strong>${dir}</strong><span class="pass-count"></span>
      <div class="pass-sub">${fmtHM.format(pass.points[0].t)}〜${fmtHM.format(pass.points.at(-1).t)}${sky ? '・' + sky : ''}${wx ? '・' + wx : ''}</div></div>`;
    pass.countEl = group.querySelector('.pass-count');
    const ol = document.createElement('ol');
    ol.className = 'spots';
    group.append(ol);
    pass.emptyNote = document.createElement('p');
    pass.emptyNote.className = 'empty-note';
    group.append(pass.emptyNote);
    list.append(group);
    pass.spots.forEach((s) => { s.pass = pass; });
    pass.expanded = false;
    pass.moreBtn = document.createElement('button');
    pass.moreBtn.className = 'more-btn';
    pass.moreBtn.addEventListener('click', () => { pass.expanded = !pass.expanded; applySpotFilter(); });
    group.append(pass.moreBtn);

    for (const spot of pass.spots) {
      const li = document.createElement('li');
      const det = spotDetails(spot.mid);
      const secs = Math.round((spot.to - spot.from) / 1000);
      const span = secs >= 1 ? `${secs}秒間` : '一瞬';
      li.innerHTML = `<span class="spot-time">${fmtTime.format(spot.from)}</span><span class="spot-place">…</span>${spot.onDeck ? '<span class="deck-badge">橋の上</span>' : ''}${spot.best >= WHOLE ? '<span class="deck-badge whole">全体が見える</span>' : ''}
        <div class="spot-meta">${(spot.mid.d / 1000).toFixed(2)}km・${compass((spot.mid.az + 360) % 360)}向き・幅${Math.max(2, Math.round(spot.length))}m・${span}<br>
        ${visibleText(spot.best)}・目安${Math.round(det.focal)}mm${weather ? '<br>' + weatherText(weather, spot.from) : ''}
        <br><span class="spot-access"></span></div>`;
      li.addEventListener('click', () => focusSpot(spot, li));
      ol.append(li);
      spot.li = li;
      placeName(spot.mid.lat, spot.mid.lon).then((n) => { li.querySelector('.spot-place').textContent = n || ''; });
      accessLine(spot.mid.lat, spot.mid.lon, spot.from).then((h) => { li.querySelector('.spot-access').innerHTML = h; });
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
        el.hidden = !document.getElementById('align-toggle').checked;
        el.textContent = fmtHM.format(p.t);
        timeMarkers.push(new maplibregl.Marker({ element: el, anchor: 'left', offset: [8, 0] }).setLngLat([p.lon, p.lat]).addTo(map));
      }
    }
  }

  map.getSource('align').setData(pathGeoJSON([...passes, ...passes.map((p) => ({ samples: p.deckSamples }))]));
  map.getSource('spots').setData({
    type: 'FeatureCollection',
    features: all.map((s, i) => ({ type: 'Feature', id: i, properties: { i, whole: s.best >= WHOLE }, geometry: { type: 'Point', coordinates: [s.mid.lon, s.mid.lat] } })),
  });
  state.spots = all;
  state.passes = passes;
  applySpotFilter();
}

// which spots the list shows: the chosen category ("whole tower" or "part of
// it"), the best few per time window unless the window is expanded
function applySpotFilter() {
  const cat = state.spotCat;
  const inCat = (s) => (cat === 'whole' ? s.best >= WHOLE : s.best < WHOLE);
  document.querySelectorAll('[data-cat]').forEach((b) => {
    b.classList.toggle('active', b.dataset.cat === cat);
    b.setAttribute('aria-checked', b.dataset.cat === cat);
  });
  for (const pass of state.passes || []) {
    const mine = pass.spots.filter(inCat);
    const score = (s) => Math.min(s.length, 500) * 1e3 + (s.to - s.from) / 1000 + s.best * 1e6;
    const top = new Set([...mine].sort((a, b) => score(b) - score(a)).slice(0, TOP_SPOTS));
    for (const s of pass.spots) {
      if (s.li) s.li.hidden = !inCat(s) || !(pass.expanded || top.has(s));
    }
    pass.countEl.textContent = mine.length ? `${mine.length}か所` : '見える場所なし';
    // say why a time window shows nothing instead of leaving it blank
    pass.emptyNote.hidden = mine.length > 0;
    pass.emptyNote.textContent = pass.spots.length === 0
      ? `この時間帯は、重なる位置がすべて${LM.far ? '建物や山' : '建物'}の陰・川の上・高架などで、見える場所がありません。`
      : cat === 'whole'
        ? `この時間帯に全体が見える場所はありません。「一部が見える」に${pass.spots.length}か所あります。`
        : `この時間帯の${pass.spots.length}か所は、すべて全体が見える場所です。`;
    if (pass.moreBtn) {
      pass.moreBtn.hidden = mine.length <= TOP_SPOTS;
      pass.moreBtn.textContent = pass.expanded ? `上位${TOP_SPOTS}件だけ表示` : `ほか${mine.length - TOP_SPOTS}件を表示`;
    }
  }
  // the map keeps both kinds, the other one faded
  if (map?.getLayer('spots')) {
    map.setPaintProperty('spots', 'circle-opacity', ['case', ['==', ['get', 'whole'], cat === 'whole'], 1, 0.3]);
    map.setPaintProperty('spots', 'circle-stroke-opacity', ['case', ['==', ['get', 'whole'], cat === 'whole'], 1, 0.3]);
  }
}

function spotPopupHTML(spot) {
  const s = spot.mid;
  const det = spotDetails(s);
  const date = new Date(s.t);
  const label = BODY_LABEL[state.body];
  const extra = state.body === 'Moon' ? `<dt>月</dt><dd>${moonPhaseText(date)}</dd><dt>空</dt><dd>${skyLabel(date).text}</dd>` : '';
  return `<strong>${fmtTime.format(spot.from)}〜${fmtTime.format(spot.to)}</strong>
    <dl class="kv" style="margin-top:6px">
      <dt>距離</dt><dd>${(s.d / 1000).toFixed(2)}km（${LM.short}は${compass((s.az + 360) % 360)}）</dd>
      <dt>${label}の高さ</dt><dd>${s.alt.toFixed(1)}°</dd>
      ${extra}
      <dt>見え方</dt><dd>${visibleText(spot.best)}</dd>
      <dt>天気</dt><dd>${spot.weather || '—'}</dd>
      <dt>${LM.far ? '山' : '塔'}の見かけ</dt><dd>${det.tower.toFixed(1)}°（${label}の${(det.tower / (2 * s.sd)).toFixed(0)}倍）</dd>
      <dt>焦点距離</dt><dd>約${Math.round(det.focal)}mm で${LM.far ? '山' : '塔'}が縦位置に収まる（35mm判）</dd>
    </dl>
    <div data-access></div>
    <button class="popup-btn" data-view>この場所からの眺めを見る</button>
    ${directionsLink(s.lat, s.lon, `${fmtTime.format(spot.from).slice(0, 5)}までに到着`)}`;
}

// ---------- getting there by public transport ----------
const VERDICT = {
  ok: ['ok', '電車で行けます'],
  'before-first': ['warn', '始発前です'],
  'after-last': ['warn', '帰りの終電後です'],
};
// one-line summary for list items: nearest station, walk, and whether trains run then
async function accessLine(lat, lon, t) {
  const [st] = await Transit.nearestStations(lat, lon, 2000, 1);
  if (!st) return '<span class="acc warn">2km以内に駅がありません</span>';
  const v = Transit.trainVerdict(st, t);
  const [cls, text] = VERDICT[v?.verdict] ?? ['', ''];
  return `${st.name}駅 徒歩${st.walk}分${v ? `<span class="acc ${cls}">${text.replace('です', '')}</span>` : ''}`;
}
async function accessHTML(lat, lon, t) {
  const [stations, ports] = await Promise.all([Transit.nearestStations(lat, lon, 2000, 2), Transit.portsNear(lat, lon, 500, 2)]);
  const isToday = fmtYmd.format(new Date(t)) === fmtYmd.format(new Date());
  let html = '<div class="access"><div class="access-title">公共交通で行く</div>';
  if (!stations.length) html += '<p class="small muted">2km以内に駅のデータがありません（公共交通オープンデータの範囲外）。</p>';
  for (const [i, st] of stations.entries()) {
    const v = Transit.trainVerdict(st, t);
    const lines = st.lines.map((l) => `<span class="line-chip" style="--c:${l.color || '#94a3b8'}">${l.name}</span>`).join('');
    html += `<div class="station"><strong>${st.name}駅</strong> 徒歩${st.walk}分<div class="lines">${lines}</div>`;
    if (v) {
      const [cls, text] = VERDICT[v.verdict];
      html += `<div class="verdict ${cls}">${text}<span class="muted">（${v.type}ダイヤ 始発${v.first}・終電${v.last}）</span></div>`;
    }
    if (i === 0 && isToday) {
      const status = await Transit.lineStatus(st);
      if (status?.length) {
        const bad = status.filter((s) => s.delayed);
        html += bad.length
          ? `<div class="verdict warn">運行情報：${bad.map((s) => s.name).join('・')}に遅れなど</div>`
          : '<div class="verdict ok">運行情報：いまは平常どおり</div>';
      }
    }
    html += '</div>';
  }
  if (ports.length) {
    const night = stations.some((st) => Transit.trainVerdict(st, t)?.verdict !== 'ok');
    html += `<div class="bikes"><div class="access-sub">シェアサイクル${night ? '（電車がない時間の足に）' : ''}</div>` +
      ports.map((p) => `<div>${p.n ?? 'ポート'}（${p.d}m）${p.status ? `<span class="muted">いま貸出 ${p.status.bikes ?? '?'}台・返却 ${p.status.docks ?? '?'}台</span>` : ''}</div>`).join('') + '</div>';
  }
  return html + '</div>';
}
async function fillAccess(el, lat, lon, t) {
  if (!el) return;
  el.innerHTML = '<p class="small muted">交通を調べています…</p>';
  el.innerHTML = await accessHTML(lat, lon, t);
}

// Google Maps opens with the current location as the start (app on phones, web elsewhere)
function directionsLink(lat, lon, note = '') {
  const url = `https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lon.toFixed(6)}&travelmode=transit`;
  return `<a class="popup-btn link-btn" href="${url}" target="_blank" rel="noopener">ここへの道案内（Google マップ）</a>` +
    (note ? `<p class="small muted" style="margin:4px 0 0">${note}</p>` : '');
}

async function focusSpot(spot, li) {
  document.querySelectorAll('.spots li.active').forEach((e) => e.classList.remove('active'));
  li?.classList.add('active');
  map.flyTo({ center: [spot.mid.lon, spot.mid.lat], zoom: Math.max(map.getZoom(), 17) });
  if (spot.li?.hidden && spot.pass) {
    // picked on the map: open its category and time window in the list
    state.spotCat = spot.best >= WHOLE ? 'whole' : 'part';
    spot.pass.expanded = true;
    applySpotFilter();
  }
  spotPopup?.remove();
  spot.weather = weatherText(await weatherFor(state.date), spot.from);
  const popup = spotPopup = new maplibregl.Popup({ maxWidth: '320px' }).setLngLat([spot.mid.lon, spot.mid.lat]).setHTML(spotPopupHTML(spot)).addTo(map);
  fillAccess(popup.getElement().querySelector('[data-access]'), spot.mid.lat, spot.mid.lon, spot.from);
  popup.getElement().querySelector('[data-view]').addEventListener('click', () => {
    const s = spot.mid;
    openViewer({
      lat: s.lat, lon: s.lon, ground: s.zO - state.meta.eye_height, time: s.t, body: state.body,
      focal: Math.round(Math.min(800, Math.max(24, spotDetails(s).focal * 24 / 36))),
      title: `${fmtTime.format(s.t).slice(0, 5)} の眺め`,
    });
  });
  if (window.matchMedia('(max-width: 720px)').matches) window.closeSheet();
}

// "please wait" message on the map and in the list while something takes seconds
let busyCount = 0;
function busy(text) {
  busyCount++;
  document.getElementById('busy-text').textContent = text;
  document.getElementById('busy').hidden = false;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--busyCount <= 0) {
      busyCount = 0;
      document.getElementById('busy').hidden = true;
    }
  };
}
const waitHTML = (text) => `<span class="wait"><span class="spinner"></span>${text}</span>`;

// day results are kept, and the other overlay mode is computed in the background,
// so switching "centre / perch" (or going back to a date) is instant
const dayCache = new Map();
const dayKey = (mode) => `${state.landmark}|${state.date}|${state.body}|${mode}`;
function precomputeOtherMode() {
  const mode = state.mode === 'center' ? 'perch' : 'center';
  const key = dayKey(mode);
  if (dayCache.has(key)) return;
  const run = state.run;
  setTimeout(async () => {
    if (run !== state.run || dayCache.has(key)) return;
    const passes = await computeDay(state.date, state.body, mode, run);
    if (passes) dayCache.set(key, passes);
  }, 400);
}

async function refresh() {
  const run = ++state.run;
  writeHash();
  const cached = dayCache.get(dayKey(state.mode));
  if (cached) {
    await renderSpots(cached);
    if (state.point) inspectPoint(state.point.lat, state.point.lon);
    precomputeOtherMode();
    return;
  }
  const text = `${fmtDay.format(jstMidnight(state.date))}に${BODY_LABEL[state.body]}が${LM.short}の${tip()}に重なる場所を計算しています…`;
  const done = busy(text);
  try {
    document.getElementById('summary').innerHTML = waitHTML(text);
    document.getElementById('spots').innerHTML = '';
    document.getElementById('spot-cat').hidden = true;
    const passes = await computeDay(state.date, state.body, state.mode, run);
    if (passes) dayCache.set(dayKey(state.mode), passes);
    if (passes && run === state.run) await renderSpots(passes);
  } finally {
    done();
  }
  if (state.point) inspectPoint(state.point.lat, state.point.lon);
  if (run === state.run) precomputeOtherMode();
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
  // the same answer also appears on the map, where the user tapped
  spotPopup?.remove();
  const popup = spotPopup = new maplibregl.Popup({ maxWidth: '300px', offset: 32 })
    .setLngLat([lon, lat]).setHTML('<p class="muted" style="margin:0">調べています…</p>').addTo(map);
  const showPopup = (html, view) => {
    if (run !== state.pointRun || !popup.isOpen()) return;
    popup.setHTML(html);
    const el = popup.getElement();
    el.querySelector('[data-view]')?.addEventListener('click', () => openPointView(lat, lon, view.zO, view.d, view.time));
    fillAccess(el.querySelector('[data-access]'), lat, lon, view.time ?? Date.now());
    el.querySelector('[data-detail]')?.addEventListener('click', () => {
      document.getElementById('panel').classList.remove('collapsed');
      document.getElementById('point-section').scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  };
  map.getSource('sight').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[lon, lat], [LM.lon, LM.lat]] } });

  const d = distBearing(lat, lon, LM.lat, LM.lon)[0];
  const bearing = azimuthTo(lat, lon, LM.lat, LM.lon);
  const cls = await classAt(lat, lon);
  const zO = await elevationAt(lat, lon) + state.meta.eye_height;
  const tipAlt = elevAngle(zTop, zO, d);
  const place = await placeName(lat, lon);
  let status;
  if (cls === OUTSIDE) status = `<span class="badge ng">対象範囲外</span> ${areaLabel()}で選んでください`;
  else if (cls === BUILDING) status = '<span class="badge ng">建物の中</span> 道路や広場を選んでください';
  else if (cls === WATER) status = '<span class="badge ng">水の上</span> 岸や橋の上を選んでください';
  else if (cls === VIADUCT) status = '<span class="badge ng">高架</span> 高速道路・鉄道の高架とその下は対象外です';
  else if (cls === RESTRICTED) status = '<span class="badge ng">立ち入りできない場所</span> 皇居の中は観測地点として使えません';
  else if (cls === ROADWAY) status = '<span class="badge ng">車道</span> 車道の上は対象外です。歩道や広場を選んでください';
  else status = cls >= 1 ? `<span class="badge ok">${tip()}が見える</span> ${visibleText(cls)}` : `<span class="badge ng">見えない</span> ${LM.far ? '建物や山に' : '建物に'}遮られます`;

  const head = `<p style="margin:0 0 6px">${place || ''}</p><p style="margin:0 0 8px">${status}</p>
    <dl class="kv"><dt>距離</dt><dd>${(d / 1000).toFixed(2)}km・${compass(bearing)}</dd><dt>${tip()}の高さ</dt><dd>${tipAlt.toFixed(2)}°</dd></dl>`;
  info.innerHTML = head + '<p class="muted small">1年分の重なりを計算中…</p>';
  showPopup(head + '<p class="muted small">1年分の重なりを計算中…</p>', {});
  if (cls < 0 || d < distRange()[0]) {
    info.innerHTML = head;
    if (cls >= 0) addViewButton(info, lat, lon, zO, d);
    showPopup(head + (cls >= 0 ? popupButtons(lat, lon) : ''), { zO, d });
    return;
  }

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

  const items = await Promise.all(events.map(async (e) => {
    const date = new Date(e.t);
    const sky = skyLabel(date, obs);
    const phase = body === 'Moon' ? `・${moonPhaseText(date)}` : '';
    const dim = body === 'Moon' && !sky.night;
    const wx = weatherText(await weatherFor(fmtYmd.format(date)), date);
    return `<li class="${dim ? 'day' : ''}">${fmtDay.format(date)} ${fmtTime.format(date)}　${sky.text}${phase}${wx ? `<br><span class="muted">${wx}</span>` : ''}</li>`;
  }));
  info.innerHTML = head + (items.length
    ? `<p class="small muted" style="margin:10px 0 0">これから1年で${BODY_LABEL[body]}が${tip()}に重なる日時（${items.length}回）</p><ul class="events">${items.join('')}</ul>`
    : `<p class="small muted">これから1年、この地点では${BODY_LABEL[body]}が${tip()}に重なりません。</p>`);
  const hiddenNote = `<p class="small muted">※この地点は${LM.far ? '建物や山' : '建物'}で${tip()}が隠れるため、実際には見えません。</p>`;
  if (cls === 0) info.insertAdjacentHTML('beforeend', hiddenNote);
  addViewButton(info, lat, lon, zO, d, events[0]?.t);

  // the map popup keeps it short: the next three, the rest in the panel
  const first = items.slice(0, 3);
  showPopup(head + (items.length
    ? `<p class="small muted" style="margin:8px 0 0">${BODY_LABEL[body]}が${tip()}に重なる日時（1年で${items.length}回）</p><ul class="events">${first.join('')}</ul>`
    : `<p class="small muted">これから1年、${BODY_LABEL[body]}は${tip()}に重なりません。</p>`) +
    (cls === 0 ? hiddenNote : '') + popupButtons(lat, lon, events[0]?.t, items.length > 3), { zO, d, time: events[0]?.t });
}

function popupButtons(lat, lon, time, more = false) {
  return `<div data-access></div><button class="popup-btn" data-view>${time ? '重なる時刻の眺めを見る' : '今の眺めを見る'}</button>
    ${directionsLink(lat, lon)}
    ${more ? '<button class="popup-btn" data-detail>すべての日時を見る</button>' : ''}`;
}

function openPointView(lat, lon, zO, d, time) {
  const tower = Math.atan2(zTop - zO, d) - Math.atan2(LM.base - zO, d);
  openViewer({
    lat, lon, ground: zO - state.meta.eye_height, time: time ?? Date.now(), body: state.body,
    focal: Math.round(Math.min(800, Math.max(24, 24 * 0.8 / (2 * Math.tan(tower / 2))))),
    title: time ? `${fmtDay.format(time)} の眺め` : '今の眺め',
  });
}

function addViewButton(info, lat, lon, zO, d, time) {
  const acc = document.createElement('div');
  info.append(acc);
  fillAccess(acc, lat, lon, time ?? Date.now());
  info.insertAdjacentHTML('beforeend', directionsLink(lat, lon));
  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.textContent = time ? 'この地点からの眺めを見る（重なる時刻）' : 'この地点からの眺めを見る（現在時刻）';
  btn.addEventListener('click', () => openPointView(lat, lon, zO, d, time));
  info.append(btn);
}

// ---------- recommended places with the whole tower in view ----------
async function loadRecommendations() {
  const list = document.getElementById('recs');
  list.innerHTML = '';
  let recs = [];
  try {
    recs = await (await fetch(dataUrl(`${state.meta.landmark.id}_recommend.json`))).json();
  } catch { /* no list for this landmark */ }
  recMarkers.forEach((m) => m.remove());
  recMarkers = recs.map((r, i) => {
    const el = document.createElement('button');
    el.className = 'rec-marker';
    el.textContent = i + 1;
    el.title = `おすすめ ${i + 1}`;
    el.hidden = !document.getElementById('rec-toggle').checked;
    el.addEventListener('click', (e) => { e.stopPropagation(); selectRecommendation(i); });
    return new maplibregl.Marker({ element: el }).setLngLat([r.lon, r.lat]).addTo(map);
  });
  state.recs = recs;
  document.getElementById('recs-more')?.remove();
  if (recs.length > TOP_RECS) {
    const more = document.createElement('button');
    more.id = 'recs-more';
    more.className = 'more-btn';
    more.textContent = `ほか${recs.length - TOP_RECS}件を表示`;
    more.addEventListener('click', () => {
      const open = more.dataset.open !== '1';
      more.dataset.open = open ? '1' : '';
      recs.forEach((r, i) => { r.li.hidden = !open && i >= TOP_RECS; });
      more.textContent = open ? `上位${TOP_RECS}件だけ表示` : `ほか${recs.length - TOP_RECS}件を表示`;
    });
    list.after(more);
  }
  recs.forEach((r, i) => {
    const li = document.createElement('li');
    const bearing = azimuthTo(r.lat, r.lon, LM.lat, LM.lon);
    li.innerHTML = `<span class="rank">${i + 1}</span><span class="spot-place">…</span>
      <div class="spot-meta">${(r.d / 1000).toFixed(1)}km・${LM.short}は${compass(bearing)}・開けた広さ 約${r.area.toLocaleString()}m²<br>${visibleText(r.cls ?? WHOLE)}</div>`;
    li.addEventListener('click', () => selectRecommendation(i));
    li.hidden = i >= TOP_RECS;
    list.append(li);
    r.li = li;
    placeName(r.lat, r.lon).then((n) => { li.querySelector('.spot-place').textContent = n || '（地名なし）'; });
  });
}

function selectRecommendation(i) {
  const r = state.recs[i];
  document.querySelectorAll('#recs li.active').forEach((e) => e.classList.remove('active'));
  r.li.hidden = false;
  r.li.classList.add('active');
  r.li.scrollIntoView({ block: 'nearest' });
  recMarkers.forEach((m, j) => m.getElement().classList.toggle('active', j === i));
  map.flyTo({ center: [r.lon, r.lat], zoom: Math.max(map.getZoom(), 16) });
  if (window.matchMedia('(max-width: 720px)').matches) window.closeSheet();
  inspectPoint(r.lat, r.lon);
}

function showTab(name) {
  document.querySelectorAll('[data-tab]').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === name);
    t.setAttribute('aria-selected', t.dataset.tab === name);
  });
  document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name; });
}

// "富士山" goes back to the area last used for it
function pickArea(id) {
  return id === 'fuji' ? (state.lastFujiArea ?? 'fuji') : id;
}

async function switchLandmark(id) {
  if (id === state.landmark || state.switching) return;
  state.switching = true;
  if (id in FUJI_AREAS) state.lastFujiArea = id;
  const done = busy(`${landmarkLabel(id)}のデータを読み込んでいます…`);
  document.getElementById('panel').classList.add('loading');
  try {
    state.landmark = id;
    await loadLandmark(id);
    syncControls();
    const c = state.meta.area_center ?? LM;   // a far landmark: look at the area people stand in
    map.flyTo({ center: [c.lon, c.lat], zoom: LM.far ? 11.5 : 12.6, pitch: map.getPitch() });
    loadRecommendations();
    await refresh();
  } finally {
    done();
    state.switching = false;
    document.getElementById('panel').classList.remove('loading');
  }
}

// ---------- UI ----------
function setupControls() {
  document.querySelectorAll('[data-landmark]').forEach((b) => b.addEventListener('click', () => switchLandmark(pickArea(b.dataset.landmark))));
  document.querySelectorAll('[data-area]').forEach((b) => b.addEventListener('click', () => switchLandmark(b.dataset.area)));
  document.querySelectorAll('[data-tab]').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
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
  document.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => {
    state.spotCat = b.dataset.cat;
    applySpotFilter();
  }));
  document.getElementById('align-toggle').addEventListener('change', (e) => {
    const v = e.target.checked ? 'visible' : 'none';
    for (const id of ['align-other', 'align-casing', 'align-visible', 'spots']) map.setLayoutProperty(id, 'visibility', v);
    timeMarkers.forEach((m) => { m.getElement().hidden = !e.target.checked; });
  });
  document.getElementById('rec-toggle').addEventListener('change', (e) => {
    recMarkers.forEach((m) => { m.getElement().hidden = !e.target.checked; });
  });
  document.getElementById('heat-toggle').addEventListener('change', (e) => {
    map.setLayoutProperty('heat', 'visibility', e.target.checked ? 'visible' : 'none');
  });
  document.getElementById('bldg-toggle').addEventListener('change', (e) => {
    map.setLayoutProperty('bldg3d', 'visibility', e.target.checked ? 'visible' : 'none');
    map.easeTo({ pitch: e.target.checked ? 60 : 0, zoom: e.target.checked ? Math.max(map.getZoom(), 15) : map.getZoom() });
  });
  // phones: the panel is a bottom sheet; tap the handle or the heading to open/close it
  const panel = document.getElementById('panel');
  const toggleSheet = (open = panel.classList.contains('collapsed')) => {
    panel.classList.toggle('collapsed', !open);
    document.getElementById('sheet-toggle').setAttribute('aria-expanded', open);
  };
  document.querySelector('.panel-head').addEventListener('click', (e) => {
    if (!window.matchMedia('(max-width: 720px)').matches) return;
    if (e.target.closest('a, input, button') && !e.target.closest('#sheet-toggle')) return;
    toggleSheet();
  });
  window.closeSheet = () => toggleSheet(false);
  document.getElementById('locate').addEventListener('click', () => {
    navigator.geolocation?.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        geolocate?.trigger();   // show the "you are here" dot too
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
  const label = BODY_LABEL[state.body];
  document.getElementById('mode-help-text').textContent = state.mode === 'perch'
    ? `${label}の下の縁が${tip()}にちょうど触れる位置。${label}が${tip()}の上に乗って見えます。`
    : `${label}の真ん中に${tip()}が来る位置。${tip()}が${label}に${LM.far ? '重なって' : '刺さって'}見えます。`;
  document.querySelectorAll('.mode-help svg').forEach((svg, i) => svg.classList.toggle('on', (i === 1) === (state.mode === 'perch')));
  document.getElementById('title-body').textContent = BODY_LABEL[state.body];
  document.title = `${LM.short} × ${BODY_LABEL[state.body]}｜ランドマーク × 月/太陽 撮影スポット案内`;
  document.querySelectorAll('[data-landmark]').forEach((b) => {
    b.classList.toggle('active', b.dataset.landmark === baseLandmark(state.landmark));
    b.setAttribute('aria-checked', b.dataset.landmark === baseLandmark(state.landmark));
  });
  document.getElementById('fuji-areas').hidden = baseLandmark(state.landmark) !== 'fuji';
  document.querySelectorAll('[data-area]').forEach((b) => {
    b.classList.toggle('active', b.dataset.area === state.landmark);
    b.setAttribute('aria-checked', b.dataset.area === state.landmark);
  });
  document.getElementById('title-lm').textContent = LM.short;
  document.querySelectorAll('.lm-short').forEach((e) => { e.textContent = LM.short; });
  document.querySelectorAll('.lm-tip').forEach((e) => { e.textContent = tip(); });
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (LANDMARK_IDS.includes(p.get('lm'))) state.landmark = p.get('lm');
  if (state.landmark in FUJI_AREAS) state.lastFujiArea = state.landmark;
  if (p.get('body') in BODY_LABEL) state.body = p.get('body');
  if (['center', 'perch'].includes(p.get('mode'))) state.mode = p.get('mode');
  if (/^\d{4}-\d{2}-\d{2}$/.test(p.get('date') || '')) state.date = p.get('date');
}
function writeHash() {
  history.replaceState(null, '', `#lm=${state.landmark}&date=${state.date}&body=${state.body}&mode=${state.mode}`);
}

function updatePins() {
  for (const [id, m] of Object.entries(landmarkPins)) m.getElement().classList.toggle('active', id === baseLandmark(state.landmark));
}

function heatSource(m) {
  return {
    type: 'raster', tiles: [new URL('.', location.href).href + m.tiles], tileSize: 256,
    minzoom: m.min_zoom, maxzoom: m.data_zoom, bounds: m.bounds,
    attribution: '<a href="https://www.mlit.go.jp/plateau/" target="_blank">PLATEAU</a>',
  };
}
function heatLayer(m) {
  const visible = document.getElementById('heat-toggle').checked;
  return {
    id: 'heat', type: 'raster', source: 'heat', minzoom: m.min_zoom, layout: { visibility: visible ? 'visible' : 'none' },
    paint: { 'raster-opacity': 0.7, 'raster-resampling': 'nearest' },
  };
}

// switch every landmark-specific piece of state; the map, if already built, follows
async function loadLandmark(id) {
  const m = await (await fetch(dataUrl(`${id}.json`))).json();
  state.meta = m;
  LM = { ...m.landmark, base: m.base_z };
  zTop = m.base_z + m.landmark.height;
  deckKeys = new Set(m.deck_tile_keys || []);
  deckData.clear();
  decksLoaded = null;
  window.viewerConfig = { id: m.landmark.id, viewTiles: m.view_tiles, version: APP_VERSION, landmark: LM };
  const c = m.area_center ?? LM;   // first guess for the sky; refined at each observer
  obsLM = new Astronomy.Observer(c.lat, c.lon, 0);
  palette = new Map(m.palette.map((c, i) => [`${parseInt(c.slice(1, 3), 16)},${parseInt(c.slice(3, 5), 16)},${parseInt(c.slice(5, 7), 16)}`, i]));
  document.getElementById('data-info').textContent = `PLATEAU建物 ${m.buildings.toLocaleString()}棟・${areaLabel()}・${m.generated}作成`;
  document.getElementById('legend-bar').innerHTML = m.palette.map((c, i) => `<span style="background:${c};opacity:${i ? 1 : 0.35}"></span>`).join('');
  if (map) {
    map.removeLayer('heat');
    map.removeSource('heat');
    map.addSource('heat', heatSource(m));
    map.addLayer(heatLayer(m), 'sight');
    updatePins();
    document.getElementById('point-section').hidden = true;
    pointMarker?.remove();
    spotPopup?.remove();
    map.getSource('sight').setData({ type: 'FeatureCollection', features: [] });
    state.point = null;
  }
}

function setupMap() {
  const m = state.meta;
  map = new maplibregl.Map({
    container: 'map',
    center: [(m.area_center ?? LM).lon, (m.area_center ?? LM).lat],
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
        heat: heatSource(m),
        align: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
        spots: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
        sight: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
        restricted: { type: 'geojson', data: dataUrl('restricted.geojson') },
        bldg: {
          type: 'vector', tiles: ['https://indigo-lab.github.io/plateau-tokyo23ku-building-mvt-2020/{z}/{x}/{y}.pbf'],
          minzoom: 10, maxzoom: 16,
          attribution: '<a href="https://github.com/indigo-lab/plateau-tokyo23ku-building-mvt-2020" target="_blank">PLATEAU MVT (indigo-lab)</a>',
        },
      },
      layers: [
        { id: 'base', type: 'raster', source: 'gsi', paint: { 'raster-saturation': -0.3 } },
        heatLayer(m),
        { id: 'restricted-fill', type: 'fill', source: 'restricted', paint: { 'fill-color': '#475569', 'fill-opacity': 0.18 } },
        { id: 'restricted-line', type: 'line', source: 'restricted', paint: { 'line-color': '#475569', 'line-width': 1.5, 'line-dasharray': [3, 2] } },
        { id: 'sight', type: 'line', source: 'sight', paint: { 'line-color': '#38bdf8', 'line-width': 1.5, 'line-dasharray': [2, 2] } },
        {
          id: 'align-other', type: 'line', source: 'align', filter: ['!=', ['get', 'vis'], 'visible'],
          paint: { 'line-color': '#334155', 'line-width': 2, 'line-dasharray': [1.5, 1.5] },
        },
        { id: 'align-casing', type: 'line', source: 'align', filter: ['==', ['get', 'vis'], 'visible'], layout: { 'line-cap': 'round' }, paint: { 'line-color': '#0f172a', 'line-width': 9 } },
        { id: 'align-visible', type: 'line', source: 'align', filter: ['==', ['get', 'vis'], 'visible'], layout: { 'line-cap': 'round' }, paint: { 'line-color': '#0ea5e9', 'line-width': 5 } },
        {
          id: 'bldg3d', type: 'fill-extrusion', source: 'bldg', 'source-layer': 'bldg', minzoom: 14, layout: { visibility: 'none' },
          paint: {
            'fill-extrusion-color': ['interpolate', ['linear'], ['get', 'measuredHeight'], 0, '#c7ccd6', 60, '#9aa4b8', 200, '#6b7a99'],
            'fill-extrusion-height': ['get', 'measuredHeight'], 'fill-extrusion-opacity': 0.85,
          },
        },
        {
          id: 'spots', type: 'circle', source: 'spots',
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, ['case', ['get', 'whole'], 5, 3], 17, ['case', ['get', 'whole'], 11, 7]],
            'circle-color': ['case', ['get', 'whole'], '#facc15', '#ffffff'], 'circle-stroke-color': '#334155', 'circle-stroke-width': 2,
          },
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
  geolocate = new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true, showAccuracyCircle: true });
  map.addControl(geolocate, 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
  // every landmark has a pin; tapping one switches to it
  for (const [id, p] of Object.entries(LANDMARK_PINS)) {
    const el = document.createElement('button');
    el.className = 'landmark-pin';
    el.innerHTML = `<span class="dot"></span><span class="name">${p.short}</span>`;
    el.title = `${p.short}を選ぶ`;
    el.addEventListener('click', (e) => { e.stopPropagation(); switchLandmark(pickArea(id)); });
    landmarkPins[id] = new maplibregl.Marker({ element: el, anchor: 'left', offset: [-8, 0] }).setLngLat([p.lon, p.lat]).addTo(map);
  }
  updatePins();

  map.on('click', 'spots', (e) => {
    const spot = state.spots?.[e.features[0].properties.i];
    if (spot) { focusSpot(spot, spot.li); spot.li?.scrollIntoView({ block: 'nearest' }); }
  });
  map.on('click', (e) => {
    if (map.queryRenderedFeatures(e.point, { layers: ['spots'] }).length) return;
    if (window.matchMedia('(max-width: 720px)').matches) window.closeSheet();   // keep the popup visible
    inspectPoint(e.lngLat.lat, e.lngLat.lng);
  });
  map.on('mouseenter', 'spots', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'spots', () => { map.getCanvas().style.cursor = ''; });
  return new Promise((r) => map.on('load', r));
}

async function main() {
  const fm = Astronomy.SearchMoonPhase(180, new Date(), 40);
  state.date = fmtYmd.format(fm ? fm.date : new Date());
  readHash();
  const done = busy('データを読み込んでいます…');
  try {
    await Promise.all([loadLandmark(state.landmark), Transit.load()]);
    setupControls();
    syncControls();
    await setupMap();
    loadRecommendations();
    await refresh();
  } finally {
    done();
  }
}

main();

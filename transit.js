'use strict';

// Getting there by public transport: nearest stations with first/last trains
// (ODPT timetables, prepared by pipeline/make_transit.py), today's service status
// and live bike-share counts (GBFS). Live data goes through the ODPT relay at
// tyra.jp, which keeps the access token server-side.
(() => {
  const RELAY = 'https://tyra.jp/odpt/api';
  const ENDPOINTS = [`${RELAY}/main/v4`, `${RELAY}/challenge/v4`];
  const WALK_M_PER_MIN = 80;
  const DETOUR = 1.25;           // streets are longer than the straight line
  const SERVICE_DAY_START = 180; // trains after midnight belong to the previous day (minutes)

  let transit = null;
  let ports = null;
  let pausedUntil = 0;           // after a 429 the relay is left alone for a while

  const version = () => document.querySelector('meta[name="app-version"]')?.content ?? '';
  const D2R = Math.PI / 180;
  function dist(lat1, lon1, lat2, lon2) {
    const a = Math.sin((lat2 - lat1) * D2R / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin((lon2 - lon1) * D2R / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(a));
  }

  async function load() {
    transit ??= fetch(`data/transit.json?v=${version()}`).then((r) => r.json()).catch(() => null);
    return transit;
  }
  async function loadPorts() {
    ports ??= fetch(`data/cycle.json?v=${version()}`).then((r) => r.json()).catch(() => null);
    return ports;
  }

  // ---------- calendar: weekday or Saturday/holiday timetable ----------
  const holidayCache = new Map();
  function holidays(y) {
    if (holidayCache.has(y)) return holidayCache.get(y);
    const d = (m, day) => `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const nthMonday = (m, n) => { const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); return 1 + ((8 - first) % 7) + (n - 1) * 7; };
    const vernal = Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
    const autumnal = Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
    const base = new Set([d(1, 1), d(1, nthMonday(1, 2)), d(2, 11), d(2, 23), d(3, vernal), d(4, 29), d(5, 3), d(5, 4), d(5, 5),
      d(7, nthMonday(7, 3)), d(8, 11), d(9, nthMonday(9, 3)), d(9, autumnal), d(10, nthMonday(10, 2)), d(11, 3), d(11, 23)]);
    const out = new Set(base);
    for (const k of base) {   // substitute holiday: a holiday on Sunday moves to the next free day
      const t = new Date(`${k}T00:00:00Z`);
      if (t.getUTCDay() !== 0) continue;
      let n = new Date(t.getTime() + 86400e3);
      while (base.has(n.toISOString().slice(0, 10))) n = new Date(n.getTime() + 86400e3);
      out.add(n.toISOString().slice(0, 10));
    }
    for (const k of base) {   // a weekday between two holidays is a holiday too
      const n2 = new Date(new Date(`${k}T00:00:00Z`).getTime() + 2 * 86400e3).toISOString().slice(0, 10);
      const n1 = new Date(new Date(`${k}T00:00:00Z`).getTime() + 86400e3);
      if (base.has(n2) && n1.getUTCDay() !== 0) out.add(n1.toISOString().slice(0, 10));
    }
    holidayCache.set(y, out);
    return out;
  }
  const jst = (t) => new Date(t + 9 * 3600e3);   // fields read with getUTC* are JST
  /** minutes on the timetable's service day (after midnight counts on: 25:10 = 1510) and that day */
  function serviceTime(t) {
    const j = jst(t);
    let min = j.getUTCHours() * 60 + j.getUTCMinutes();
    let day = j;
    if (min < SERVICE_DAY_START) { min += 1440; day = new Date(j.getTime() - 86400e3); }
    return { min, day };
  }
  function dayType(day) {
    const ymd = day.toISOString().slice(0, 10);
    const wd = day.getUTCDay();
    return wd === 0 || wd === 6 || holidays(day.getUTCFullYear()).has(ymd) || /-(12-3[01]|01-0[1-3])$/.test(ymd) ? 'hd' : 'wd';
  }
  const hm = (min) => `${Math.floor(min / 60) % 24}:${String(min % 60).padStart(2, '0')}`;

  // ---------- stations ----------
  /** nearest stations (one entry per station name, with all its lines), nearest first */
  async function nearestStations(lat, lon, maxM = 1500, limit = 2) {
    const t = await load();
    if (!t) return [];
    const byName = new Map();
    for (const s of t.stations) {
      const d = dist(lat, lon, s.lat, s.lon);
      if (d > maxM) continue;
      const g = byName.get(s.n) ?? { name: s.n, d, lines: [] };
      g.d = Math.min(g.d, d);
      g.lines.push({ railway: s.r, name: t.railways[s.r]?.n ?? '', color: t.railways[s.r]?.c, fl: s.fl });
      byName.set(s.n, g);
    }
    return [...byName.values()].sort((a, b) => a.d - b.d).slice(0, limit)
      .map((g) => ({ ...g, walk: Math.max(1, Math.ceil(g.d * DETOUR / WALK_M_PER_MIN)) }));
  }

  /**
   * Can you get there and back by train for a moment `t`?
   * 'before-first': you would have to arrive before the first train; 'after-last': the last
   * train home has gone; otherwise 'ok'. Times are the station's earliest/latest trains.
   */
  function trainVerdict(station, t) {
    const { min, day } = serviceTime(t);
    const type = dayType(day);
    let first = Infinity, last = -Infinity;
    for (const l of station.lines) {
      for (const dir of Object.values(l.fl ?? {})) {
        const [f, la] = dir[type] ?? dir.wd ?? [];
        if (f !== undefined) { first = Math.min(first, f); last = Math.max(last, la); }
      }
    }
    if (!Number.isFinite(first)) return null;
    const arriveBy = min - station.walk - 5;      // a few minutes to set up
    const leaveAt = min + 10 + station.walk;      // and to pack up afterwards
    const verdict = arriveBy < first ? 'before-first' : leaveAt > last ? 'after-last' : 'ok';
    return { verdict, first: hm(first), last: hm(last), type: type === 'hd' ? '土休日' : '平日' };
  }

  // ---------- live: service status and bike counts ----------
  async function relayGet(url) {
    if (Date.now() < pausedUntil) return null;
    try {
      const res = await fetch(url);
      if (res.status === 429 || res.status === 503) {
        pausedUntil = Date.now() + (Number(res.headers.get('Retry-After')) || 60) * 1000;
        return null;
      }
      return res.ok ? await res.json() : null;
    } catch { return null; }
  }
  let infoCache = { at: 0, data: null };
  async function trainInformation() {
    if (infoCache.data && Date.now() - infoCache.at < 60e3) return infoCache.data;
    const parts = await Promise.all(ENDPOINTS.map((b) => relayGet(`${b}/odpt:TrainInformation`)));
    if (parts.every((p) => !p)) return infoCache.data;
    infoCache = { at: Date.now(), data: parts.flatMap((p) => p ?? []) };
    return infoCache.data;
  }
  const DELAY = ['遅れ', '遅延', '見合わせ', '運休', '運転を見合', '折り返し運転', 'ダイヤが乱れ'];
  /** today's status for the lines of a station: [{name, delayed, text}] for lines that report one */
  async function lineStatus(station) {
    const all = await trainInformation();
    if (!all) return null;
    return station.lines.map((l) => {
      const op = l.railway.replace('odpt.Railway:', 'odpt.Operator:').split('.').slice(0, 2).join('.');
      const hit = all.find((x) => x['odpt:railway'] === l.railway) ?? all.find((x) => !x['odpt:railway'] && x['odpt:operator'] === op);
      if (!hit) return null;
      const text = String(hit['odpt:trainInformationText']?.ja ?? hit['odpt:trainInformationText'] ?? '');
      const first = text.split(/[。【\n]/)[0];
      return { name: l.name, delayed: DELAY.some((w) => first.includes(w)) && !first.includes('ありません'), text };
    }).filter(Boolean);
  }

  const statusCache = new Map();
  async function bikeStatus(sys) {
    const c = statusCache.get(sys);
    if (c && Date.now() - c.at < 60e3) return c.map;
    const j = await relayGet(`${RELAY}/main/v4/gbfs/${encodeURIComponent(sys)}/station_status.json`);
    if (!j) return c?.map ?? null;
    const map = new Map((j.data?.stations ?? []).map((s) => [String(s.station_id), { bikes: s.num_bikes_available, docks: s.num_docks_available, renting: s.is_renting !== false }]));
    statusCache.set(sys, { at: Date.now(), map });
    return map;
  }
  /** bike-share ports within maxM, nearest first, with live counts when available */
  async function portsNear(lat, lon, maxM = 500, limit = 2) {
    const p = await loadPorts();
    if (!p) return [];
    const near = p.ports.map((x) => ({ ...x, d: Math.round(dist(lat, lon, x.lat, x.lon)) }))
      .filter((x) => x.d <= maxM).sort((a, b) => a.d - b.d).slice(0, limit);
    const systems = [...new Set(near.map((x) => x.sys))];
    const maps = Object.fromEntries(await Promise.all(systems.map(async (s) => [s, await bikeStatus(s)])));
    return near.map((x) => ({ ...x, status: maps[x.sys]?.get(x.id) ?? null }));
  }

  window.Transit = { load, nearestStations, trainVerdict, lineStatus, portsNear, dayType, serviceTime };
})();

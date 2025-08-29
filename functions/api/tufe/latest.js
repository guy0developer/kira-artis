// Cloudflare Pages Functions (free) — OECD SDMX-JSON
// Çıktı: { period:"MM-YYYY", avg12_pct, yoy_pct?, monthly_pct?, source }
// Metodoloji: 12 ay ortalama = (son12 endeks ort / önceki12 endeks ort - 1)*100
// Kaynaklar: PRICES_CPI / TUR.CPALTT01.[IXOB|GY|GP].M  (OECD SDMX-JSON)

export async function onRequestGet({ request, waitUntil }) {
  const url = new URL(request.url);
  const debug = url.searchParams.get("debug") === "1";
  const logs = [];
  const log = (m) => debug && logs.push(String(m));

  // 6 saat edge cache
  const cache = caches.default;
  const cacheKey = new Request(url.origin + "/__tufe_oecd_v1");
  if (!debug) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  try {
    // OECD PRICES_CPI veri kümesi
    const BASE = "https://stats.oecd.org/SDMX-JSON/data/PRICES_CPI";

    // 1) Endeks (IXOB) → 12 ay ortalama için gerekli
    const ixob = await fetchSdmxSeriesJSON(`${BASE}/TUR.CPALTT01.IXOB.M/all`, log);
    if (!ixob.length) throw new Error("ixob_empty");
    const lastYYYYMM = ixob[ixob.length - 1].period;
    if (ixob.length < 24) throw new Error("ixob_insufficient_obs");

    // Endeksi sayılara çevir, son 24 ayı al
    const idxVals = ixob.map(r => toNum(r.value)).filter(Number.isFinite);
    const cur12 = mean(idxVals.slice(-12));
    const prev12 = mean(idxVals.slice(-24, -12));
    if (!isFinite(cur12) || !isFinite(prev12) || prev12 === 0) throw new Error("avg12_calc_fail");
    const avg12_pct = (cur12 / prev12 - 1) * 100;

    // 2) Yıllık (GY) — opsiyonel
    let yoy_pct = null;
    try {
      const gy = await fetchSdmxSeriesJSON(`${BASE}/TUR.CPALTT01.GY.M/all`, log);
      if (gy.length) {
        const map = new Map(gy.map(d => [d.period, toNum(d.value)]));
        yoy_pct = map.get(lastYYYYMM) ?? toNum(gy[gy.length - 1].value);
      }
    } catch (e) { log("gy_fail:" + e.message); }

    // 3) Aylık (GP) — opsiyonel
    let monthly_pct = null;
    try {
      const gp = await fetchSdmxSeriesJSON(`${BASE}/TUR.CPALTT01.GP.M/all`, log);
      if (gp.length) {
        const map = new Map(gp.map(d => [d.period, toNum(d.value)]));
        monthly_pct = map.get(lastYYYYMM) ?? toNum(gp[gp.length - 1].value);
      }
    } catch (e) { log("gp_fail:" + e.message); }

    const body = {
      period: toMMYYYY(lastYYYYMM),
      avg12_pct: round2(avg12_pct),
      ...(yoy_pct != null ? { yoy_pct: round2(yoy_pct) } : {}),
      ...(monthly_pct != null ? { monthly_pct: round2(monthly_pct) } : {}),
      source: "OECD PRICES_CPI (SDMX-JSON)"
    };

    const res = json(debug ? { ...body, __debug: { logs } } : body);
    if (!debug) waitUntil(cache.put(cacheKey, res.clone()));
    return res;

  } catch (e) {
    const err = String(e?.message || e);
    const res = json(debug ? { error: "unavailable", __debug: { logs: logs.concat(err) } } : { error: "unavailable" }, 502);
    return res;
  }
}

// ---- SDMX-JSON fetch & parse ----
// Beklenen çıktı: [{period:"YYYY-MM", value:Number}, ...], kronolojik
async function fetchSdmxSeriesJSON(u, log) {
  const r = await fetch(u, {
    headers: { "Accept": "application/json" },
    cf: { cacheTtl: 21600, cacheEverything: true }
  });
  if (!r.ok) {
    log && log(`http_${r.status}_${u}`);
    throw new Error(`http_${r.status}`);
  }
  const j = await r.json();

  // SDMX-JSON yapısı: dataSets[0].series[<key>].observations & structure.dimensions.observation[0].values
  const ds = j?.dataSets?.[0];
  const obsDim = j?.structure?.dimensions?.observation?.[0]; // genelde TIME_PERIOD
  const seriesObj = ds?.series;
  const firstKey = seriesObj && Object.keys(seriesObj)[0];
  if (!ds || !obsDim || !firstKey) throw new Error("sdmx_parse_head");

  const obs = seriesObj[firstKey]?.observations || {};
  const times = obsDim.values?.map(v => v.id || v.name)?.map(String) || [];

  const out = [];
  for (const k in obs) {
    const i = Number(k);
    if (Number.isInteger(i) && times[i] != null) {
      const v = obs[k]?.[0];
      if (v != null) out.push({ period: times[i], value: Number(v) });
    }
  }
  // kronolojik sırala
  out.sort((a, b) => a.period.localeCompare(b.period));
  return out;
}

// ---- utils ----
const toNum = (x) => {
  const n = Number(String(x ?? "").replace(",", ".").trim());
  return Number.isFinite(n) ? n : NaN;
};
const mean = (arr) => arr.reduce((s, v) => s + v, 0) / (arr.length || 1);
const round2 = (n) => Math.round(n * 100) / 100;
const toMMYYYY = (p) => {
  const m = String(p).match(/^(\d{4})-(\d{2})$/);
  return m ? `${m[2]}-${m[1]}` : String(p);
};

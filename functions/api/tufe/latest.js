// functions/api/tufe/latest.js
// Ücretsiz kaynak: OECD SDMX-JSON (key yok).
// Çıktı: { period, monthly_pct, yoy_pct, avg12_pct, source }
// Hesap: avg12_pct = (son12EndeksOrt / önceki12EndeksOrt - 1) * 100

export async function onRequestGet({ request, waitUntil }) {
  const url = new URL(request.url);
  const debug = url.searchParams.get("debug") === "1";
  const logs = [];
  const log = (m) => { if (debug) logs.push(String(m)); };

  const cache = caches.default;
  const cacheKey = new Request(url.origin + "/__tufe_latest_v3");
  const cached = await cache.match(cacheKey);
  if (cached && !debug) return cached;

  try {
    // 1) OECD SDMX-JSON: MEI_CPI / Türkiye / CPALTT01 / GP (monthly change) / M (monthly)
    // Eski uç hala çalışıyor ve CORS açık:
    const GP_URL = "https://stats.oecd.org/SDMX-JSON/data/MEI_CPI/TUR.CPALTT01.GP.M.A";
    const gp = await fetchSdmxSeries(GP_URL, log); // [{ period:"YYYY-MM", value:number }, ...] kronolojik
    if (!gp || gp.length === 0) throw new Error("oecd_gp_empty");

    // Aylık son değer (UI’da gösterim için)
    const last = gp[gp.length - 1];
    const monthly_pct = toNum(last.value);

    // GP’den endeks kur (100 baz) ve 12ay ort. yıllık artışı hesapla
    // İhtiyacımız: en az 24 gözlem (son 24 ay). Yoksa hesap yapılamaz.
    if (gp.length < 24) throw new Error("not_enough_obs_for_avg12");
    const idx = buildIndexFromMonthlyGP(gp); // [{period, index}] kronolojik

    const n = idx.length;
    const cur12 = mean(idx.slice(n - 12).map(d => d.index));
    const prev12 = mean(idx.slice(n - 24, n - 12).map(d => d.index));
    const avg12_pct = (cur12 / prev12 - 1) * 100;

    // 2) İsteğe bağlı: Y/Y (GY) serisi – bulamazsak sorun değil
    let yoy_pct = null;
    try {
      const GY_URL = "https://stats.oecd.org/SDMX-JSON/data/MEI_CPI/TUR.CPALTT01.GY.M.A";
      const gy = await fetchSdmxSeries(GY_URL, log);
      if (gy && gy.length) {
        const gyMap = new Map(gy.map(d => [d.period, toNum(d.value)]));
        if (gyMap.has(last.period)) yoy_pct = gyMap.get(last.period);
        else yoy_pct = gy[gy.length - 1].value; // aynı aya denk gelmezse son gözlem
      }
    } catch (e) { log("oecd_gy_fail:" + e.message); }

    const body = {
      period: last.period,          // "YYYY-MM"
      monthly_pct: round2(monthly_pct),
      yoy_pct: yoy_pct != null ? round2(yoy_pct) : null,
      avg12_pct: round2(avg12_pct),
      source: "OECD MEI_CPI (SDMX-JSON)"
    };

    const res = json(body, 200, debug ? { __debug: { logs } } : undefined);
    // 6 saat edge cache
    waitUntil(cache.put(cacheKey, res.clone()));
    return res;

  } catch (e) {
    // Fallback eklemek istersen: Buraya DBnomics MEI GP/GY denemesi koyabilirsin.
    // Şimdilik tek kaynak OECD (ücretsiz ve yeterli).
    const res = json({ error: "unavailable" }, 502, debug ? { __debug: { logs: logs.concat(String(e)) } } : undefined);
    return res;
  }
}

// ---------- Helpers ----------

function json(body, status = 200, extra) {
  const payload = extra ? { ...body, ...extra } : body;
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=21600",
      "access-control-allow-origin": "*"
    }
  });
}

// OECD SDMX-JSON parser (stats.oecd.org/SDMX-JSON/*)
// Dönen şema: dataSets[0].series["0:0:0:0"].observations -> { "0":[val], "1":[val], ... }
// Zaman etiketleri: structure.dimensions.observation[0].values -> [{id:"YYYY-MM"}, ...]
async function fetchSdmxSeries(u, log) {
  const r = await fetch(u, { headers: { Accept: "application/json" }, cf: { cacheTtl: 21600, cacheEverything: true } });
  if (!r.ok) { log(`oecd_http_${r.status}`); throw new Error("oecd_http_" + r.status); }
  const j = await r.json();

  const ds = j?.dataSets?.[0];
  const obsDim = j?.structure?.dimensions?.observation?.[0];
  const seriesObj = ds?.series;
  const seriesKey = seriesObj && Object.keys(seriesObj)[0];
  if (!ds || !obsDim || !seriesKey) { log("oecd_parse_head_fail"); throw new Error("oecd_parse_head_fail"); }

  const obs = seriesObj[seriesKey]?.observations || {};
  const times = obsDim.values?.map(v => v.id) || [];
  const out = [];
  for (const k in obs) {
    const i = Number(k);
    if (Number.isInteger(i) && times[i] != null) {
      const v = obs[k]?.[0];
      if (v != null) out.push({ period: times[i], value: Number(v) });
    }
  }
  // Garantili kronoloji
  out.sort((a, b) => (a.period < b.period ? -1 : 1));
  return out;
}

function buildIndexFromMonthlyGP(series) {
  // series: [{period:"YYYY-MM", value: gpPct}]
  let level = 100; // baz
  const out = [];
  for (const d of series) {
    const gp = toNum(d.value);
    if (gp == null) continue;
    level = level * (1 + gp / 100);
    out.push({ period: d.period, index: level });
  }
  return out;
}

const toNum = (x) => {
  if (x == null) return null;
  const n = Number(String(x).replace(",", ".").trim());
  return Number.isFinite(n) ? n : null;
};
const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
const round2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

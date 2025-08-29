// Cloudflare Pages Functions - /functions/api/tufe/latest.js
// Kaynaklar: DBnomics (OECD / MEI)
// - IXOB (index, 2015=100) → 12 aylık ortalama değişim (%)
// - GY (y/y %)               → Yıllık değişim (%)
// - GP (m/m %)               → Aylık değişim (%)
//
// Yanıt şeması:
// { period: "MM-YYYY", avg12_pct: number, yoy_pct?: number, monthly_pct?: number, source: string }
// ?debug=1 ile: { ..., __debug: { logs: string[] } }

export async function onRequestGet({ request, waitUntil }) {
  const url = new URL(request.url);
  const debug = url.searchParams.has("debug");
  const logs = [];

  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).origin + "/__tufe_latest_v2");
  if (!debug) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  try {
    const data = await fetchFromDBnomics(logs);
    if (data) {
      const res = jsonResponse(debug ? { ...data, __debug: { logs } } : data);
      waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    }
  } catch (e) {
    logs.push("dbnomics_error:" + (e && e.message ? e.message : "unknown"));
  }

  // Ulaşamadıysak 502 dön.
  return jsonResponse(debug ? { error: "unavailable", __debug: { logs } } : { error: "unavailable" }, 502);
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=21600", // 6 saat
      "access-control-allow-origin": "*"
    }
  });
}

async function fetchFromDBnomics(logs) {
  // OECD/MEI veri kümesi — TÜRKİYE, TÜFE "All items"
  const BASE = "https://api.db.nomics.world/v22/series/OECD/MEI";
  const ixobURL = `${BASE}/TUR.CPALTT01.IXOB.M?format=json`;
  const gyURL   = `${BASE}/TUR.CPALTT01.GY.M?format=json`;
  const gpURL   = `${BASE}/TUR.CPALTT01.GP.M?format=json`;

  // DBnomics ara sıra 302/redirect atar; fetch bunu takip eder.
  const [ixobResp, gyResp, gpResp] = await Promise.all([
    fetch(ixobURL, { headers: { Accept: "application/json" }, cf: { cacheTtl: 21600, cacheEverything: true } }),
    fetch(gyURL,   { headers: { Accept: "application/json" }, cf: { cacheTtl: 21600, cacheEverything: true } }),
    fetch(gpURL,   { headers: { Accept: "application/json" }, cf: { cacheTtl: 21600, cacheEverything: true } }),
  ]);

  if (!ixobResp.ok) { logs && logs.push("db_ixob_http_" + ixobResp.status); throw new Error("ixob_http_" + ixobResp.status); }
  const ixobJson = await ixobResp.json();
  const { periodArr: pIX, valueArr: vIX } = pickSeriesArrays(ixobJson);
  if (!pIX.length || !vIX.length) { logs && logs.push("db_ixob_parse_fail"); throw new Error("ixob_parse"); }

  // Son dönem (en yeni ay) ve 12 aylık ortalama değişim (kanuni tanım)
  const lastIdx = lastValidIndex(vIX);
  if (lastIdx < 0) { logs && logs.push("db_ixob_all_na"); throw new Error("ixob_na"); }

  const lastPeriod = String(pIX[lastIdx]);        // "2025-07" gibi
  const { avg12Pct } = computeAvg12Pct(vIX, lastIdx);
  // Opsiyonel: y/y ve m/m
  let yoy = null, mom = null;

  if (gyResp.ok) {
    const gyJson = await gyResp.json();
    const { valueArr: vGY, periodArr: pGY } = pickSeriesArrays(gyJson);
    const i = lastValidIndex(vGY);
    if (i >= 0 && samePeriod(pGY[i], lastPeriod)) yoy = toNumber(vGY[i]);
    else if (i >= 0) yoy = toNumber(vGY[i]); // yakın dönem, yine de koy
    else logs && logs.push("db_gy_na");
  } else {
    logs && logs.push("db_gy_http_" + gyResp.status);
  }

  if (gpResp.ok) {
    const gpJson = await gpResp.json();
    const { valueArr: vGP, periodArr: pGP } = pickSeriesArrays(gpJson);
    const i = lastValidIndex(vGP);
    if (i >= 0 && samePeriod(pGP[i], lastPeriod)) mom = toNumber(vGP[i]);
    else if (i >= 0) mom = toNumber(vGP[i]);
    else logs && logs.push("db_gp_na");
  } else {
    logs && logs.push("db_gp_http_" + gpResp.status);
  }

  return {
    period: formatPeriod(lastPeriod),        // "MM-YYYY"
    avg12_pct: round2(avg12Pct),
    ...(yoy != null ? { yoy_pct: round2(yoy) } : {}),
    ...(mom != null ? { monthly_pct: round2(mom) } : {}),
    source: "OECD → DBnomics (MEI • CPALTT01.*.M)"
  };
}

// ---- yardımcılar ----

function pickSeriesArrays(j) {
  // DBnomics JSON iki şemadan biriyle gelebilir
  const d = j?.series?.docs?.[0];
  if (d?.period?.length && d?.value?.length) {
    return { periodArr: d.period, valueArr: d.value };
  }
  if (Array.isArray(j?.series?.period) && Array.isArray(j?.series?.value)) {
    return { periodArr: j.series.period, valueArr: j.series.value };
  }
  return { periodArr: [], valueArr: [] };
}

function lastValidIndex(arr) {
  for (let i = arr.length - 1; i >= 0; i--) {
    const n = toNumber(arr[i]);
    if (Number.isFinite(n)) return i;
  }
  return -1;
}

// 12 aylık ortalama değişim (%): (son12 ort / önceki12 ort - 1)*100
function computeAvg12Pct(values, lastIdx) {
  const nums = values.map(toNumber);
  // lastIdx dahil olan ay son ayımız; son 12 ay: [lastIdx-11 .. lastIdx]
  const end = lastIdx;
  const start = lastIdx - 11;
  const prevEnd = start - 1;
  const prevStart = prevEnd - 11;
  if (start < 0 || prevStart < 0) return { avg12Pct: null };

  const cur12 = avg(nums.slice(start, end + 1));
  const prev12 = avg(nums.slice(prevStart, prevEnd + 1));
  if (!isFinite(cur12) || !isFinite(prev12) || prev12 === 0) return { avg12Pct: null };

  return { avg12Pct: ((cur12 / prev12) - 1) * 100 };
}

function avg(arr) {
  const xs = arr.map(toNumber).filter((x) => Number.isFinite(x));
  if (!xs.length) return NaN;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function toNumber(x) {
  if (x == null) return NaN;
  return Number(String(x).replace(",", ".").trim());
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

function samePeriod(p, want) {
  return String(p).trim() === String(want).trim();
}

function formatPeriod(p) {
  // "YYYY-MM" → "MM-YYYY"
  const m = String(p).match(/^(\d{4})-(\d{2})$/);
  return m ? `${m[2]}-${m[1]}` : String(p);
}

// functions/api/tufe/latest.js
// Amaç: TÜFE 12 aylık ortalama değişim (avg12_pct) + (varsa) yoy ve monthly.
// Kaynak: DBnomics (IMF/OECD). Gerekirse TCMB HTML fallback (best-effort).

export async function onRequestGet({ request, waitUntil }) {
  const url = new URL(request.url);
  const debug = url.searchParams.has("debug");
  const logs = [];

  const cache = caches.default;
  const cacheKey = new Request(url.origin + "/__tufe_latest_v3");
  if (!debug) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  // 1) DBnomics (endeks serisinden hesapla) — birden çok aday dene
  const candidates = [
    // IMF IFS: Aylık TÜFE endeksi
    { provider: "IMF",  dataset: "IFS",     series: "PCPI_IX.TUR.M",       type: "index" },
    // OECD MEI CPI: Aylık TÜFE endeksi (2015=100)
    { provider: "OECD", dataset: "MEI_CPI", series: "TUR.CPALTT01.IXOB.M", type: "index" },
    // OECD KEI alternatifleri
    { provider: "OECD", dataset: "KEI",     series: "CPALTT01.TUR.IXOB.M", type: "index" },
    // Son çare: aylık büyüme (index yoksa) — sadece monthly verir
    { provider: "OECD", dataset: "KEI",     series: "CPALTT01.TUR.GP.M",   type: "monthly" }
  ];

  for (const c of candidates) {
    try {
      const data = await fetchFromDBnomics(c, logs);
      if (data) {
        const res = jsonResponse(data, 200, debug ? { logs, source: `db:${c.provider}/${c.dataset}/${c.series}` } : undefined);
        if (!debug) waitUntil(cache.put(cacheKey, res.clone()));
        return res;
      }
    } catch (e) {
      logs.push(`dbnomics_err_${c.provider}_${c.dataset}_${c.series}:` + String(e));
    }
  }

  // 2) (Opsiyonel) TCMB HTML fallback — sayfa sık değiştiği için best-effort
  try {
    const data = await fetchFromTCMB(logs);
    if (data) {
      const res = jsonResponse(data, 200, debug ? { logs, source: "tcmb" } : undefined);
      if (!debug) waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    }
  } catch (e) {
    logs.push("tcmb_error:" + String(e));
  }

  return jsonResponse({ error: "unavailable" }, 502, debug ? { logs } : undefined);
}

function jsonResponse(core, status = 200, meta) {
  const body = meta ? { ...core, __debug: meta } : core;
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=21600", // 6 saat
      "access-control-allow-origin": "*"
    }
  });
}

/* ---------------- DBNOMICS ---------------- */

async function fetchFromDBnomics({ provider, dataset, series, type }, logs) {
  // Son 36 gözlemi iste (12ay ort hesap için 24 ay gerekir, 36 güvenli)
  const base = `https://api.db.nomics.world/v22/series/${provider}/${dataset}/${series}?observations=36&format=json`;
  const r = await fetch(base, {
    headers: { Accept: "application/json" },
    cf: { cacheTtl: 21600, cacheEverything: true }
  });
  if (!r.ok) {
    logs?.push(`db_http_${provider}_${r.status}`);
    return null;
  }
  const j = await r.json();

  const { periods, values } = extractPeriodsValues(j) || {};
  if (!periods || !values || values.length < 25) {
    logs?.push("db_parse_no_series");
    return null;
  }

  // En son dönemi bul (son geçerli numeric)
  let last = values.length - 1;
  while (last >= 0 && !isFinite(values[last])) last--;
  if (last < 24) return null;

  const period = formatPeriod(periods[last]);

  if (type === "index") {
    // 12 aylık ortalama değişim: (avg(t-11..t) / avg(t-23..t-12) - 1) * 100
    const cur = avg(values.slice(last - 11, last + 1));
    const prev = avg(values.slice(last - 23, last - 11));
    if (!isFinite(cur) || !isFinite(prev) || prev === 0) return null;

    const avg12_pct = (cur / prev - 1) * 100;

    // Ek: Y/Y ve aylık da hesaplanabiliyorsa ver
    const yoy_pct = isFinite(values[last - 12]) && values[last - 12] !== 0
      ? ((values[last] / values[last - 12]) - 1) * 100
      : null;

    const monthly_pct = isFinite(values[last - 1]) && values[last - 1] !== 0
      ? ((values[last] / values[last - 1]) - 1) * 100
      : null;

    return {
      period,
      avg12_pct: round2(avg12_pct),
      yoy_pct: yoy_pct != null ? round2(yoy_pct) : null,
      monthly_pct: monthly_pct != null ? round2(monthly_pct) : null,
      source: `${provider} / ${dataset} (${series})`
    };
  }

  // type === 'monthly' (growth previous period)
  const monthly = values[last];
  if (!isFinite(monthly)) return null;
  return {
    period,
    avg12_pct: null,
    yoy_pct: null,
    monthly_pct: round2(monthly),
    source: `${provider} / ${dataset} (${series})`
  };
}

function extractPeriodsValues(j) {
  // 1) series.period[] + series.value[]
  if (Array.isArray(j?.series?.period) && Array.isArray(j?.series?.value)) {
    return {
      periods: j.series.period.map(String),
      values: j.series.value.map(toNumber)
    };
  }
  // 2) series.docs[0].period/value
  const d = j?.series?.docs?.[0];
  if (d?.period?.length && d?.value?.length) {
    return { periods: d.period.map(String), values: d.value.map(toNumber) };
  }
  // 3) series.observations: [[period, value], ...]
  if (Array.isArray(j?.series?.observations)) {
    const periods = [], values = [];
    for (const row of j.series.observations) {
      periods.push(String(row[0]));
      values.push(toNumber(row[1]));
    }
    return { periods, values };
  }
  // 4) Bazı sağlayıcılarda series.data.{periods,values}
  if (Array.isArray(j?.series?.data?.periods) && Array.isArray(j?.series?.data?.values)) {
    return {
      periods: j.series.data.periods.map(String),
      values: j.series.data.values.map(toNumber)
    };
  }
  return null;
}

/* ---------------- TCMB (best-effort) ---------------- */

async function fetchFromTCMB(logs) {
  const url =
    "https://www.tcmb.gov.tr/wps/wcm/connect/TR/TCMB%2BTR/Main%2BMenu/Istatistikler/Enflasyon%2BVerileri/Tuketici%2BFiyatlari";

  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; CF-Worker; +https://developers.cloudflare.com/workers/)",
      "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8"
    },
    cf: { cacheTtl: 21600, cacheEverything: true }
  });
  if (!r.ok) {
    logs?.push("tcmb_http_" + r.status);
    return null;
  }
  const html = await r.text();

  // Satır: <td>MM-YYYY</td> + 3 sayı (y/y, aylık, 12ay ort)
  const row = html.match(/<tr[^>]*>\s*<td[^>]*>\s*(\d{2}-\d{4})\s*<\/td>([\s\S]*?)<\/tr>/i);
  if (row) {
    const period = row[1];
    const nums = Array.from(row[2].matchAll(/<td[^>]*>\s*([0-9.,-]+)\s*<\/td>/gi)).map(m => m[1]);
    if (nums.length >= 3) {
      const yoy = toNumber(nums[0]);
      const monthly = toNumber(nums[1]);
      const avg12 = toNumber(nums[2]);
      if (avg12 != null) {
        return {
          period,
          avg12_pct: round2(avg12),
          yoy_pct: yoy != null ? round2(yoy) : null,
          monthly_pct: monthly != null ? round2(monthly) : null,
          source: "TCMB / Tüketici Fiyatları (12 aylık ort.)"
        };
      }
    }
  }

  // Anahtar kelime yaklaşımı (yedek)
  const row2 = html.match(/(\d{2}-\d{4})[\s\S]{0,400}?(?:12\s*ay(?:lık)?[^\d]{0,40})([0-9.,-]{1,8})/i);
  if (row2) {
    const period = row2[1];
    const avg12 = toNumber(row2[2]);
    if (avg12 != null) {
      return { period, avg12_pct: round2(avg12), yoy_pct: null, monthly_pct: null, source: "TCMB (12 ay ort.)" };
    }
  }

  logs?.push("tcmb_parse_fail");
  return null;
}

/* ---------------- helpers ---------------- */

function toNumber(x) {
  if (x == null) return NaN;
  const n = Number(String(x).replace(",", ".").trim());
  return Number.isFinite(n) ? n : NaN;
}
function avg(arr) {
  const xs = arr.filter(v => Number.isFinite(v));
  if (!xs.length) return NaN;
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}
function round2(n) {
  return Math.round(n * 100) / 100;
}
function formatPeriod(p) {
  // '2025-07' veya '2025-07-01' -> '07-2025', '07/2025' vb. varyantlar için
  const m = String(p).match(/(\d{4})[-/\.]?(\d{1,2})/);
  if (m) {
    const y = m[1], mm = String(m[2]).padStart(2, "0");
    return `${mm}-${y}`;
  }
  // '07-2025' zaten uyumlu ise olduğu gibi
  const m2 = String(p).match(/(\d{2})-(\d{4})/);
  return m2 ? m2[0] : String(p);
}

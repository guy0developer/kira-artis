// functions/api/tufe/latest.js
export async function onRequestGet({ request, waitUntil }) {
  const url = new URL(request.url);
  const debug = url.searchParams.has("debug");
  const logs = [];

  const cache = caches.default;
  const cacheKey = new Request(url.origin + "/__tufe_latest_v2");
  if (!debug) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  // 1) TCMB
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

  // 2) DBnomics (aylık)
  try {
    const data = await fetchFromDBnomics(logs);
    if (data) {
      const res = jsonResponse(data, 200, debug ? { logs, source: "dbnomics" } : undefined);
      if (!debug) waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    }
  } catch (e) {
    logs.push("dbnomics_error:" + String(e));
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

// ---------- TCMB PARSER ----------
async function fetchFromTCMB(logs) {
  const url =
    "https://www.tcmb.gov.tr/wps/wcm/connect/TR/TCMB%2BTR/Main%2BMenu/Istatistikler/Enflasyon%2BVerileri/Tuketici%2BFiyatlari";

  const r = await fetch(url, {
    headers: {
      // bazı siteler UA ve dil isteyebiliyor
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

  // 1) İlk satırı al (MM-YYYY) ve o satırdaki ilk 3 sayıyı çek
  // <td>07-2025</td> ... <td>yoy</td> ... <td>monthly</td> ... <td>12ay</td>
  const row = html.match(/<tr[^>]*>\s*<td[^>]*>\s*(\d{2}-\d{4})\s*<\/td>([\s\S]*?)<\/tr>/i);
  if (row) {
    const period = row[1];
    const nums = Array.from(row[2].matchAll(/<td[^>]*>\s*([0-9.,-]+)\s*<\/td>/gi)).map(m => m[1]);
    if (nums.length >= 3) {
      // çoğu tabloda 3. sayı = 12 aylık ort.
      const yoy = toNumber(nums[0]);
      const monthly = toNumber(nums[1]);
      const avg12 = toNumber(nums[2]);
      if (avg12 != null) {
        return {
          period,
          monthly_pct: monthly ?? null,
          yoy_pct: yoy ?? null,
          avg12_pct: avg12,
          source: "TCMB / Tüketici Fiyatları (12 aylık ort.)"
        };
      }
    }
  }

  // 2) Alternatif: "12 aylık" anahtar kelimesi etrafındaki sayıyı ara
  const row2 = html.match(/(\d{2}-\d{4})[\s\S]{0,400}?(?:12\s*ay(?:lık)?[^\d]{0,40})([0-9.,-]{1,8})/i);
  if (row2) {
    const period = row2[1];
    const avg12 = toNumber(row2[2]);
    if (avg12 != null) {
      return { period, monthly_pct: null, yoy_pct: null, avg12_pct: avg12, source: "TCMB (12 ay ort.)" };
    }
  }

  logs?.push("tcmb_parse_fail");
  return null;
}

// ---------- DBNOMICS PARSER (monthly) ----------
async function fetchFromDBnomics(logs) {
  // OECD: CPALTT01.TUR.GP.M = Aylık, bir önceki döneme göre değişim (growth previous period)
  // JSON 3 farklı görünümde gelebiliyor; hepsine göre dene.
  const base = "https://api.db.nomics.world/v22/series/OECD/KEI/CPALTT01.TUR.GP.M";
  // 1) observations
  let r = await fetch(base + "/observations?format=json", {
    headers: { Accept: "application/json" },
    cf: { cacheTtl: 21600, cacheEverything: true }
  });
  if (r.ok) {
    const j = await r.json();
    const obs = j?.series?.observations;
    if (Array.isArray(obs) && obs.length) {
      const [period, value] = obs[obs.length - 1];
      const monthly = toNumber(value);
      if (monthly != null) {
        return {
          period: String(period),
          monthly_pct: monthly,
          yoy_pct: null,
          avg12_pct: null,
          source: "OECD / DBnomics (monthly)"
        };
      }
    }
  } else {
    logs?.push("dbnomics_http1_" + r.status);
  }

  // 2) period + value dizileri
  r = await fetch(base + "?format=json", {
    headers: { Accept: "application/json" },
    cf: { cacheTtl: 21600, cacheEverything: true }
  });
  if (r.ok) {
    const j = await r.json();
    if (Array.isArray(j?.series?.period) && Array.isArray(j?.series?.value)) {
      const p = j.series.period.at(-1);
      const v = toNumber(j.series.value.at(-1));
      if (v != null) {
        return { period: String(p), monthly_pct: v, yoy_pct: null, avg12_pct: null, source: "OECD / DBnomics (monthly)" };
      }
    }
    // 3) docs[0] fallback
    const d = j?.series?.docs?.[0];
    if (d?.period?.length && d?.value?.length) {
      const p = String(d.period.at(-1));
      const v = toNumber(d.value.at(-1));
      if (v != null) {
        return { period: p, monthly_pct: v, yoy_pct: null, avg12_pct: null, source: "OECD / DBnomics (monthly)" };
      }
    }
  } else {
    logs?.push("dbnomics_http2_" + r.status);
  }

  logs?.push("dbnomics_parse_fail");
  return null;
}

function toNumber(x) {
  if (x == null) return null;
  const n = Number(String(x).replace(",", ".").trim());
  return Number.isFinite(n) ? n : null;
}

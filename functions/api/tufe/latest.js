// functions/api/tufe/latest.js
export async function onRequestGet({ request, waitUntil }) {
  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).origin + "/__tufe_latest_v1");
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // 1) Önce TCMB
  try {
    const data = await fetchFromTCMB();
    if (data) {
      const res = jsonResponse(data);
      waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    }
  } catch (_) {}

  // 2) Fallback: DBnomics
  try {
    const data = await fetchFromDBnomics();
    if (data) {
      const res = jsonResponse(data);
      waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    }
  } catch (_) {}

  return jsonResponse({ error: "unavailable" }, 502);
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

async function fetchFromTCMB() {
  const url = "https://www.tcmb.gov.tr/wps/wcm/connect/TR/TCMB%2BTR/Main%2BMenu/Istatistikler/Enflasyon%2BVerileri/Tuketici%2BFiyatlari";
  const r = await fetch(url, { cf: { cacheTtl: 21600, cacheEverything: true } });
  if (!r.ok) return null;
  const html = await r.text();

  // İlk veri satırını ve aynı satırdaki üç sayıyı yakala (y/y, aylık, 12ay ort)
  // Not: TCMB tablosu <td>MM-YYYY</td> ardından 3 <td> oran içerir.
  const row = html.match(/(\d{2}-\d{4})\s*<\/td>([\s\S]*?)<\/tr>/i);
  if (!row) return null;
  const period = row[1];
  const nums = Array.from(row[2].matchAll(/<td[^>]*>\s*([0-9.,-]+)\s*<\/td>/gi)).map(m => m[1]);
  if (nums.length < 3) return null;

  const [yoy, monthly, avg12] = nums.map(toNumber);
  if (avg12 == null) return null;

  return {
    period,
    monthly_pct: monthly ?? null,
    yoy_pct: yoy ?? null,
    avg12_pct: avg12,
    source: "TCMB / Tüketici Fiyatları (12 aylık ort.)"
  };
}

async function fetchFromDBnomics() {
  const url = "https://api.db.nomics.world/v22/series/OECD/KEI/CPALTT01.TUR.GP.M?format=json";
  const r = await fetch(url, { headers: { Accept: "application/json" }, cf: { cacheTtl: 21600, cacheEverything: true }});
  if (!r.ok) return null;
  const j = await r.json();

  let period, monthly;
  const d = j?.series?.docs?.[0];
  if (d?.period?.length && d?.value?.length) {
    period = String(d.period.at(-1));
    monthly = toNumber(d.value.at(-1));
  } else if (Array.isArray(j?.series?.period) && Array.isArray(j?.series?.value)) {
    period = String(j.series.period.at(-1));
    monthly = toNumber(j.series.value.at(-1));
  }

  return (monthly==null) ? null : {
    period,
    monthly_pct: monthly,
    yoy_pct: null,
    avg12_pct: null, // DBnomics bu uçta yok; UI'da manuel girilebilir
    source: "OECD / DBnomics (monthly)"
  };
}

function toNumber(x) {
  if (x == null) return null;
  const n = Number(String(x).replace(",", ".").trim());
  return Number.isFinite(n) ? n : null;
}

// functions/api/tufe/latest.js
// Kaynak: OECD stats.sdmx (PRICES_CPI) — ÜCRETSİZ
// Seriler:
//  - TUR.CPALTT01.IXOB.M  -> Endeks (2015=100)  → 12 Aylık Ortalama (%) buradan hesaplanır
//  - TUR.CPALTT01.GY.M    -> Yıllık % (y/y)
//  - TUR.CPALTT01.GP.M    -> Aylık % (m/m)
// Yanıt: { period: "MM-YYYY", avg12_pct, yoy_pct, monthly_pct, source }

export async function onRequestGet({ request, waitUntil }) {
  const url = new URL(request.url);
  const debug = url.searchParams.get("debug") === "1";
  const logs = [];

  const cache = caches.default;
  const cacheKey = new Request(url.origin + "/__tufe_latest_prices_cpi_v1");
  if (!debug) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  try {
    // 1) Endeks (IXOB) → 12 ay ort. hesapla
    const ix = await fetchOECD_CSV("TUR.CPALTT01.IXOB.M", logs); // [{period:"YYYY-MM", value}]
    if (!ix.length) throw new Error("ixob_empty");
    const last = ix[ix.length - 1].period;

    if (ix.length < 24) throw new Error("ixob_not_enough_data");
    const idxVals = ix.map(r => r.value).filter(Number.isFinite);
    const cur12 = mean(idxVals.slice(-12));
    const prev12 = mean(idxVals.slice(-24, -12));
    if (!isFinite(cur12) || !isFinite(prev12) || prev12 === 0) throw new Error("ixob_avg12_fail");
    const avg12_pct = (cur12 / prev12 - 1) * 100;

    // 2) Yıllık (GY) ve Aylık (GP) — bulunamazsa null bırak
    let yoy_pct = null, monthly_pct = null;

    try {
      const gy = await fetchOECD_CSV("TUR.CPALTT01.GY.M", logs);
      if (gy.length) {
        const m = new Map(gy.map(r => [r.period, r.value]));
        yoy_pct = m.has(last) ? m.get(last) : gy[gy.length - 1].value;
      }
    } catch (e) { logs.push("GY_fail:" + e.message); }

    try {
      const gp = await fetchOECD_CSV("TUR.CPALTT01.GP.M", logs);
      if (gp.length) {
        const m = new Map(gp.map(r => [r.period, r.value]));
        monthly_pct = m.has(last) ? m.get(last) : gp[gp.length - 1].value;
      }
    } catch (e) { logs.push("GP_fail:" + e.message); }

    const body = {
      period: toMMYYYY(last),                  // "MM-YYYY"
      avg12_pct: round2(avg12_pct),
      ...(yoy_pct != null ? { yoy_pct: round2(yoy_pct) } : {}),
      ...(monthly_pct != null ? { monthly_pct: round2(monthly_pct) } : {}),
      source: "OECD / PRICES_CPI (CPALTT01.*.M)"
    };

    const res = json(debug ? { ...body, __debug: { logs } } : body);
    if (!debug) waitUntil(cache.put(cacheKey, res.clone()));
    return res;

  } catch (e) {
    logs.push("fatal:" + String(e.message || e));
    return json(debug ? { error: "unavailable", __debug: { logs } } : { error: "unavailable" }, 502);
  }
}

// ----- OECD CSV fetch & parse -----

async function fetchOECD_CSV(key, logs) {
  // PRICES_CPI veri kümesi. CSV, TIME/TIME_PERIOD ve Value/OBS_VALUE sütunlarıyla gelir.
  // Örnek: https://stats.oecd.org/SDMX-JSON/data/PRICES_CPI/TUR.CPALTT01.GY.M/all?contentType=csv
  const u = `https://stats.oecd.org/SDMX-JSON/data/PRICES_CPI/${key}/all?contentType=csv`;
  const r = await fetch(u, {
    headers: { "Accept": "text/csv, */*;q=0.1" },
    cf: { cacheTtl: 21600, cacheEverything: true }
  });
  if (!r.ok) { logs.push(`http_${key}_${r.status}`); throw new Error(`http_${key}_${r.status}`); }

  const csv = await r.text();
  const rows = parseCSV(csv);
  if (!rows.length) { logs.push(`csv_empty_${key}`); return []; }

  // Sütun adlarını yakala (farklı varyantlar olabilir)
  const timeCol = pickCol(rows[0], ["TIME", "TIME_PERIOD", "Time", "TIME_PERIOD_LABEL"]);
  const valCol  = pickCol(rows[0], ["Value", "OBS_VALUE", "value"]);
  if (!timeCol || !valCol) { logs.push(`csv_cols_missing_${key}`); return []; }

  // İlk satır başlık olduğundan, 2. satırdan itibaren oku
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const t = rows[i][timeCol];
    const v = toNum(rows[i][valCol]);
    if (t && Number.isFinite(v)) out.push({ period: normYYYYMM(t), value: v });
  }
  // kronolojik sırala
  out.sort((a, b) => a.period.localeCompare(b.period));
  return out;
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length === 0) return [];
  const rows = [];
  const headers = splitCsvLine(lines[0]);

  rows.push(Object.fromEntries(headers.map((h, i) => [h, h]))); // header as first row (for col picking)

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = cols[idx] ?? ""; });
    rows.push(obj);
  }
  return rows;
}

function splitCsvLine(line) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === "," && !inQ) {
      out.push(cur); cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function pickCol(headerRow, candidates) {
  const keys = Object.keys(headerRow);
  for (const c of candidates) {
    const k = keys.find(x => x.toLowerCase() === c.toLowerCase());
    if (k) return k;
  }
  return null;
}

// ----- utils -----
const toNum   = (x) => { const n = Number(String(x ?? "").replace(",", ".").trim()); return Number.isFinite(n) ? n : NaN; };
const mean    = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const round2  = (n) => Math.round(n * 100) / 100;
const toMMYYYY = (p) => {
  const m = String(p).match(/^(\d{4})-(\d{2})$/);
  return m ? `${m[2]}-${m[1]}` : String(p);
};
const normYYYYMM = (t) => {
  // Kabul et: "YYYY-MM", "YYYY-M", "YYYY/MM", "YYYYMM"
  const m = String(t).match(/^(\d{4})[-/]?(\d{1,2})$/) || String(t).match(/^(\d{4})(\d{2})$/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, "0")}`;
  return String(t);
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=21600"
    }
  });
}

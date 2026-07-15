// /api/phx-issued-permits.js
// BlueVera Phoenix Issued Permit Data API - beta-safe separate endpoint
// Purpose: test Phoenix issued permit data as a second/third source before wiring to map.html.
// Note: Phoenix Issued Permit page is a broad data search. This endpoint uses conservative local matching
// after querying several likely residential building permit classes/types.

const CACHE_TTL_MS = 15 * 60 * 1000;
const _cache = new Map();

function cacheGet(key) {
  const h = _cache.get(key);
  if (!h) return null;
  if (Date.now() > h.exp) {
    _cache.delete(key);
    return null;
  }
  return h.payload;
}

function cacheSet(key, payload) {
  _cache.set(key, { exp: Date.now() + CACHE_TTL_MS, payload });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchRetry(url, options = {}, { tries = 2, timeoutMs = 10000 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetchWithTimeout(url, options, timeoutMs);
    } catch (e) {
      lastErr = e;
      await sleep(400 + i * 600);
    }
  }
  throw lastErr;
}

function getSetCookieString(headers) {
  if (typeof headers.getSetCookie === "function") {
    const arr = headers.getSetCookie();
    return Array.isArray(arr) ? arr.map(c => c.split(";")[0]).join("; ") : "";
  }

  const sc = headers.get("set-cookie");
  if (!sc) return "";

  return sc
    .split(/,(?=[^;]+?=)/g)
    .map(c => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

function extractAntiForgeryToken(html) {
  if (!html) return "";
  const m =
    html.match(/name="__RequestVerificationToken"\s+type="hidden"\s+value="([^"]+)"/i) ||
    html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/i);

  return m ? m[1] : "";
}

function clean(v) {
  return String(v || "").replace(/\s+/g, " ").trim();
}

function upper(v) {
  return clean(v).toUpperCase();
}

function mapType(t) {
  const m = {
    AVENUE: "AVE",
    AV: "AVE",
    AVE: "AVE",
    STREET: "ST",
    ST: "ST",
    ROAD: "RD",
    RD: "RD",
    DRIVE: "DR",
    DR: "DR",
    BOULEVARD: "BLVD",
    BLVD: "BLVD",
    LANE: "LN",
    LN: "LN",
    COURT: "CT",
    CT: "CT",
    CIRCLE: "CIR",
    CIR: "CIR",
    PLACE: "PL",
    PL: "PL",
    TERRACE: "TER",
    TER: "TER",
    PARKWAY: "PKWY",
    PKWY: "PKWY",
    TRAIL: "TRL",
    TRL: "TRL",
    HIGHWAY: "HWY",
    HWY: "HWY",
    WAY: "WAY",
    LOOP: "LOOP"
  };

  const u = upper(t);
  return m[u] || u;
}

function firstAddressLine(address) {
  return clean(address).split(",")[0].replace(/\./g, "");
}

function parseAddress(address) {
  const parts = firstAddressLine(address).split(/\s+/).filter(Boolean);

  const out = {
    streetNumber: "",
    direction: "",
    streetName: "",
    streetType: ""
  };

  if (parts.length && /^\d+[A-Za-z]?$/.test(parts[0])) {
    out.streetNumber = parts.shift();
  }

  const dirs = {
    N: "N",
    S: "S",
    E: "E",
    W: "W",
    NE: "NE",
    NW: "NW",
    SE: "SE",
    SW: "SW",
    NORTH: "N",
    SOUTH: "S",
    EAST: "E",
    WEST: "W"
  };

  if (parts.length && dirs[upper(parts[0])]) {
    out.direction = dirs[upper(parts.shift())];
  }

  if (parts.length >= 2) {
    out.streetType = mapType(parts.pop());
  }

  out.streetName = upper(parts.join(" "));

  return out;
}

function normalizeForMatch(v) {
  return upper(v)
    .replace(/[.,#]/g, " ")
    .replace(/\bNORTH\b/g, "N")
    .replace(/\bSOUTH\b/g, "S")
    .replace(/\bEAST\b/g, "E")
    .replace(/\bWEST\b/g, "W")
    .replace(/\bAVENUE\b/g, "AVE")
    .replace(/\bSTREET\b/g, "ST")
    .replace(/\bROAD\b/g, "RD")
    .replace(/\bDRIVE\b/g, "DR")
    .replace(/\bBOULEVARD\b/g, "BLVD")
    .replace(/\s+/g, " ")
    .trim();
}

function hasToken(text, token) {
  if (!token) return false;
  const safe = String(token).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Z0-9])${safe}([^A-Z0-9]|$)`, "i").test(text);
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && clean(obj[k]) !== "") return obj[k];
  }
  return "";
}

function extractRows(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;

  const candidates = [
    payload.data,
    payload.Data,
    payload.rows,
    payload.Rows,
    payload.aaData,
    payload.items,
    payload.Items,
    payload.results,
    payload.Results,
    payload.permits,
    payload.Permits
  ];

  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }

  if (payload.result && Array.isArray(payload.result)) return payload.result;
  if (payload.Result && Array.isArray(payload.Result)) return payload.Result;

  return [];
}

function rowMatches(row, parsed, apn) {
  const addr = normalizeForMatch(
    pick(row, ["Address", "ADDRESS", "Addr", "SiteAddress", "PropertyAddress"]) ||
    JSON.stringify(row)
  );

  const numberOk = parsed.streetNumber ? hasToken(addr, parsed.streetNumber) : false;

  const streetWords = upper(parsed.streetName)
    .split(/\s+/)
    .filter(Boolean);

  const streetOk = streetWords.length
    ? streetWords.every(w => hasToken(addr, w))
    : false;

  const apnValue = upper(
    pick(row, ["Parcel", "PARCEL", "APN", "ParcelNumber", "AssessorParcelNumber"])
  );

  const apnClean = upper(clean(apn).replace(/[^0-9A-Z-]/g, ""));
  const apnPlain = apnClean.replace(/-/g, "");
  const rowPlain = apnValue.replace(/-/g, "");

  const apnOk = !!(
    apnClean &&
    (
      apnValue.includes(apnClean) ||
      (apnPlain && rowPlain.includes(apnPlain))
    )
  );

  return apnOk || (numberOk && streetOk);
}

function normalizePermit(row) {
  return {
    permitNumber: clean(pick(row, [
      "Number",
      "PermitNumber",
      "PermitNo",
      "Permit",
      "PlanNumber"
    ])),
    permitType: clean(pick(row, [
      "Type",
      "PermitType",
      "Struct",
      "StructureClass"
    ])),
    permitStatus: clean(pick(row, [
      "Status",
      "PermitStatus"
    ])),
    issueDate: clean(pick(row, [
      "IssueDate",
      "IssuedDate",
      "DateIssued",
      "Issue Date"
    ])),
    finalDate: clean(pick(row, [
      "FinalDate",
      "Final Date"
    ])),
    address: clean(pick(row, [
      "Address",
      "ADDRESS",
      "Addr",
      "SiteAddress"
    ])),
    apn: clean(pick(row, [
      "Parcel",
      "PARCEL",
      "APN",
      "ParcelNumber"
    ])),
    description: clean(pick(row, [
      "Use",
      "Description",
      "WorkDescription",
      "ProjectName",
      "Owner"
    ])),
    projectName: clean(pick(row, [
      "PlanNumber",
      "ProjectName",
      "Subdivision"
    ])),
    source: "Phoenix Issued Permit Data",
    raw: row
  };
}

function dedupe(permits) {
  const seen = new Set();
  const out = [];

  for (const p of permits || []) {
    const key = [
      p.permitNumber,
      p.issueDate,
      p.address,
      p.description
    ].join("|").toUpperCase();

    if (seen.has(key)) continue;

    seen.add(key);
    out.push(p);
  }

  return out;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      success: true,
      message: "phx-issued-permits alive (POST to query)"
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      success: false,
      error: "POST only"
    });
  }

  try {
    const body = req.body || {};
    const address = clean(body.address || body.fullAddress || "");
    const apn = clean(body.apn || body.parcel || "");
    const parsed = parseAddress(address);

    if (!parsed.streetNumber && !apn) {
      return res.status(400).json({
        ok: false,
        success: false,
        city: "Phoenix",
        source: "Phoenix Issued Permit Data",
        error: "Missing address/APN",
        total: 0,
        permits: []
      });
    }

    const cacheKey = JSON.stringify({ address, apn });
    const cached = cacheGet(cacheKey);

    if (cached) {
      return res.status(200).json({
        ok: true,
        success: true,
        cached: true,
        ...cached
      });
    }

    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36";

    const landingUrl = "https://apps-secure.phoenix.gov/PDD/Search/IssuedPermit";

    const postCandidates = [
      "https://apps-secure.phoenix.gov/PDD/Search/IssuedPermit/_GetIssuedPermitData",
      "https://apps-secure.phoenix.gov/PDD/Search/IssuedPermit/_GetPermitData",
      "https://apps-secure.phoenix.gov/PDD/Search/IssuedPermit/_GetData"
    ];

    const landing = await fetchRetry(
      landingUrl,
      {
        method: "GET",
        headers: {
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
          "user-agent": ua
        }
      },
      { tries: 1, timeoutMs: 10000 }
    );

    const cookie = getSetCookieString(landing.headers);
    const html = await landing.text();
    const token = extractAntiForgeryToken(html);

    const permitTypes = [
      "",
      "R",
      "RS",
      "RSME",
      "RSMP",
      "RSF",
      "BLD",
      "ADDS",
      "ADDR"
    ];

    const attempts = [];
    const found = [];

    for (const postUrl of postCandidates) {
      for (const PermitType of permitTypes) {
        const form = new URLSearchParams({
          sort: "",
          page: "1",
          pageSize: "100",
          group: "",
          filter: "",
          PermitType,
          StructureClass: "",
          StartDate: "01/01/1900",
          EndDate: new Date().toLocaleDateString("en-US"),
          SortBy: "Issue Date"
        });

        if (token) form.set("__RequestVerificationToken", token);

        let upstream;
        let text = "";

        try {
          upstream = await fetchRetry(
            postUrl,
            {
              method: "POST",
              headers: {
                "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                accept: "application/json, text/javascript, */*; q=0.01",
                "x-requested-with": "XMLHttpRequest",
                origin: "https://apps-secure.phoenix.gov",
                referer: landingUrl,
                "accept-language": "en-US,en;q=0.9",
                "user-agent": ua,
                ...(cookie ? { cookie } : {}),
                ...(token ? { requestverificationtoken: token } : {})
              },
              body: form.toString()
            },
            { tries: 1, timeoutMs: 15000 }
          );

          text = await upstream.text();
        } catch (e) {
          attempts.push({
            postUrl,
            PermitType,
            ok: false,
            error: e.message || String(e)
          });
          continue;
        }

        if (!text || text.trim().startsWith("<")) {
          attempts.push({
            postUrl,
            PermitType,
            ok: false,
            status: upstream.status,
            error: "non_json",
            sample: text.slice(0, 200)
          });
          continue;
        }

        let data;

        try {
          data = JSON.parse(text);
        } catch (e) {
          attempts.push({
            postUrl,
            PermitType,
            ok: false,
            status: upstream.status,
            error: "bad_json",
            sample: text.slice(0, 200)
          });
          continue;
        }

        const rows = extractRows(data);
        const matched = rows
          .filter(r => rowMatches(r, parsed, apn))
          .map(normalizePermit);

        attempts.push({
          postUrl,
          PermitType,
          ok: true,
          status: upstream.status,
          rawRowCount: rows.length,
          matchedCount: matched.length
        });

        found.push(...matched);

        if (found.length >= 100) break;
      }

      if (attempts.some(a => a.postUrl === postUrl && a.ok)) break;
    }

    const permits = dedupe(found);

    const payload = {
      city: "Phoenix",
      source: "Phoenix Issued Permit Data",
      sourceType: "official_issued_permit_data",
      total: permits.length,
      permitCount: permits.length,
      permits,
      query: {
        address,
        apn,
        parsedAddress: parsed,
        attempts
      },
      verificationUrl: landingUrl,
      badgeText: permits.length
        ? `Issued permits: ${permits.length} found`
        : "Issued permits: none found",
      note: permits.length
        ? "Phoenix issued permit data records found. Verify final details in the official Phoenix PDD portal."
        : "No matching Phoenix issued permit records parsed from this source. This does not prove that no records exist."
    };

    cacheSet(cacheKey, payload);

    return res.status(200).json({
      ok: true,
      success: true,
      cached: false,
      ...payload
    });

  } catch (e) {
    return res.status(200).json({
      ok: false,
      success: false,
      city: "Phoenix",
      source: "Phoenix Issued Permit Data",
      total: 0,
      permits: [],
      error: e?.name === "AbortError" ? "Upstream timeout" : e?.message || String(e),
      note: "Phoenix issued permit lookup failed safely. Keep separate from live map until tested."
    });
  }
}

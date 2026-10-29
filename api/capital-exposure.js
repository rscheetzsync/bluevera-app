
/**
 * BlueVera — 5-Year Capital Exposure (server-side, CommonJS / Vercel).
 * Deploy to bluevera.app/api/capital-exposure.js.
 * Formula extracted unchanged from full-report (44).html (Oct 29, 2026).
 *
 * CURRENT INTEGRATION BOUNDARY:
 * This endpoint returns the public-data AGE-BASED BASELINE only. It intentionally
 * does not accept client-supplied contributor claims as verified. Connect the
 * existing trusted homeowner/contractor/MLS records server-side before enabling
 * qualified updates. Do not publish baseline totals as updated/verified totals.
 *
 * POST JSON: { builtYear: 1950, sqft: 2258, permitCount: 4 }
 * GET query: ?builtYear=1950&sqft=2258&permitCount=4
 * Response: { ok, status, propertyFacts, capitalExposure, ... }
 */
'use strict';

function latestClaimFor(claims, systemKey){
  const matches = (claims || []).filter(c => c.system === systemKey);
  // Work year, not record insertion order, determines the newest upgrade.
  return matches.sort((a, b) => Number(b.year) - Number(a.year))[0] || null;
}

function claimProvidesDocs(claim){
  return !!(claim && (claim.hasReceipt || claim.hasPermit || claim.hasWarranty));
}

function isCapitalEligibleClaim(claim){
  if (!claim) return false;

  // Capital exposure keeps its original age-based baseline.
  // Only a DATED system update can adjust that baseline.
  const updateYear = Number.parseInt(String(claim.year || ""), 10);
  if (!Number.isFinite(updateYear) || updateYear < 1900 || updateYear > 2100) {
    return false;
  }

  return (
    claim.sourceType === "contractor" ||
    claim.sourceType === "homeowner" ||
    claim.sourceType === "listing" ||
    claim.listingFinding === true
  );
}

function optionalRangeFromClaim(originalRange, claim){
  if (!claim) return originalRange;

  if (claimProvidesDocs(claim)) {
    return [0, 0];
  }

  if (claim.recentWords || claim.year) {
    return [
      Math.round((originalRange[0] || 0) * 0.5),
      Math.round((originalRange[1] || 0) * 0.5)
    ];
  }

  return originalRange;
}

function buildCapitalPlan(builtYear, age, permitCount, sqft, claims){
  const sf = Number.isFinite(sqft) ? sqft : NaN;
  const bigHouse = Number.isFinite(sf) && sf >= 2200;

  // Permit count is intentionally excluded from 5-Year Capital Exposure.
  // Permit history remains a separate due-diligence/documentation signal.
  const lowPermits = false;

  const roofClaim = latestClaimFor(claims, "roof");
  const hvacClaim = latestClaimFor(claims, "hvac");
  const waterClaim = latestClaimFor(claims, "waterheater");
  const elecClaim = latestClaimFor(claims, "electrical");
  const plumbingClaim = latestClaimFor(claims, "plumbing");
  const sewerClaim = latestClaimFor(claims, "sewer");
  const windowsClaim = latestClaimFor(claims, "windows");
  const kitchenClaim = latestClaimFor(claims, "kitchen");
  const bathClaim = latestClaimFor(claims, "bathroom");
  const flooringClaim = latestClaimFor(claims, "flooring");
  const poolClaim = latestClaimFor(claims, "pool");
  const docsClaim = latestClaimFor(claims, "docs");

  const costs = {
    roof: bigHouse ? [14000, 32000] : [11000, 26000],
    hvac: bigHouse ? [7500, 15000] : [6000, 12000],
    waterHeater: [1200, 2800],
    electricalPanel: [3000, 9000],
    plumbingRepipe: [6500, 20000],
    sewerScopeFix: [6000, 25000],
    windows: bigHouse ? [8000, 28000] : [6000, 22000]
  };

  function rangeFlooring(sf){
    if (!Number.isFinite(sf)) return [3500, 16000];
    const low = Math.max(2500, sf * 2.5);
    const high = Math.max(7000, sf * 7.5);
    return [low, high];
  }

  function rangeInteriorPaint(sf){
    if (!Number.isFinite(sf)) return [2500, 9000];
    const low = Math.max(2000, sf * 1.25);
    const high = Math.max(4500, sf * 3.5);
    return [low, high];
  }

  function rangeKitchen(bigHouse){
    return bigHouse ? [18000, 65000] : [14000, 55000];
  }

  function rangeBathroom(count){
    return count >= 2 ? [12000, 45000] : [9000, 32000];
  }

  function rangeExteriorAllowance(bigHouse){
    return bigHouse ? [3500, 18000] : [2500, 15000];
  }

  function rangePoolInstall(){
    /* U.S. average installed in-ground pool range, rounded for planning. */
    return [44500, 87500];
  }

  const planCore = [];
  const planOptional = [];
  const yrs = age;

  function addCore(system, typical, status, range, why, verify){
    planCore.push({
      system,
      typical,
      status,
      low: range?.[0] ?? null,
      high: range?.[1] ?? null,
      why,
      verify,
      optional:false
    });
  }

  function addOptional(system, typical, range, why, verify){
    let status = "opt";

    if (Number(range?.[0]) === 0 && Number(range?.[1]) === 0) {
      status = "verified";
    } else if (why && String(why).toLowerCase().includes("adjusted by ask bluevera claim")) {
      status = "updated";
    }

    planOptional.push({
      system,
      typical,
      status,
      low: range?.[0] ?? null,
      high: range?.[1] ?? null,
      why,
      verify,
      optional:true
    });
  }

  function adjustStatusFromClaim(baseStatus, claim, recentThresholdYears, mediumIfClaimOnly = true){
    if (!claim) return baseStatus;

    const updateYear = Number.parseInt(String(claim.year || ""), 10);
    if (!Number.isFinite(updateYear) || updateYear < 1900 || updateYear > 2100) {
      return baseStatus;
    }

    if (claimProvidesDocs(claim)) return "documented";
    return "claim";
  }

  function rangeFromClaim(originalRange, claim, documentedRange, claimedRange){
    if (!claim) return originalRange;

    const updateYear = Number.parseInt(String(claim.year || ""), 10);
    if (!Number.isFinite(updateYear) || updateYear < 1900 || updateYear > 2100) {
      return originalRange;
    }

    if (claimProvidesDocs(claim)) return documentedRange || [0, 2500];
    return claimedRange || documentedRange || originalRange;
  }

  function appendWhy(baseWhy, claim){
    if (!claim) return baseWhy;
    return `${baseWhy} Adjusted by Ask BlueVera claim: ${claim.raw}`;
  }

  let roofStatus = "unknown";
  if (yrs !== null){
    if (yrs >= 25) roofStatus = "med";
    if (yrs >= 35) roofStatus = "high";
  }
  roofStatus = adjustStatusFromClaim(roofStatus, roofClaim, 15);

  addCore(
    "Roof",
    "15–25 yrs",
    roofStatus,
    rangeFromClaim(costs.roof, roofClaim, [0, 2500], [0, 3500]),
    appendWhy(
      lowPermits && yrs !== null && yrs >= 40
        ? "Older home + limited permit history increases verification importance."
        : "Age-driven lifecycle screening.",
      roofClaim
    ),
    roofClaim
      ? "Verify replacement year, invoice, material, warranty, and permit/final if applicable."
      : "Replacement year, material, warranty, attic ventilation, permit/final if replaced."
  );

  let hvacStatus = "unknown";
  if (yrs !== null){
    if (yrs >= 18) hvacStatus = "med";
    if (yrs >= 25) hvacStatus = "high";
  }
  hvacStatus = adjustStatusFromClaim(hvacStatus, hvacClaim, 8);

  addCore(
    "HVAC",
    "12–18 yrs",
    hvacStatus,
    rangeFromClaim(costs.hvac, hvacClaim, [0, 1500], [0, 2500]),
    appendWhy(
      lowPermits && yrs !== null && yrs >= 40
        ? "Limited documentation → verify install date and service history."
        : "Age-driven lifecycle screening.",
      hvacClaim
    ),
    hvacClaim
      ? "Verify install date, invoice, serial/model photo, service records, and permit/final if applicable."
      : "Serial/installation year, service records, duct condition, insulation/returns."
  );

  let whStatus = "unknown";
  if (yrs !== null){
    if (yrs >= 12) whStatus = "med";
    if (yrs >= 18) whStatus = "high";
  }
  whStatus = adjustStatusFromClaim(whStatus, waterClaim);

  addCore(
    "Water Heater",
    "8–12 yrs",
    whStatus,
    rangeFromClaim(costs.waterHeater, waterClaim, [0, 500], [0, 750]),
    appendWhy("Common high-turn item; verify install date.", waterClaim),
    waterClaim
      ? "Verify install date, receipt, label photo, and permit if required."
      : "Install date/label, venting, expansion tank, pan/drain, permit if replaced."
  );

  let elecStatus = "unknown";
  if (yrs !== null){
    if (yrs >= 40) elecStatus = "med";
    if (yrs >= 60) elecStatus = "high";
  }
  elecStatus = adjustStatusFromClaim(elecStatus, elecClaim);

  addCore(
    "Electrical / Panel",
    "30–50 yrs",
    elecStatus,
    rangeFromClaim(costs.electricalPanel, elecClaim, [0, 1500], [0, 3000]),
    appendWhy(
      lowPermits && yrs !== null && yrs >= 40
        ? "Older era often needs upgrades; limited permits → verify workmanship."
        : "Era-driven verification item.",
      elecClaim
    ),
    elecClaim
      ? "Verify panel type, amps, invoice, and permit/final if upgraded."
      : "Panel type/amps, grounding/bonding, aluminum wiring (if applicable), GFCI/AFCI where required."
  );

  let plumbStatus = "unknown";
  if (yrs !== null){
    if (yrs >= 45) plumbStatus = "med";
    if (yrs >= 70) plumbStatus = "high";
  }
  plumbStatus = adjustStatusFromClaim(plumbStatus, plumbingClaim);

  addCore(
    "Plumbing (Supply/Drain)",
    "40–70 yrs",
    plumbStatus,
    rangeFromClaim(costs.plumbingRepipe, plumbingClaim, [0, 3000], [0, 5000]),
    appendWhy(
      lowPermits && yrs !== null && yrs >= 50
        ? "Limited documentation → verify what’s original vs replaced."
        : "Older materials may persist in segments.",
      plumbingClaim
    ),
    plumbingClaim
      ? "Verify full vs partial repipe, material used, invoice, and permit if applicable."
      : "Supply line material (galv/copper/PEX), drain material (cast iron/ABS), leak history, water pressure."
  );

  let sewerStatus = "unknown";
  if (yrs !== null){
    if (yrs >= 45) sewerStatus = "med";
    if (yrs >= 70) sewerStatus = "high";
  }

  if (sewerClaim && sewerClaim.recentWords) {
    sewerStatus = adjustStatusFromClaim(sewerStatus, sewerClaim);
  }

  addCore(
    "Sewer Line (Scope/Reserve)",
    "Varies",
    sewerStatus,
    rangeFromClaim(costs.sewerScopeFix, sewerClaim, [0, 2500], [0, 4000]),
    plumbingClaim
      ? "Plumbing update claimed; verify whether sewer line scope/replacement was included."
      : (
          yrs !== null && yrs >= 40
            ? "Older homes benefit from a sewer scope; reserve if issues found."
            : "Optional unless symptoms exist."
        ),
    "Order a sewer scope; confirm line material, roots, offsets, belly, prior repairs."
  );

  // Windows / Envelope is optional unless a separately documented
  // defect requires repair. Age alone does not trigger core exposure.
  addOptional(
    "Windows / Envelope (Optional improvement)",
    "Varies",
    rangeFromClaim(costs.windows, windowsClaim, [0, 2000], [0, 3000]),
    appendWhy(
      "Optional comfort/efficiency upgrade. Age alone does not mean windows require replacement within five years; damaged, unsafe, or leaking windows should be assessed separately.",
      windowsClaim
    ),
    windowsClaim
      ? "Verify invoice, installation year, and window brand/type; evaluate any actual defects."
      : "Inspect operation, glazing, drafts, water intrusion, frames, historic-preservation requirements, and condition before planning replacement."
  );

  const olderHome = (yrs !== null && yrs >= 25);

  let kitchenRange = rangeKitchen(bigHouse);
  if (kitchenClaim && (kitchenClaim.recentWords || kitchenClaim.year)) {
    kitchenRange = [0, 0];
  }

  addOptional(
    "Kitchen (Optional improvement)",
    "Varies",
    kitchenRange,
    kitchenClaim
      ? `Adjusted by Ask BlueVera claim: ${kitchenClaim.raw}`
      : (
          olderHome
            ? "Common upgrade on older homes if not previously updated."
            : "Optional improvement depending on finishes/condition."
        ),
    kitchenClaim
      ? "Verify what was actually updated: cosmetic only, or plumbing/electrical/layout too."
      : "Ask seller for remodel year, scope, receipts; verify any plumbing/electrical changes were permitted and finaled."
  );

  let bathRange = rangeBathroom(2);
  if (bathClaim && (bathClaim.recentWords || bathClaim.year)) {
    bathRange = [0, 0];
  }

  addOptional(
    "Bathrooms (Optional improvement)",
    "Varies",
    bathRange,
    bathClaim
      ? `Adjusted by Ask BlueVera claim: ${bathClaim.raw}`
      : (
          olderHome
            ? "Common upgrade on older homes if finishes are original or worn."
            : "Optional improvement depending on finishes/condition."
        ),
    bathClaim
      ? "Verify scope, waterproofing, ventilation, plumbing work, and any permit history."
      : "Verify shower pan/waterproofing, ventilation, plumbing fixtures, and any permit history if walls were opened."
  );

  let flooringRange = rangeFlooring(sf);
  if (flooringClaim && (flooringClaim.recentWords || flooringClaim.year)) {
    flooringRange = [0, 0];
  }

  addOptional(
    "Flooring (Optional improvement)",
    "Varies",
    flooringRange,
    flooringClaim
      ? `Adjusted by Ask BlueVera claim: ${flooringClaim.raw}`
      : "Often replaced after purchase based on wear or buyer preference (cost scales with square footage).",
    flooringClaim
      ? "Verify material, installation quality, moisture issues, subfloor condition, and whether flooring was part of a larger remodel."
      : "Confirm subfloor condition, moisture issues, and material type/installation."
  );

  addOptional(
    "Interior Paint (Optional improvement)",
    "Varies",
    rangeInteriorPaint(sf),
    "Common post-close refresh depending on condition and preference (scales with square footage).",
    "Check for repairs needed (cracks, water stains) before repaint."
  );

  addOptional(
    "Exterior / Site allowance (Optional)",
    "Varies",
    rangeExteriorAllowance(bigHouse),
    "Covers typical exterior refresh items (landscape/irrigation, fence, minor stucco/trim, grading/drainage touch-ups).",
    "Walk exterior for drainage, cracking, irrigation leaks; check roof drainage/downspouts and lot grading."
  );

  let poolInstallRange = rangePoolInstall();
  if (poolClaim && (poolClaim.recentWords || poolClaim.year)) {
    poolInstallRange = [0, 0];
  }

  addOptional(
    "Pool / Spa Installation (Optional)",
    "Varies",
    poolInstallRange,
    poolClaim
      ? `Pool / spa mentioned in property history or listing remarks: ${poolClaim.raw}. Verify whether this is an existing pool/spa, recent remodel, or equipment update before applying installation value.`
      : "Optional lifestyle improvement. Uses a U.S. average installed in-ground pool planning range; local Phoenix pricing, access, decking, electrical, equipment, fencing, and finish level can materially change the final cost.",
    poolClaim
      ? "Verify original pool permit, remodel permits, equipment age, surface age, leaks, electrical bonding, safety barriers, and maintenance records."
      : "Get local pool contractor bids; verify zoning/setbacks, permits, electrical, barriers/fencing, drainage, access, decking, and equipment scope."
  );

  let totalLow = 0;
  let totalHigh = 0;

  planCore.forEach(p => {
    const include = (
      p.status === "high" ||
      p.status === "med" ||
      p.status === "claim" ||
      p.status === "documented"
    );

    if (!include) return;

    totalLow += (p.low || 0);
    totalHigh += (p.high || 0);
  });

  let reserveLow = 0;
  let reserveHigh = 0;

  if (lowPermits) {
    reserveLow = 2500;
    reserveHigh = 12000;
  }

  const docsMentioned =
    (claims || []).some(c => claimProvidesDocs(c)) || !!docsClaim;

  if (docsMentioned && reserveLow > 0) {
    reserveLow = Math.round(reserveLow * 0.6);
    reserveHigh = Math.round(reserveHigh * 0.65);
  }

  totalLow += reserveLow;
  totalHigh += reserveHigh;

  let optLow = 0;
  let optHigh = 0;

  planOptional.forEach(p => {
    optLow += (p.low || 0);
    optHigh += (p.high || 0);
  });

  return {
    planCore,
    planOptional,
    totalLow,
    totalHigh,
    reserveLow,
    reserveHigh,
    lowPermits,
    optLow,
    optHigh
  };
}

function parseNumber(value, min, max, integer) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;

  if (
    typeof value === 'string' &&
    !/^\d+(?:\.\d+)?$/.test(value.trim())
  ) return null;

  const n = Number(value);

  if (
    !Number.isFinite(n) ||
    n < min ||
    n > max ||
    (integer && !Number.isInteger(n))
  ) return null;

  return n;
}

const ALLOWED_ORIGINS = new Set([
  'https://bluevera.org',
  'https://www.bluevera.org',
  'https://bluevera.app',
  'https://www.bluevera.app'
]);

// Server-side history retrieval. Fixed URL; never accept a caller-supplied URL.
// Property ID must resolve to exactly the requested property.
const HISTORY_SERVICE = 'https://www.bluevera.app';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getValue(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (
      value !== undefined &&
      value !== null &&
      String(value).trim()
    ) return value;
  }
  return '';
}

function systemFromRecord(record) {
  const text = String(
    getValue(record, ['system', 'category', 'title'])
  ).toLowerCase();

  if (/sewer/.test(text)) return 'sewer';
  if (/water\s*heater|tankless/.test(text)) return 'waterheater';
  if (/hvac|air\s*condition|heat\s*pump|furnace/.test(text)) return 'hvac';
  if (/roof/.test(text)) return 'roof';
  if (/electric|panel/.test(text)) return 'electrical';
  if (/plumb|repipe|supply\s*line/.test(text)) return 'plumbing';

  return null;
}

function recordWorkYear(record, builtYear) {
  // Public history "year" is explicit event_year. It may be null even if the
  // original work date is clearly documented in the description.
  const direct = String(record?.year ?? '').trim();

  let year = /^\d{4}$/.test(direct) ? Number(direct) : null;

  const summary = String(record?.summary || '');
  const date = String(record?.date || '');

  if (
    year == null &&
    /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+20\d{2}$/i.test(date)
  ) {
    year = Number(date.match(/20\d{2}/)[0]);
  }

  // Conservative: only an explicit work/completion or installation year;
  // do not use createdAt/updatedAt (upload timestamps).
  if (year == null) {
    const match = summary.match(
      /\b(?:installed|replaced|replacement|completed|upgraded|repiped|repaired|renewed|in|during)\s+(?:in\s+)?(?:[A-Za-z]+\s+)?(19\d{2}|20\d{2})\b/i
    );

    if (match) year = Number(match[1]);
  }

  if (
    !Number.isInteger(year) ||
    year < Math.max(1900, Number(builtYear) || 1900) ||
    year > new Date().getFullYear()
  ) return null;

  return year;
}

function qualifyingWork(system, summary) {
  const text = String(summary || '').toLowerCase();

  // A maintenance visit, small repair, or component service is not full-system renewal.
  if (
    /\b(service|serviced|flushed|descaled|inspected|inspection|tuned|cleaned|patched|resealed)\b/.test(text)
  ) return false;

  if (system === 'roof') {
    if (
      /\b(repair|repaired|patch|leak|slope|section|partial)\b/.test(text) &&
      !/\b(full|entire|complete)\s+roof\s+(?:replaced|replacement)/.test(text)
    ) return false;

    return /\b(replaced|replacement|new roof|reroof|re-roof)\b/.test(text);
  }

  if (system === 'hvac') {
    return /\b(replaced|replacement|installed|new hvac|new a\/c|new air conditioner)\b/.test(text);
  }

  if (system === 'waterheater') {
    return /\b(replaced|replacement|installed|new water heater|new tankless)\b/.test(text);
  }

  if (system === 'electrical') {
    return (
      /\b(panel|service panel|breaker panel)\b/.test(text) &&
      /\b(replaced|replacement|installed|upgraded|new)\b/.test(text)
    );
  }

  if (system === 'sewer') {
    return (
      /\b(sewer)\b/.test(text) &&
      /\b(replaced|replacement|relined|new sewer)\b/.test(text)
    );
  }

  if (system === 'plumbing') {
    return /\b(repipe|repiped|re-pipe|replaced supply|replaced drain|full plumbing replacement)\b/.test(text);
  }

  return false;
}

function claimFromTrustedRecord(record, sourceType, builtYear) {
  const system = systemFromRecord(record);
  if (!system) return null;

  const status = String(record?.verificationStatus || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ');

  // Documented means the property history was documented; the public endpoint
  // does not expose a validated receipt/permit, so do not set proof flags.
  if (
    ![
      'verified',
      'approved',
      'verified by homeowner',
      'owner verified',
      'documented'
    ].includes(status)
  ) return null;

  const summary = String(record?.summary || '');

  if (!qualifyingWork(system, summary)) return null;

  const year = recordWorkYear(record, builtYear);
  if (!year) return null;

  return {
    system,
    year,
    sourceType,
    raw: summary.slice(0, 300),
    recentWords: true,
    hasReceipt: false,
    hasPermit: false,
    hasWarranty: false
  };
}

async function readTrustedHistory(propertyId) {
  if (!UUID_RE.test(propertyId)) {
    throw new Error('Invalid canonical propertyId (UUID required)');
  }

  const url =
    HISTORY_SERVICE +
    '/api/public-property-history?propertyId=' +
    encodeURIComponent(propertyId);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6500);

  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error('Public property history HTTP ' + response.status);
    }

    const result = await response.json();

    if (
      result?.success !== true ||
      String(result?.property?.id || '').toLowerCase() !== propertyId.toLowerCase()
    ) {
      throw new Error('Property identity mismatch or invalid history response');
    }

    const records = [
      ...(
        Array.isArray(result.homeownerUpdates)
          ? result.homeownerUpdates.map(r => [r, 'homeowner'])
          : []
      ),
      ...(
        Array.isArray(result.contractorRecords)
          ? result.contractorRecords.map(r => [r, 'contractor'])
          : []
      )
    ];

    return {
      property: result.property,
      records: records
        .map(([r, type]) =>
          claimFromTrustedRecord(
            r,
            type,
            Number(result.property.year_built || 0)
          )
        )
        .filter(Boolean)
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function handler(req, res) {
  const origin = String(req.headers?.origin || '');

  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  }

  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return res.status(403).json({
      ok: false,
      error: 'Origin not allowed'
    });
  }

  try {
    const payload = req.method === 'GET'
      ? (req.query || {})
      : (req.body || {});

    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload)
    ) {
      return res.status(400).json({
        ok: false,
        error: 'Expected a JSON object'
      });
    }

    let year = parseNumber(
      payload.builtYear ?? payload.yearBuilt,
      1701,
      new Date().getFullYear(),
      true
    );

    let sqft = parseNumber(
      payload.sqft ?? payload.livingSqft,
      1,
      100000,
      false
    );

    const permits = payload.permitCount == null
      ? 0
      : parseNumber(payload.permitCount, 0, 100000, true);

    if (permits === null) {
      return res.status(400).json({
        ok: false,
        error: 'Valid builtYear and sqft required; permitCount optional'
      });
    }

    const propertyId = typeof payload.propertyId === 'string'
      ? payload.propertyId.trim()
      : '';

    let claims = [];
    let historyStatus = propertyId ? 'unavailable' : 'not_requested';

    if (propertyId) {
      try {
        const history = await readTrustedHistory(propertyId);
        historyStatus = 'loaded';

        // Prefer authoritative year and square footage whenever property ID is supplied.
        // Do not silently replace an invalid authoritative value with client input.
        year = parseNumber(
          history.property.year_built,
          1701,
          new Date().getFullYear(),
          true
        );

        sqft = parseNumber(
          history.property.living_sqft,
          1,
          100000,
          false
        );

        claims = history.records;
      } catch (error) {
        console.warn(
          '[BlueVera Capital Exposure] history unavailable:',
          error.message
        );
      }
    }

    if (year === null || sqft === null) {
      return res.status(400).json({
        ok: false,
        error: 'Valid yearBuilt and sqft required; authoritative property facts are missing or invalid'
      });
    }

    const age = new Date().getFullYear() - year;
    const plan = buildCapitalPlan(
      year,
      age,
      permits,
      sqft,
      claims
    );

    return res.status(200).json({
      ok: true,
      status: claims.length
        ? 'trusted_records_applied'
        : 'baseline_only',
      historyStatus,
      appliedRecordCount: claims.length,
      version: '2026-10-29-server-v4-dated-work',
      propertyFacts: {
        builtYear: year,
        age,
        sqft,
        permitCount: permits
      },
      capitalExposure: plan,
      warning: historyStatus === 'unavailable'
        ? 'Contributor history unavailable; age-based fallback shown. Property facts may be client supplied and must not be represented as verified.'
        : 'Only documented/verified dated full-system work applied; repair/service records excluded. Public history does not certify receipts. Dated ARMLS integration pending.'
    });
  } catch (err) {
    console.error(
      '[BlueVera Capital Exposure] computation error:',
      err
    );

    return res.status(500).json({
      ok: false,
      error: 'Capital Exposure temporarily unavailable'
    });
  }
}

module.exports = handler;

// For local testing only; not part of the HTTP response.
module.exports._buildCapitalPlan = buildCapitalPlan;

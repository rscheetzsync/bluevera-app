
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
  const filtered = (claims || []).filter(c => c.system === systemKey);
  return filtered.length ? filtered[filtered.length - 1] : null;
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
    appendWhy(lowPermits && yrs !== null && yrs >= 40
      ? "Older home + limited permit history increases verification importance."
      : "Age-driven lifecycle screening.", roofClaim),
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
    appendWhy(lowPermits && yrs !== null && yrs >= 40
      ? "Limited documentation → verify install date and service history."
      : "Age-driven lifecycle screening.", hvacClaim),
    hvacClaim
      ? "Verify install date, invoice, serial/model photo, service records, and permit/final if applicable."
      : "Serial/installation year, service records, duct condition, insulation/returns."
  );

  let whStatus = "unknown";
  if (yrs !== null){
    if (yrs >= 12) whStatus = "med";
    if (yrs >= 18) whStatus = "high";
  }
  whStatus = adjustStatusFromClaim(whStatus, waterClaim, 6);

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
  elecStatus = adjustStatusFromClaim(elecStatus, elecClaim, 18);

  addCore(
    "Electrical / Panel",
    "30–50 yrs",
    elecStatus,
    rangeFromClaim(costs.electricalPanel, elecClaim, [0, 1500], [0, 3000]),
    appendWhy(lowPermits && yrs !== null && yrs >= 40
      ? "Older era often needs upgrades; limited permits → verify workmanship."
      : "Era-driven verification item.", elecClaim),
    elecClaim
      ? "Verify panel type, amps, invoice, and permit/final if upgraded."
      : "Panel type/amps, grounding/bonding, aluminum wiring (if applicable), GFCI/AFCI where required."
  );

  let plumbStatus = "unknown";
  if (yrs !== null){
    if (yrs >= 45) plumbStatus = "med";
    if (yrs >= 70) plumbStatus = "high";
  }
  plumbStatus = adjustStatusFromClaim(plumbStatus, plumbingClaim, 20);

  addCore(
    "Plumbing (Supply/Drain)",
    "40–70 yrs",
    plumbStatus,
    rangeFromClaim(costs.plumbingRepipe, plumbingClaim, [0, 3000], [0, 5000]),
    appendWhy(lowPermits && yrs !== null && yrs >= 50
      ? "Limited documentation → verify what’s original vs replaced."
      : "Older materials may persist in segments.", plumbingClaim),
    plumbingClaim
      ? "Verify full vs partial repipe, material used, invoice, and permit if applicable."
      : "Supply line material (galv/copper/PEX), drain material (cast iron/ABS), leak history, water pressure."
  );

  let sewerStatus = "unknown";
  if (yrs !== null){
    if (yrs >= 45) sewerStatus = "med";
    if (yrs >= 70) sewerStatus = "high";
  }
  if (plumbingClaim && plumbingClaim.recentWords) sewerStatus = adjustStatusFromClaim(sewerStatus, plumbingClaim, 20);

  addCore(
    "Sewer Line (Scope/Reserve)",
    "Varies",
    sewerStatus,
    rangeFromClaim(costs.sewerScopeFix, plumbingClaim, [0, 2500], [0, 4000]),
    plumbingClaim
      ? "Plumbing update claimed; verify whether sewer line scope/replacement was included."
      : (yrs !== null && yrs >= 40 ? "Older homes benefit from a sewer scope; reserve if issues found." : "Optional unless symptoms exist."),
    "Order a sewer scope; confirm line material, roots, offsets, belly, prior repairs."
  );

  // Windows / Envelope is optional unless a separately documented
  // defect requires repair. Age alone does not trigger core exposure.
  addOptional(
    "Windows / Envelope (Optional improvement)",
    "Varies",
    rangeFromClaim(costs.windows, windowsClaim, [0, 2000], [0, 3000]),
    appendWhy("Optional comfort/efficiency upgrade. Age alone does not mean windows require replacement within five years; damaged, unsafe, or leaking windows should be assessed separately.", windowsClaim),
    windowsClaim
      ? "Verify invoice, installation year, and window brand/type; evaluate any actual defects."
      : "Inspect operation, glazing, drafts, water intrusion, frames, historic-preservation requirements, and condition before planning replacement."
  );

  const olderHome = (yrs !== null && yrs >= 25);

  let kitchenRange = rangeKitchen(bigHouse);
  if (kitchenClaim && (kitchenClaim.recentWords || kitchenClaim.year)) kitchenRange = [0, 0];

  addOptional(
    "Kitchen (Optional improvement)",
    "Varies",
    kitchenRange,
    kitchenClaim
      ? `Adjusted by Ask BlueVera claim: ${kitchenClaim.raw}`
      : (olderHome ? "Common upgrade on older homes if not previously updated." : "Optional improvement depending on finishes/condition."),
    kitchenClaim
      ? "Verify what was actually updated: cosmetic only, or plumbing/electrical/layout too."
      : "Ask seller for remodel year, scope, receipts; verify any plumbing/electrical changes were permitted and finaled."
  );

  let bathRange = rangeBathroom(2);
  if (bathClaim && (bathClaim.recentWords || bathClaim.year)) bathRange = [0, 0];

  addOptional(
    "Bathrooms (Optional improvement)",
    "Varies",
    bathRange,
    bathClaim
      ? `Adjusted by Ask BlueVera claim: ${bathClaim.raw}`
      : (olderHome ? "Common upgrade on older homes if finishes are original or worn." : "Optional improvement depending on finishes/condition."),
    bathClaim
      ? "Verify scope, waterproofing, ventilation, plumbing work, and any permit history."
      : "Verify shower pan/waterproofing, ventilation, plumbing fixtures, and any permit history if walls were opened."
  );

  let flooringRange = rangeFlooring(sf);
  if (flooringClaim && (flooringClaim.recentWords || flooringClaim.year)) flooringRange = [0, 0];

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
  if (poolClaim && (poolClaim.recentWords || poolClaim.year)) poolInstallRange = [0, 0];

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
    const include = (p.status === "high" || p.status === "med" || p.status === "claim" || p.status === "documented");
    if (!include) return;
    totalLow += (p.low || 0);
    totalHigh += (p.high || 0);
  });

  let reserveLow = 0;
  let reserveHigh = 0;

  if (lowPermits){
    reserveLow = 2500;
    reserveHigh = 12000;
  }

  const docsMentioned = (claims || []).some(c => claimProvidesDocs(c)) || !!docsClaim;
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
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) return null;
  return n;
}

const ALLOWED_ORIGINS = new Set([
  'https://bluevera.org',
  'https://www.bluevera.org',
  'https://bluevera.app',
  'https://www.bluevera.app'
]);

function handler(req, res) {
  const origin = String(req.headers?.origin || '');
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return res.status(403).json({ ok: false, error: 'Origin not allowed' });
  }

  try {
    const payload = req.method === 'GET' ? (req.query || {}) : (req.body || {});

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({ ok: false, error: 'Expected a JSON object' });
    }

    const year = parseNumber(payload.builtYear ?? payload.yearBuilt, 1701, new Date().getFullYear(), true);
    const sqft = parseNumber(payload.sqft ?? payload.livingSqft, 1, 100000, false);
    const permits = payload.permitCount == null ? 0 : parseNumber(payload.permitCount, 0, 100000, true);

    if (year === null || sqft === null || permits === null) {
      return res.status(400).json({ ok: false, error: 'Valid builtYear and sqft required; permitCount optional' });
    }

    // This API must not trust sourceType, dates, or proof flags received from a browser.
    // Contributor records must instead be fetched and verified on the server.
    const age = new Date().getFullYear() - year;
    const plan = buildCapitalPlan(year, age, permits, sqft, []);

    return res.status(200).json({
      ok: true,
      status: 'baseline_only',
      version: '2026-10-29-server-v1',
      propertyFacts: { builtYear: year, age, sqft, permitCount: permits },
      capitalExposure: plan,
      warning: 'Age-based planning baseline only. Verified homeowner, contractor, and MLS updates are not yet integrated.'
    });

  } catch (err) {
    console.error('[BlueVera Capital Exposure] computation error:', err);
    return res.status(500).json({ ok: false, error: 'Capital Exposure temporarily unavailable' });
  }
}

module.exports = handler;

// For local testing only; not part of the HTTP response.
module.exports._buildCapitalPlan = buildCapitalPlan;

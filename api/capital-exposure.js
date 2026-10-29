
/**
 * BlueVera — 5-Year Capital Exposure
 * Server-side API for bluevera.app
 * Path: /api/capital-exposure.js
 *
 * Step 2: Retrieves trusted homeowner and contractor
 * property history from central-property-report.
 *
 * ARMLS structured update integration remains pending.
 * Unavailable history falls back to age-based estimates.
 */
'use strict';

function latestClaimFor(claims, systemKey) {
  const filtered = (claims || []).filter(c => c.system === systemKey);
  return filtered.length ? filtered[filtered.length - 1] : null;
}

function claimProvidesDocs(claim) {
  return !!(claim && (
    claim.hasReceipt || claim.hasPermit || claim.hasWarranty
  ));
}

function buildCapitalPlan(builtYear, age, permitCount, sqft, claims) {
  const sf = Number.isFinite(sqft) ? sqft : NaN;
  const bigHouse = Number.isFinite(sf) && sf >= 2200;
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

  function rangeFlooring(sf) {
    if (!Number.isFinite(sf)) return [3500, 16000];
    return [
      Math.max(2500, sf * 2.5),
      Math.max(7000, sf * 7.5)
    ];
  }

  function rangeInteriorPaint(sf) {
    if (!Number.isFinite(sf)) return [2500, 9000];
    return [
      Math.max(2000, sf * 1.25),
      Math.max(4500, sf * 3.5)
    ];
  }

  function rangeKitchen(bigHouse) {
    return bigHouse ? [18000, 65000] : [14000, 55000];
  }

  function rangeBathroom(count) {
    return count >= 2 ? [12000, 45000] : [9000, 32000];
  }

  function rangeExteriorAllowance(bigHouse) {
    return bigHouse ? [3500, 18000] : [2500, 15000];
  }

  function rangePoolInstall() {
    return [44500, 87500];
  }

  const planCore = [];
  const planOptional = [];
  const yrs = age;

  function addCore(system, typical, status, range, why, verify) {
    planCore.push({
      system,
      typical,
      status,
      low: range?.[0] ?? null,
      high: range?.[1] ?? null,
      why,
      verify,
      optional: false
    });
  }

  function addOptional(system, typical, range, why, verify) {
    let status = "opt";

    if (Number(range?.[0]) === 0 &&
        Number(range?.[1]) === 0) {
      status = "verified";
    } else if (
      why &&
      String(why).toLowerCase().includes(
        "adjusted by ask bluevera claim"
      )
    ) {
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
      optional: true
    });
  }

  function adjustStatusFromClaim(baseStatus, claim) {
    if (!claim) return baseStatus;

    const updateYear = Number.parseInt(
      String(claim.year || ""), 10
    );

    if (!Number.isFinite(updateYear) ||
        updateYear < 1900 ||
        updateYear > 2100) {
      return baseStatus;
    }

    if (claimProvidesDocs(claim)) return "documented";
    return "claim";
  }

  function rangeFromClaim(
    originalRange,
    claim,
    documentedRange,
    claimedRange
  ) {
    if (!claim) return originalRange;

    const updateYear = Number.parseInt(
      String(claim.year || ""), 10
    );

    if (!Number.isFinite(updateYear) ||
        updateYear < 1900 ||
        updateYear > 2100) {
      return originalRange;
    }

    if (claimProvidesDocs(claim)) {
      return documentedRange || [0, 2500];
    }

    return claimedRange || documentedRange || originalRange;
  }

  function appendWhy(baseWhy, claim) {
    if (!claim) return baseWhy;
    return `${baseWhy} Adjusted by Ask BlueVera claim: ${claim.raw}`;
  }

  let roofStatus = "unknown";
  if (yrs !== null) {
    if (yrs >= 25) roofStatus = "med";
    if (yrs >= 35) roofStatus = "high";
  }
  roofStatus = adjustStatusFromClaim(roofStatus, roofClaim);

  addCore(
    "Roof",
    "15–25 yrs",
    roofStatus,
    rangeFromClaim(costs.roof, roofClaim, [0, 2500], [0, 3500]),
    appendWhy("Age-driven lifecycle screening.", roofClaim),
    roofClaim
      ? "Verify replacement year, invoice, material, warranty, and permit/final if applicable."
      : "Replacement year, material, warranty, attic ventilation, permit/final if replaced."
  );

  let hvacStatus = "unknown";
  if (yrs !== null) {
    if (yrs >= 18) hvacStatus = "med";
    if (yrs >= 25) hvacStatus = "high";
  }
  hvacStatus = adjustStatusFromClaim(hvacStatus, hvacClaim);

  addCore(
    "HVAC",
    "12–18 yrs",
    hvacStatus,
    rangeFromClaim(costs.hvac, hvacClaim, [0, 1500], [0, 2500]),
    appendWhy("Age-driven lifecycle screening.", hvacClaim),
    hvacClaim
      ? "Verify install date, invoice, serial/model photo, service records, and permit/final if applicable."
      : "Serial/installation year, service records, duct condition, insulation/returns."
  );

  let whStatus = "unknown";
  if (yrs !== null) {
    if (yrs >= 12) whStatus = "med";
    if (yrs >= 18) whStatus = "high";
  }
  whStatus = adjustStatusFromClaim(whStatus, waterClaim);

  addCore(
    "Water Heater",
    "8–12 yrs",
    whStatus,
    rangeFromClaim(costs.waterHeater, waterClaim, [0, 500], [0, 750]),
    appendWhy(
      "Common high-turn item; verify install date.",
      waterClaim
    ),
    waterClaim
      ? "Verify install date, receipt, label photo, and permit if required."
      : "Install date/label, venting, expansion tank, pan/drain, permit if replaced."
  );

  let elecStatus = "unknown";
  if (yrs !== null) {
    if (yrs >= 40) elecStatus = "med";
    if (yrs >= 60) elecStatus = "high";
  }
  elecStatus = adjustStatusFromClaim(elecStatus, elecClaim);

  addCore(
    "Electrical / Panel",
    "30–50 yrs",
    elecStatus,
    rangeFromClaim(
      costs.electricalPanel,
      elecClaim,
      [0, 1500],
      [0, 3000]
    ),
    appendWhy("Era-driven verification item.", elecClaim),
    elecClaim
      ? "Verify panel type, amps, invoice, and permit/final if upgraded."
      : "Panel type/amps, grounding/bonding, aluminum wiring (if applicable), GFCI/AFCI where required."
  );

  let plumbStatus = "unknown";
  if (yrs !== null) {
    if (yrs >= 45) plumbStatus = "med";
    if (yrs >= 70) plumbStatus = "high";
  }
  plumbStatus = adjustStatusFromClaim(
    plumbStatus, plumbingClaim
  );

  addCore(
    "Plumbing (Supply/Drain)",
    "40–70 yrs",
    plumbStatus,
    rangeFromClaim(
      costs.plumbingRepipe,
      plumbingClaim,
      [0, 3000],
      [0, 5000]
    ),
    appendWhy(
      "Older materials may persist in segments.",
      plumbingClaim
    ),
    plumbingClaim
      ? "Verify full vs partial repipe, material used, invoice, and permit if applicable."
      : "Supply line material (galv/copper/PEX), drain material (cast iron/ABS), leak history, water pressure."
  );

  let sewerStatus = "unknown";
  if (yrs !== null) {
    if (yrs >= 45) sewerStatus = "med";
    if (yrs >= 70) sewerStatus = "high";
  }

  if (sewerClaim && sewerClaim.recentWords) {
    sewerStatus = adjustStatusFromClaim(
      sewerStatus, sewerClaim
    );
  }

  addCore(
    "Sewer Line (Scope/Reserve)",
    "Varies",
    sewerStatus,
    rangeFromClaim(
      costs.sewerScopeFix,
      sewerClaim,
      [0, 2500],
      [0, 4000]
    ),
    plumbingClaim
      ? "Plumbing update claimed; verify whether sewer line scope/replacement was included."
      : (
          yrs !== null && yrs >= 40
            ? "Older homes benefit from a sewer scope; reserve if issues found."
            : "Optional unless symptoms exist."
        ),
    "Order a sewer scope; confirm line material, roots, offsets, belly, prior repairs."
  );

  addOptional(
    "Windows / Envelope (Optional improvement)",
    "Varies",
    rangeFromClaim(
      costs.windows,
      windowsClaim,
      [0, 2000],
      [0, 3000]
    ),
    appendWhy(
      "Optional comfort/efficiency upgrade. Age alone does not mean windows require replacement within five years; damaged, unsafe, or leaking windows should be assessed separately.",
      windowsClaim
    ),
    windowsClaim
      ? "Verify invoice, installation year, and window brand/type; evaluate any actual defects."
      : "Inspect operation, glazing, drafts, water intrusion, frames, historic-preservation requirements, and condition before planning replacement."
  );

  const olderHome = yrs !== null && yrs >= 25;

  let kitchenRange = rangeKitchen(bigHouse);
  if (kitchenClaim &&
      (kitchenClaim.recentWords || kitchenClaim.year)) {
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
  if (bathClaim &&
      (bathClaim.recentWords || bathClaim.year)) {
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
  if (flooringClaim &&
      (flooringClaim.recentWords || flooringClaim.year)) {
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
  if (poolClaim &&
      (poolClaim.recentWords || poolClaim.year)) {
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
    const include = [
      "high",
      "med",
      "claim",
      "documented"
    ].includes(p.status);

    if (!include) return;

    totalLow += p.low || 0;
    totalHigh += p.high || 0;
  });

  let reserveLow = 0;
  let reserveHigh = 0;

  if (lowPermits) {
    reserveLow = 2500;
    reserveHigh = 12000;
  }

  const docsMentioned =
    (claims || []).some(c => claimProvidesDocs(c)) ||
    !!docsClaim;

  if (docsMentioned && reserveLow > 0) {
    reserveLow = Math.round(reserveLow * 0.6);
    reserveHigh = Math.round(reserveHigh * 0.65);
  }

  totalLow += reserveLow;
  totalHigh += reserveHigh;

  let optLow = 0;
  let optHigh = 0;

  planOptional.forEach(p => {
    optLow += p.low || 0;
    optHigh += p.high || 0;
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
  if (
    typeof value !== "number" &&
    typeof value !== "string"
  ) {
    return null;
  }

  if (
    typeof value === "string" &&
    !/^\d+(?:\.\d+)?$/.test(value.trim())
  ) {
    return null;
  }

  const n = Number(value);

  if (
    !Number.isFinite(n) ||
    n < min ||
    n > max ||
    (integer && !Number.isInteger(n))
  ) {
    return null;
  }

  return n;
}

const ALLOWED_ORIGINS = new Set([
  "https://bluevera.org",
  "https://www.bluevera.org",
  "https://bluevera.app",
  "https://www.bluevera.app"
]);

const HISTORY_SERVICE = "https://bluevera.app";

function getValue(record, keys) {
  for (const key of keys) {
    const value = record?.[key];

    if (
      value !== undefined &&
      value !== null &&
      String(value).trim()
    ) {
      return value;
    }
  }

  return "";
}

function systemFromRecord(record) {
  const str =
    String(getValue(record, [
      "system_name",
      "systemName",
      "itemLabel",
      "item_label",
      "workType",
      "work_type",
      "type",
      "update_type",
      "category",
      "title",
      "system"
    ])) +
    " " +
    String(getValue(record, [
      "description",
      "summary",
      "notes",
      "note",
      "raw_text",
      "update_scope",
      "updateScope",
      "scope"
    ]));

  const t = str.toLowerCase();

  if (/hvac|a\/c|air conditioner|furnace/.test(t)) {
    return "hvac";
  }
  if (/roof/.test(t)) return "roof";
  if (/water heater|waterheater/.test(t)) {
    return "waterheater";
  }
  if (/electric|panel|breaker|rewire|wiring/.test(t)) {
    return "electrical";
  }
  if (/plumb|repipe/.test(t)) return "plumbing";
  if (/sewer|drain line/.test(t)) return "sewer";

  return null;
}

function claimFromTrustedRecord(record, sourceType) {
  const system = systemFromRecord(record);
  if (!system) return null;

  const rawYear = getValue(record, [
    "year",
    "event_year",
    "year_completed",
    "completed_year",
    "date",
    "event_date",
    "approximate_date",
    "completedDate"
  ]);

  const yearMatch = String(rawYear).match(
    /\b(19\d{2}|20\d{2})\b/
  );

  if (!yearMatch) return null;

  const year = Number(yearMatch[1]);

  if (year > new Date().getFullYear()) {
    return null;
  }

  const status = String(getValue(record, [
    "verificationLabel",
    "verificationStatus",
    "verification_status",
    "record_status",
    "status"
  ])).toLowerCase();

  const denied =
    /unverified|not verified|pending|rejected|denied|draft|disputed/.test(
      status
    );

  const verified =
    !denied &&
    /documented|verified|approved|completed|contractor submitted/.test(
      status
    );

  if (!verified) return null;

  // MLS remarks are not accepted as capital updates.
  if (sourceType === "listing") return null;

  return {
    system,
    year,
    sourceType,
    raw: String(getValue(record, [
      "description",
      "summary",
      "notes",
      "title"
    ])).slice(0, 300),
    recentWords: true,
    hasReceipt:
      /documented/.test(status) ||
      record.hasReceipt === true,
    hasPermit: record.hasPermit === true,
    hasWarranty: record.hasWarranty === true
  };
}

async function readTrustedHistory(propertyId) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(propertyId)) {
    throw new Error("Invalid propertyId");
  }

  const url =
    HISTORY_SERVICE +
    "/api/central-property-report?propertyId=" +
    encodeURIComponent(propertyId);

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    6500
  );

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(
        "Central report HTTP " + response.status
      );
    }

    const result = await response.json();

    if (
      !result?.success ||
      String(result?.property?.id || "") !== propertyId
    ) {
      throw new Error(
        "Property identity mismatch or invalid record"
      );
    }

    const records = [
      ...(
        Array.isArray(result.contractorRecords)
          ? result.contractorRecords.map(
              r => [r, "contractor"]
            )
          : []
      ),
      ...(
        Array.isArray(result.homeownerUpdates)
          ? result.homeownerUpdates.map(
              r => [r, "homeowner"]
            )
          : []
      )
    ];

    return records
      .map(([record, type]) =>
        claimFromTrustedRecord(record, type)
      )
      .filter(Boolean);

  } finally {
    clearTimeout(timeout);
  }
}

async function handler(req, res) {
  const origin = String(
    req.headers?.origin || ""
  );

  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader(
      "Access-Control-Allow-Origin",
      origin
    );
    res.setHeader("Vary", "Origin");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, OPTIONS"
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type"
    );
  }

  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "X-Content-Type-Options",
    "nosniff"
  );

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (
    req.method !== "GET" &&
    req.method !== "POST"
  ) {
    res.setHeader(
      "Allow",
      "GET, POST, OPTIONS"
    );

    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  if (
    origin &&
    !ALLOWED_ORIGINS.has(origin)
  ) {
    return res.status(403).json({
      ok: false,
      error: "Origin not allowed"
    });
  }

  try {
    const payload =
      req.method === "GET"
        ? req.query || {}
        : req.body || {};

    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    ) {
      return res.status(400).json({
        ok: false,
        error: "Expected a JSON object"
      });
    }

    const year = parseNumber(
      payload.builtYear ?? payload.yearBuilt,
      1701,
      new Date().getFullYear(),
      true
    );

    const sqft = parseNumber(
      payload.sqft ?? payload.livingSqft,
      1,
      100000,
      false
    );

    const permits =
      payload.permitCount == null
        ? 0
        : parseNumber(
            payload.permitCount,
            0,
            100000,
            true
          );

    if (
      year === null ||
      sqft === null ||
      permits === null
    ) {
      return res.status(400).json({
        ok: false,
        error: "Valid builtYear and sqft required; permitCount optional"
      });
    }

    const age =
      new Date().getFullYear() - year;

    const propertyId =
      typeof payload.propertyId === "string"
        ? payload.propertyId.trim()
        : "";

    let claims = [];
    let historyStatus = propertyId
      ? "unavailable"
      : "not_requested";

    if (propertyId) {
      try {
        claims = await readTrustedHistory(
          propertyId
        );
        historyStatus = "loaded";
      } catch (error) {
        console.warn(
          "[BlueVera Capital Exposure] history unavailable:",
          error.message
        );
      }
    }

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
        ? "trusted_records_applied"
        : "baseline_only",
      historyStatus,
      appliedRecordCount: claims.length,
      version: "2026-10-29-server-v2-history-safe",
      propertyFacts: {
        builtYear: year,
        age,
        sqft,
        permitCount: permits
      },
      capitalExposure: plan,
      warning:
        historyStatus === "unavailable"
          ? "Contributor history unavailable; baseline shown. Do not represent as verified."
          : "Only positively verified central homeowner/contractor records applied. Dated ARMLS input-form integration pending."
    });

  } catch (err) {
    console.error(
      "[BlueVera Capital Exposure] computation error:",
      err
    );

    return res.status(500).json({
      ok: false,
      error: "Capital Exposure temporarily unavailable"
    });
  }
}

module.exports = handler;

// Local testing only.
module.exports._buildCapitalPlan = buildCapitalPlan;

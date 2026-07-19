export const config = {
  api: {
    bodyParser: {
      sizeLimit: "1mb"
    }
  }
};

const SUPABASE_URL = String(
  process.env.SUPABASE_URL || ""
).replace(/\/+$/, "");

const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  "";

const ANON_KEY =
  process.env.SUPABASE_ANON_KEY || "";

const RATING_VERSION =
  "bluevera-v2-map-baseline";

function clean(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(value) {
  return clean(value).toLowerCase();
}

function clamp(value, minimum, maximum) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return minimum;
  }

  return Math.max(
    minimum,
    Math.min(maximum, Math.round(number))
  );
}

function normalizeAddress(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[.,#]/g, " ")
    .replace(/\bwest\b/g, "w")
    .replace(/\beast\b/g, "e")
    .replace(/\bnorth\b/g, "n")
    .replace(/\bsouth\b/g, "s")
    .replace(/\bstreet\b/g, "st")
    .replace(/\bavenue\b/g, "ave")
    .replace(/\broad\b/g, "rd")
    .replace(/\bdrive\b/g, "dr")
    .replace(/\blane\b/g, "ln")
    .replace(/\bboulevard\b/g, "blvd")
    .replace(/\bcourt\b/g, "ct")
    .replace(/\bplace\b/g, "pl")
    .replace(/\bterrace\b/g, "ter")
    .replace(/\bparkway\b/g, "pkwy")
    .replace(/\s+/g, " ")
    .trim();
}

function ratingBand(score) {
  if (score >= 95) return "Blue Ribbon";
  if (score >= 90) return "Strong";
  if (score >= 75) return "Well Documented";
  if (score >= 60) return "Partial";
  if (score >= 40) return "Limited";

  return "Incomplete";
}

async function supabaseRequest(
  path,
  options = {}
) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      ...options,

      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    }
  );

  const text = await response.text();

  let data = null;

  try {
    data = text
      ? JSON.parse(text)
      : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(
      data?.message ||
      data?.error ||
      data?.hint ||
      text ||
      `Supabase request failed (${response.status}).`
    );
  }

  return data;
}

async function optionalSupabaseRequest(
  path,
  options = {}
) {
  try {
    return await supabaseRequest(
      path,
      options
    );
  } catch (error) {
    console.warn(
      "Optional rating source unavailable:",
      path,
      error?.message
    );

    return [];
  }
}

async function verifySupabaseUser(req) {
  const authorization =
    clean(req.headers.authorization);

  const token = authorization
    .replace(/^Bearer\s+/i, "")
    .trim();

  if (!token) {
    throw new Error(
      "Authentication token is missing."
    );
  }

  if (!ANON_KEY) {
    throw new Error(
      "SUPABASE_ANON_KEY is not configured."
    );
  }

  const response = await fetch(
    `${SUPABASE_URL}/auth/v1/user`,
    {
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${token}`
      }
    }
  );

  const user = await response
    .json()
    .catch(() => null);

  if (!response.ok || !user?.id) {
    throw new Error(
      "The login session is invalid or expired."
    );
  }

  return user;
}

async function findProperty({
  propertyId,
  address
}) {
  if (clean(propertyId)) {
    const rows = await supabaseRequest(
      `properties?id=eq.${encodeURIComponent(
        clean(propertyId)
      )}&select=*&limit=1`,
      {
        method: "GET"
      }
    );

    return Array.isArray(rows)
      ? rows[0] || null
      : null;
  }

  const normalizedAddress =
    normalizeAddress(address);

  if (!normalizedAddress) {
    return null;
  }

  const rows = await supabaseRequest(
    `properties?normalized_address=eq.${encodeURIComponent(
      normalizedAddress
    )}&select=*&limit=1`,
    {
      method: "GET"
    }
  );

  return Array.isArray(rows)
    ? rows[0] || null
    : null;
}

async function loadPropertyEntries(
  propertyId
) {
  const rows = await supabaseRequest(
    `property_report_entries?property_id=eq.${encodeURIComponent(
      propertyId
    )}&select=*`,
    {
      method: "GET"
    }
  );

  return Array.isArray(rows)
    ? rows
    : [];
}

async function loadPropertyDocuments(
  propertyId
) {
  const rows = await optionalSupabaseRequest(
    `property_documents?property_id=eq.${encodeURIComponent(
      propertyId
    )}&select=*`,
    {
      method: "GET"
    }
  );

  return Array.isArray(rows)
    ? rows
    : [];
}

function entryText(entry) {
  return normalize([
    entry.category,
    entry.system_name,
    entry.statement,
    entry.source_type,
    entry.source_name,
    entry.verification_status,
    entry.document_type
  ]
    .filter(Boolean)
    .join(" "));
}

function documentText(document) {
  return normalize([
    document.document_type,
    document.type,
    document.category,
    document.title,
    document.name,
    document.file_name,
    document.description,
    document.source_type,
    document.source_name
  ]
    .filter(Boolean)
    .join(" "));
}

function containsAny(text, terms) {
  return terms.some(term =>
    text.includes(term)
  );
}

function hasEntryMatching(
  entries,
  terms
) {
  return entries.some(entry =>
    containsAny(
      entryText(entry),
      terms
    )
  );
}

function hasDocumentMatching(
  documents,
  terms
) {
  return documents.some(document =>
    containsAny(
      documentText(document),
      terms
    )
  );
}

function countUniqueSystems(entries) {
  const systems = {
    roof: [
      "roof",
      "shingle",
      "underlayment"
    ],

    hvac: [
      "hvac",
      "air conditioner",
      "air conditioning",
      "furnace",
      "heat pump"
    ],

    waterHeater: [
      "water heater",
      "tankless"
    ],

    electrical: [
      "electrical",
      "panel",
      "breaker"
    ],

    plumbing: [
      "plumbing",
      "sewer",
      "pipe",
      "water line"
    ],

    pool: [
      "pool",
      "spa"
    ],

    solar: [
      "solar",
      "photovoltaic"
    ]
  };

  const found = new Set();

  entries.forEach(entry => {
    const text = entryText(entry);

    Object.entries(systems)
      .forEach(([system, terms]) => {
        if (containsAny(text, terms)) {
          found.add(system);
        }
      });
  });

  return found.size;
}

function calculatePermitPoints(entries) {
  const permitEntries =
    entries.filter(entry => {
      const status =
        normalize(entry.verification_status);

      const type =
        normalize(entry.document_type);

      const text =
        entryText(entry);

      return (
        status === "permit_documented" ||
        type === "permit" ||
        text.includes("permit documented") ||
        text.includes("permit found")
      );
    });

  const count =
    permitEntries.length;

  let points = 0;

  if (count >= 3) {
    points = 9;
  } else if (count === 2) {
    points = 6;
  } else if (count === 1) {
    points = 3;
  }

  return {
    points,
    maximum: 9,
    count
  };
}

function calculateHistoryScore(
  property,
  entries
) {
  const breakdown = {};

  let propertyRecordPoints = 0;

  if (
    clean(
      property.full_address ||
      property.address ||
      property.street
    )
  ) {
    propertyRecordPoints += 1;
  }

  if (property.year_built) {
    propertyRecordPoints += 1;
  }

  if (property.living_sqft) {
    propertyRecordPoints += 1;
  }

  if (
    clean(property.apn) ||
    (
      property.latitude !== null &&
      property.longitude !== null
    )
  ) {
    propertyRecordPoints += 1;
  }

  breakdown.propertyRecord = {
    label: "Core property record",
    score: propertyRecordPoints,
    maximum: 4
  };

  const permitResult =
    calculatePermitPoints(entries);

  breakdown.permitInformation = {
    label: "Permit information",
    score: permitResult.points,
    maximum: 9,
    count: permitResult.count
  };

  const listingEntries =
    entries.filter(entry =>
      normalize(entry.source_type) ===
      "listing_remark"
    );

  breakdown.publicListingRemarks = {
    label:
      "Public listing remarks entered",

    score:
      listingEntries.length > 0
        ? 5
        : 0,

    maximum: 5,
    count: listingEntries.length
  };

  const datedEntries =
    listingEntries.filter(entry =>
      Boolean(
        entry.event_year ||
        entry.event_date
      )
    );

  breakdown.datedInformation = {
    label:
      "Listing remarks include dates",

    score:
      datedEntries.length > 0
        ? 8
        : 0,

    maximum: 8,
    count: datedEntries.length
  };

  const systemsFound =
    countUniqueSystems(entries);

  breakdown.majorSystems = {
    label: "Major systems mentioned",

    score:
      Math.min(
        10,
        systemsFound * 2
      ),

    maximum: 10,
    count: systemsFound
  };

  const homeownerEntries =
    entries.filter(entry =>
      containsAny(
        entryText(entry),
        [
          "homeowner",
          "owner update"
        ]
      )
    );

  const contractorEntries =
    entries.filter(entry =>
      containsAny(
        entryText(entry),
        [
          "contractor",
          "licensed contractor"
        ]
      )
    );

  const inspectorEntries =
    entries.filter(entry =>
      containsAny(
        entryText(entry),
        [
          "inspector",
          "inspection"
        ]
      )
    );

  const warrantyEntries =
    entries.filter(entry =>
      containsAny(
        entryText(entry),
        [
          "home warranty",
          "warranty company",
          "insurance claim",
          "insurance company"
        ]
      )
    );

  let contributorPoints = 0;

  if (homeownerEntries.length) {
    contributorPoints += 1;
  }

  if (contractorEntries.length) {
    contributorPoints += 1;
  }

  if (inspectorEntries.length) {
    contributorPoints += 1;
  }

  if (warrantyEntries.length) {
    contributorPoints += 1;
  }

  breakdown.contributorRecords = {
    label:
      "Verified contributor records",

    score:
      contributorPoints,

    maximum:
      4,

    counts: {
      homeowner:
        homeownerEntries.length,

      contractor:
        contractorEntries.length,

      inspector:
        inspectorEntries.length,

      warrantyOrInsurance:
        warrantyEntries.length
    }
  };

  const score = clamp(
    Object.values(breakdown)
      .reduce(
        (total, item) =>
          total +
          Number(item.score || 0),
        0
      ),
    0,
    40
  );

  return {
    score,
    maximum: 40,
    breakdown
  };
}

function calculateDocumentScore(
  entries,
  documents
) {
  const combinedDocuments = [
    ...documents,

    ...entries.filter(entry =>
      Boolean(
        clean(entry.document_url) ||
        clean(entry.document_type) ||
        [
          "documentation_mentioned",
          "permit_documented"
        ].includes(
          normalize(
            entry.verification_status
          )
        )
      )
    )
  ];

  const rules = [
    {
      key: "inspectionReport",
      label: "Inspection Report",
      maximum: 12,
      terms: [
        "inspection report",
        "home inspection"
      ]
    },

    {
      key: "sellerDisclosure",
      label:
        "Seller Property Disclosure",

      maximum:
        12,

      terms: [
        "seller disclosure",
        "spds",
        "property disclosure"
      ]
    },

    {
      key: "workRepairReceipts",
      label:
        "Work / Repair Receipts",

      maximum:
        10,

      terms: [
        "receipt",
        "invoice",
        "repair record",
        "work order"
      ]
    },

    {
      key: "hoaDocuments",
      label: "HOA Documents",
      maximum: 6,

      terms: [
        "hoa document",
        "homeowners association",
        "cc&r",
        "ccrs"
      ]
    },

    {
      key: "surveySitePlan",
      label: "Survey / Site Plan",
      maximum: 6,

      terms: [
        "survey",
        "site plan",
        "property sketch"
      ]
    },

    {
      key: "hvacMaintenanceReceipt",
      label:
        "HVAC Maintenance Receipt",

      maximum:
        4,

      terms: [
        "hvac maintenance",
        "air conditioning service",
        "furnace service"
      ]
    },

    {
      key: "newHvacSystemReceipt",
      label:
        "New HVAC System Receipt",

      maximum:
        5,

      terms: [
        "hvac replacement",
        "new hvac",
        "air conditioner replacement",
        "furnace replacement"
      ]
    },

    {
      key: "poolEquipmentWork",
      label:
        "Pool Equipment / Work",

      maximum:
        3,

      terms: [
        "pool equipment",
        "pool pump",
        "pool resurfacing",
        "pool repair"
      ]
    },

    {
      key: "solarInformation",
      label: "Solar Information",
      maximum: 2,

      terms: [
        "solar",
        "photovoltaic",
        "power purchase agreement",
        "solar lease"
      ]
    }
  ];

  const breakdown = {};

  rules.forEach(rule => {
    const found =
      hasDocumentMatching(
        combinedDocuments,
        rule.terms
      ) ||
      hasEntryMatching(
        entries,
        rule.terms
      );

    breakdown[rule.key] = {
      label:
        rule.label,

      score:
        found
          ? rule.maximum
          : 0,

      maximum:
        rule.maximum,

      found
    };
  });

  const score = clamp(
    Object.values(breakdown)
      .reduce(
        (total, item) =>
          total +
          Number(item.score || 0),
        0
      ),
    0,
    60
  );

  return {
    score,
    maximum: 60,
    breakdown
  };
}

function getMapBaseline(property) {
  const score = clamp(
    property.map_rating ??
    property.current_rating ??
    0,
    0,
    100
  );

  const historyScore = clamp(
    property.map_history_score ?? 0,
    0,
    40
  );

  const documentScore = clamp(
    property.map_document_score ?? 0,
    0,
    60
  );

  const breakdown =
    property.map_rating_breakdown &&
    typeof property.map_rating_breakdown ===
      "object"
      ? property.map_rating_breakdown
      : {};

  const permitCount = clamp(
    breakdown.permitCount ?? 0,
    0,
    999
  );

  let permitPoints = 0;

  if (permitCount >= 3) {
    permitPoints = 9;
  } else if (permitCount === 2) {
    permitPoints = 6;
  } else if (permitCount === 1) {
    permitPoints = 3;
  }

  return {
    score,
    historyScore,
    documentScore,
    permitCount,
    permitPoints,
    breakdown
  };
}

function calculateAdditionalHistory(
  historyResult,
  mapBaseline
) {
  const history =
    historyResult.breakdown;

  const additionalPermitPoints =
    Math.max(
      0,

      Number(
        history.permitInformation.score ||
        0
      ) -
      Number(
        mapBaseline.permitPoints ||
        0
      )
    );

  const breakdown = {
    additionalPermitInformation: {
      label:
        "Additional documented permit information",

      score:
        additionalPermitPoints,

      maximum:
        Math.max(
          0,
          9 -
          Number(
            mapBaseline.permitPoints ||
            0
          )
        ),

      centralPermitCount:
        history.permitInformation.count ||
        0,

      mapPermitCount:
        mapBaseline.permitCount ||
        0
    },

    publicListingRemarks:
      history.publicListingRemarks,

    datedInformation:
      history.datedInformation,

    majorSystems:
      history.majorSystems,

    contributorRecords:
      history.contributorRecords
  };

  const score = clamp(
    Object.values(breakdown)
      .reduce(
        (total, item) =>
          total +
          Number(item.score || 0),
        0
      ),
    0,
    40
  );

  return {
    score,
    breakdown
  };
}

function buildImprovementItems(
  historyResult,
  documentResult
) {
  const items = [];

  const history =
    historyResult.breakdown;

  const documents =
    documentResult.breakdown;

  if (
    history.permitInformation.score <
    history.permitInformation.maximum
  ) {
    items.push(
      "Add available permit records or final inspection approvals."
    );
  }

  if (
    history.publicListingRemarks.score ===
    0
  ) {
    items.push(
      "Add public listing remarks or a listing information source."
    );
  }

  if (
    history.datedInformation.score ===
    0
  ) {
    items.push(
      "Add dates for repairs, replacements, and improvements."
    );
  }

  if (
    history.majorSystems.score <
    history.majorSystems.maximum
  ) {
    items.push(
      "Add records for major systems such as the roof, HVAC, water heater, electrical panel, or plumbing."
    );
  }

  if (
    !documents.inspectionReport.found
  ) {
    items.push(
      "Upload an available inspection report."
    );
  }

  if (
    !documents.sellerDisclosure.found
  ) {
    items.push(
      "Upload the seller property disclosure when available."
    );
  }

  if (
    !documents.workRepairReceipts.found
  ) {
    items.push(
      "Upload available repair receipts, invoices, or warranties."
    );
  }

  return items;
}

async function saveRating(
  propertyId,
  rating
) {
  const now =
    new Date().toISOString();

  const payload = {
    current_rating:
      rating.score,

    rating_band:
      rating.band,

    history_score:
      rating.historyScore,

    document_score:
      rating.documentScore,

    rating_breakdown:
      rating.breakdown,

    rating_improvement_items:
      rating.improvementItems,

    rating_version:
      RATING_VERSION,

    rating_calculated_by:
      "central-server",

    rating_input_counts:
      rating.inputCounts,

    rating_updated_at:
      now,

    updated_at:
      now
  };

  const rows = await supabaseRequest(
    `properties?id=eq.${encodeURIComponent(
      propertyId
    )}`,
    {
      method: "PATCH",

      headers: {
        Prefer:
          "return=representation"
      },

      body:
        JSON.stringify(payload)
    }
  );

  return Array.isArray(rows)
    ? rows[0] || null
    : null;
}

export default async function handler(
  req,
  res
) {
  res.setHeader(
    "Content-Type",
    "application/json"
  );

  res.setHeader(
    "Cache-Control",
    "no-store, max-age=0"
  );

  res.setHeader(
    "Allow",
    "POST, OPTIONS"
  );

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,

      error:
        "Method not allowed. Use POST."
    });
  }

  if (
    !SUPABASE_URL ||
    !SERVICE_KEY
  ) {
    return res.status(500).json({
      success: false,

      error:
        "Supabase server environment variables are not configured."
    });
  }

  try {
    const user =
      await verifySupabaseUser(req);

    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body || {};

    const property =
      await findProperty({
        propertyId:
          body.propertyId ||
          body.property_id,

        address:
          body.address ||
          body.fullAddress
      });

    if (!property?.id) {
      return res.status(404).json({
        success: false,

        error:
          "The property record was not found."
      });
    }

    const entries =
      await loadPropertyEntries(
        property.id
      );

    const documents =
      await loadPropertyDocuments(
        property.id
      );

    const historyResult =
      calculateHistoryScore(
        property,
        entries
      );

    const documentResult =
      calculateDocumentScore(
        entries,
        documents
      );

    const mapBaseline =
      getMapBaseline(property);

    const additionalHistory =
      calculateAdditionalHistory(
        historyResult,
        mapBaseline
      );

    const additionalDocumentScore =
      Math.max(
        0,

        documentResult.score -
        mapBaseline.documentScore
      );

    const finalHistoryScore = clamp(
      mapBaseline.historyScore +
      additionalHistory.score,
      0,
      40
    );

    const finalDocumentScore = clamp(
      mapBaseline.documentScore +
      additionalDocumentScore,
      0,
      60
    );

    const finalScore = clamp(
      mapBaseline.score +
      additionalHistory.score +
      additionalDocumentScore,
      0,
      100
    );

    const improvementItems =
      buildImprovementItems(
        historyResult,
        documentResult
      );

    const sourceCounts =
      entries.reduce(
        (counts, entry) => {
          const source =
            normalize(
              entry.source_type ||
              "unknown"
            )
              .replace(
                /[^a-z0-9]+/g,
                "_"
              );

          counts[source] =
            (counts[source] || 0) +
            1;

          return counts;
        },
        {}
      );

    const rating = {
      score:
        finalScore,

      band:
        ratingBand(finalScore),

      historyScore:
        finalHistoryScore,

      documentScore:
        finalDocumentScore,

      breakdown: {
        mapBaseline: {
          score:
            mapBaseline.score,

          historyScore:
            mapBaseline.historyScore,

          documentScore:
            mapBaseline.documentScore,

          permitPoints:
            mapBaseline.permitPoints,

          permitCount:
            mapBaseline.permitCount,

          breakdown:
            mapBaseline.breakdown
        },

        additionalHistory:
          additionalHistory.score,

        additionalDocumentation:
          additionalDocumentScore,

        finalHistoryScore,
        finalDocumentScore,

        history:
          additionalHistory.breakdown,

        documents:
          documentResult.breakdown
      },

      improvementItems,

      inputCounts: {
        reportEntries:
          entries.length,

        propertyDocuments:
          documents.length,

        sourceTypes:
          sourceCounts
      }
    };

    const updatedProperty =
      await saveRating(
        property.id,
        rating
      );

    return res.status(200).json({
      success: true,

      propertyId:
        property.id,

      calculatedBy:
        "central-server",

      ratingVersion:
        RATING_VERSION,

      rating:
        rating.score,

      band:
        rating.band,

      historyScore:
        rating.historyScore,

      documentScore:
        rating.documentScore,

      breakdown:
        rating.breakdown,

      improvementItems:
        rating.improvementItems,

      inputCounts:
        rating.inputCounts,

      property:
        updatedProperty,

      calculatedForUser:
        user.id
    });
  } catch (error) {
    console.error(
      "Central property rating calculation failed:",
      error
    );

    const message =
      error?.message ||
      "The property rating could not be calculated.";

    const status =
      /authentication|session|token|expired/i
        .test(message)
        ? 401
        : 500;

    return res.status(status).json({
      success: false,
      error: message
    });
  }
}

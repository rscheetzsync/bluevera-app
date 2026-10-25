
const DEFAULT_CONFIG = {
  supabaseUrl: "",
  serviceKey: ""
};

function clean(v) {
  return String(v ?? "").trim();
}

function getConfig(config = {}) {
  const supabaseUrl = clean(
    config.supabaseUrl || DEFAULT_CONFIG.supabaseUrl
  ).replace(/\/+$/, "");

  const serviceKey = clean(
    config.serviceKey || DEFAULT_CONFIG.serviceKey
  );

  if (!supabaseUrl || !serviceKey) {
    throw new Error(
      "Supabase configuration is missing from the property evidence loader."
    );
  }
  return { supabaseUrl, serviceKey };
}

function normalizeAddress(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[.,#]/g, " ")
    .replace(/\bwest\b/g, "w")
    .replace(/\beast\b/g, "e")
    .replace(/\bnorth\b/g, "n")
    .replace(/\bsouth\b/g, "s")
    .replace(/\bnortheast\b/g, "ne")
    .replace(/\bnorthwest\b/g, "nw")
    .replace(/\bsoutheast\b/g, "se")
    .replace(/\bsouthwest\b/g, "sw")
    .replace(/\bavenue\b/g, "ave")
    .replace(/\bstreet\b/g, "st")
    .replace(/\bdrive\b/g, "dr")
    .replace(/\broad\b/g, "rd")
    .replace(/\bboulevard\b/g, "blvd")
    .replace(/\bplace\b/g, "pl")
    .replace(/\bcourt\b/g, "ct")
    .replace(/\bcircle\b/g, "cir")
    .replace(/\blane\b/g, "ln")
    .replace(/\bterrace\b/g, "ter")
    .replace(/\bparkway\b/g, "pkwy")
    .replace(
      /\b(arizona|az|phoenix|glendale|scottsdale|tempe|mesa|chandler|gilbert|paradise valley)\b/g,
      " "
    )
    .replace(/\b\d{5}(?:-\d{4})?\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function addressParts(value) {
  const normalized = normalizeAddress(value);
  const parts = normalized.split(" ").filter(Boolean);
  const i = parts.findIndex(p => /^\d+[a-z]?$/.test(p));
  const number = i >= 0 ? parts[i] : "";
  const directions = new Set([
    "n", "s", "e", "w", "ne", "nw", "se", "sw"
  ]);
  const types = new Set([
    "st", "ave", "rd", "dr", "blvd", "pl",
    "ct", "cir", "ln", "ter", "pkwy",
    "trl", "hwy", "way"
  ]);
  let direction = "";
  let streetType = "";
  const words = [];

  if (i >= 0) {
    let cursor = i + 1;
    if (directions.has(parts[cursor] || "")) {
      direction = parts[cursor++];
    }
    for (let j = cursor; j < parts.length; j++) {
      const p = parts[j];
      if (types.has(p)) {
        streetType = p;
        break;
      }
      if (directions.has(p) && words.length) {
        if (!direction) direction = p;
        continue;
      }
      words.push(p);
    }
  }

  return {
    normalized,
    number,
    direction,
    streetName: words.join(" "),
    streetType,
    words
  };
}

function addressesMatch(a, b) {
  const x = addressParts(a);
  const y = addressParts(b);

  if (!x.number || !y.number || x.number !== y.number)
    return false;

  if (x.direction || y.direction) {
    if (!x.direction || !y.direction ||
        x.direction !== y.direction)
      return false;
  }

  if (!x.streetName || !y.streetName ||
      x.streetName !== y.streetName)
    return false;

  if (x.streetType && y.streetType &&
      x.streetType !== y.streetType)
    return false;

  return true;
}

function propertyAddress(p) {
  return clean(p?.full_address || p?.address || p?.street);
}

function sellerDocumentAddressPath(address) {
  const p = addressParts(address);
  const words = p.words.filter(w => w.length >= 3).slice(0, 2);
  if (!p.number || !words.length) return "";

  const pattern = `*${[p.number, ...words].join("*")}*`;
  return (
    "seller_documents?property_address=ilike." +
    encodeURIComponent(pattern) +
    "&select=*&limit=100"
  );
}

function propertyQuality(p) {
  return {
    calculated: p?.rating_updated_at &&
      p?.current_rating != null ? 1 : 0,
    ratingTime: Date.parse(
      p?.rating_updated_at ||
      p?.updated_at ||
      p?.created_at || ""
    ) || 0,
    evidence: Number(p?.history_score || 0) +
      Number(p?.document_score || 0)
  };
}

function preferCanonicalProperty(a, b) {
  const x = propertyQuality(a);
  const y = propertyQuality(b);
  for (const key of ["calculated", "ratingTime", "evidence"]) {
    if (x[key] !== y[key])
      return y[key] > x[key] ? b : a;
  }
  return a;
}

function collapseDuplicateProperties(properties) {
  const result = [];
  for (const property of Array.isArray(properties) ? properties : []) {
    const i = result.findIndex(existing =>
      addressesMatch(
        propertyAddress(existing),
        propertyAddress(property)
      )
    );
    if (i < 0) result.push(property);
    else result[i] = preferCanonicalProperty(result[i], property);
  }
  return result;
}

async function rest(path, options = {}, config = {}) {
  const { supabaseUrl, serviceKey } = getConfig(config);
  const response = await fetch(
    `${supabaseUrl}/rest/v1/${path}`,
    {
      ...options,
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    }
  );

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(
      data?.message || data?.error || data?.hint ||
      text || `Supabase request failed (${response.status}).`
    );
  }
  return data;
}

async function requiredHomeownerRows(path, options, config) {
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const page = await rest(
      `${path}&limit=500&offset=${offset}`,
      options,
      config
    );
    if (!Array.isArray(page))
      throw new Error("Invalid homeowner history response");

    rows.push(...page);
    if (page.length < 500) return rows;
  }
}

// Supplemental legacy data must not crash the main property
// history response. Failure is tracked separately from zero records.
async function optionalLegacyHomeownerRows(
  path, options, config, status
) {
  try {
    const rows = await requiredHomeownerRows(
      path, options, config
    );
    status.available = true;
    return rows;
  } catch (error) {
    status.available = false;
    console.warn(
      "Legacy homeowner evidence unavailable:",
      error?.message
    );
    return [];
  }
}

async function optionalRest(path, options = {}, config = {}) {
  try {
    const rows = await rest(path, options, config);
    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    console.warn(
      "Optional property evidence source unavailable:",
      path, error?.message
    );
    return [];
  }
}

function activeHomeownerRow(row) {
  return ![
    "deleted", "archived", "rejected", "removed", "inactive"
  ].includes(clean(row?.status).toLowerCase());
}

function mergeUniqueRows(...groups) {
  const map = new Map();
  for (const row of groups.flat()) {
    if (!row) continue;
    const key = clean(row.id) || [
      row.property_id,
      row.property_address,
      row.created_at,
      row.statement,
      row.description,
      row.note
    ].map(clean).join("|");
    if (!map.has(key)) map.set(key, row);
  }
  return [...map.values()];
}

function dedupeHomeownerUpdates(rows) {
  const map = new Map();

  function rank(row) {
    const status = clean(
      row?.verification_status ||
      row?.record_status ||
      row?.status
    ).toLowerCase();

    return {
      evidence: /verified/.test(status) ? 3 :
        /documented|receipt|invoice|permit/.test(status) ? 2 : 1,
      time: Date.parse(
        row?.updated_at ||
        row?.created_at ||
        row?.completed_date ||
        row?.approximate_date || ""
      ) || 0
    };
  }

  (Array.isArray(rows) ? rows : []).forEach((row, i) => {
    const key = clean(row?.id) ||
      clean(
        row?.update_type ||
        row?.system_name ||
        row?.category ||
        row?.title ||
        row?.work_type
      ).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() ||
      `record-${i}`;

    const existing = map.get(key);
    if (!existing) {
      map.set(key, row);
      return;
    }
    const oldRank = rank(existing);
    const newRank = rank(row);
    if (
      newRank.evidence > oldRank.evidence ||
      (newRank.evidence === oldRank.evidence &&
       newRank.time > oldRank.time)
    ) map.set(key, row);
  });

  return [...map.values()];
}

function firstValue(row, keys, fallback = "") {
  for (const key of keys) {
    const value = row?.[key];
    if (value != null && clean(value) !== "") return value;
  }
  return fallback;
}

function normalizeEvidenceRow(row, defaults = {}) {
  const get = (keys, fallback) =>
    firstValue(row, keys, fallback);

  return {
    id: get(
      ["id"], `${defaults.sourceType || "record"}-${Math.random()}`
    ),
    property_id: get(
      ["property_id"], defaults.propertyId || null
    ),
    category: get(
      ["category", "record_category", "update_type",
       "work_type", "document_type"],
      defaults.category || "Property Record"
    ),
    system_name: get(
      ["system_name", "system", "home_system", "trade",
       "service_type", "update_type", "work_type"],
      defaults.systemName || "—"
    ),
    event_year: get(
      ["event_year", "year", "service_year", "work_year",
       "installed_year", "replacement_year"], null
    ),
    event_date: get(
      ["event_date", "service_date", "work_date",
       "completed_date", "completed_at",
       "inspection_date", "approximate_date"], null
    ),
    statement: clean(get(
      ["statement", "description", "work_description",
       "update_description", "note", "notes", "details",
       "summary", "title", "document_name", "file_name"],
      "Record available"
    )),
    source_type: get(
      ["source_type"], defaults.sourceType || "property_record"
    ),
    source_name: get(
      ["source_name", "business_name", "contractor_name",
       "homeowner_name", "company_name", "contractor", "email"],
      defaults.sourceName || ""
    ),
    verification_status: get(
      ["verification_status", "verified_status", "status",
       "record_status"],
      defaults.verificationStatus || "submitted"
    ),
    document_type: get(
      ["document_type", "file_type"],
      defaults.documentType || ""
    ),
    document_url: get(
      ["document_url", "file_url", "report_url", "receipt_url",
       "invoice_url", "storage_url", "public_url"], ""
    ),
    created_at: get(
      ["created_at", "submitted_at"], null
    ),
    updated_at: get(
      ["updated_at", "modified_at", "created_at", "submitted_at"],
      null
    ),
    homeowner_update_id: row.homeowner_update_id ||
      (defaults.originalTable === "homeowner_updates"
        ? row.id : null),
    status: clean(row.status),
    original_table: defaults.originalTable || ""
  };
}

function sortEvidenceRows(rows) {
  return [...rows].sort((a, b) => {
    const timestamp = row => Date.parse(
      row.updated_at || row.created_at || row.event_date || ""
    ) || 0;
    return timestamp(b) - timestamp(a);
  });
}

function sanitizeSourceName(sourceName, sourceType) {
  const name = clean(sourceName);
  const type = clean(sourceType).toLowerCase();
  if (type === "homeowner_update" &&
      (!name || name.includes("@")))
    return "Homeowner";
  if (name.includes("@")) return "Property Contributor";
  return name || "BlueVera Record";
}

function sanitizeProperty(p, privateFields) {
  if (privateFields) return p;
  return {
    id: p.id,
    full_address: p.full_address || p.address || p.street || "",
    street: p.street || null,
    city: p.city || null,
    state: p.state || null,
    zip: p.zip || null,
    county: p.county || null,
    apn: p.apn || null,
    year_built: p.year_built || null,
    living_sqft: p.living_sqft || null,
    current_rating: p.current_rating ?? null,
    rating_band: p.rating_band || null,
    history_score: p.history_score ?? null,
    document_score: p.document_score ?? null,
    rating_input_counts: p.rating_input_counts || {},
    rating_updated_at: p.rating_updated_at || null,
    rating_version: p.rating_version || null
  };
}

function sanitizeEntry(e, privateFields) {
  if (privateFields) return e;
  return {
    id: e.id,
    property_id: e.property_id,
    category: e.category,
    system_name: e.system_name,
    event_year: e.event_year,
    event_date: e.event_date,
    statement: e.statement,
    source_type: e.source_type,
    source_name: sanitizeSourceName(
      e.source_name, e.source_type
    ),
    verification_status: e.verification_status,
    document_type: e.document_type,
    created_at: e.created_at,
    updated_at: e.updated_at,
    homeowner_update_id: e.homeowner_update_id,
    status: e.status,
    original_table: e.original_table
  };
}

export async function searchProperties(query, config = {}) {
  const q = clean(query);
  if (!q) return [];

  const encoded = encodeURIComponent(`*${q}*`);
  const uuidLike = /^[0-9a-f-]{30,}$/i.test(q);

  const filters = uuidLike
    ? [
        `id.eq.${encodeURIComponent(q)}`,
        `full_address.ilike.${encoded}`,
        `normalized_address.ilike.${encoded}`,
        `apn.ilike.${encoded}`
      ]
    : [
        `full_address.ilike.${encoded}`,
        `address.ilike.${encoded}`,
        `street.ilike.${encoded}`,
        `normalized_address.ilike.${encoded}`,
        `apn.ilike.${encoded}`
      ];

  const rows = await rest(
    `properties?or=(${filters.join(",")})&select=*&limit=25`,
    { method: "GET" }, config
  );

  return collapseDuplicateProperties(rows);
}

export async function loadPropertyEvidence(
  options = {}, config = {}
) {
  const propertyId = clean(
    options.propertyId || options.property_id
  );

  if (!propertyId)
    throw new Error("A property ID is required.");

  const includePrivateFields =
    options.includePrivateFields === true;
  const includeAdjustments =
    options.includeAdjustments !== false;
  const includeDocuments =
    options.includeDocuments !== false;

  const id = encodeURIComponent(propertyId);
  const properties = await rest(
    `properties?id=eq.${id}&select=*&limit=1`,
    { method: "GET" }, config
  );

  let property = Array.isArray(properties)
    ? properties[0] : null;

  if (!property)
    throw new Error("The central property record was not found.");

  const ratingRows = await optionalRest(
    `property_current_ratings?property_id=eq.${id}&select=*&limit=1`,
    { method: "GET" }, config
  );

  const rating = ratingRows[0];
  if (rating) {
    property = {
      ...property,
      current_rating: rating.disclosure_rating,
      rating_band: rating.rating_level,
      history_score: rating.history_score,
      document_score: rating.document_score,
      rating_breakdown: rating.rating_breakdown,
      rating_improvement_items: rating.rating_improvement_items,
      rating_input_counts: rating.rating_input_counts,
      rating_version: rating.formula_version,
      rating_updated_at: rating.calculated_at,
      rating_source: "property_ratings"
    };
  }

  const address = propertyAddress(property);
  const method = { method: "GET" };
  const optional = path => optionalRest(path, method, config);
  const documents = includeDocuments
    ? [
        optional(`contractor_documents?property_id=eq.${id}&select=*`),
        optional(`property_documents?property_id=eq.${id}&select=*`),
        optional(`seller_documents?property_id=eq.${id}&select=*`),
        sellerDocumentAddressPath(address)
          ? optional(sellerDocumentAddressPath(address))
          : Promise.resolve([])
      ]
    : Array.from({ length: 4 }, () => Promise.resolve([]));

  const legacyHomeownerStatus = { available: null };

  const [
    reportEntries,
    adjustmentRows,
    homeownerById,
    contractorById,
    allHomeownerUpdates,
    allContractorWork,
    contractorDocuments,
    propertyDocuments,
    sellerDocumentsById,
    sellerDocumentCandidates,
    propertyHistoryItems
  ] = await Promise.all([
    optional(`property_report_entries?property_id=eq.${id}&select=*`),

    includeAdjustments
      ? optional(
          `property_rating_adjustments?property_id=eq.${id}&select=*&order=created_at.desc`
        )
      : Promise.resolve([]),

    requiredHomeownerRows(
      `homeowner_updates?property_id=eq.${id}&select=*&order=id.asc`,
      method, config
    ),

    optional(
      `contractor_work_submissions?property_id=eq.${id}&select=*,contractors(business_name,phone,email,license_number,insurance_status)`
    ),

    optionalLegacyHomeownerRows(
      "homeowner_updates?property_id=is.null&select=*&order=id.asc",
      method, config, legacyHomeownerStatus
    ),

    optional(
      "contractor_work_submissions?select=*,contractors(business_name,phone,email,license_number,insurance_status)&order=created_at.desc"
    ),

    ...documents,

    optional(
      `property_history_items?property_id=eq.${id}&select=*`
    )
  ]);

  // Legacy fallback is permitted only for unlinked records
  // that match the full street identity.
  const homeownerByAddress = allHomeownerUpdates.filter(row =>
    !clean(row.property_id) &&
    addressesMatch(
      address,
      row.property_address || row.address || row.address_text
    )
  );

  const contractorByAddress = allContractorWork.filter(row =>
    !clean(row.property_id) &&
    addressesMatch(
      address,
      row.property_address || row.address || row.address_text
    )
  );

  const homeownerUpdates = dedupeHomeownerUpdates(
    mergeUniqueRows(
      homeownerById.filter(activeHomeownerRow),
      homeownerByAddress.filter(activeHomeownerRow)
    )
  );

  const contractorWork = mergeUniqueRows(
    contractorById,
    contractorByAddress
  );

  const sellerDocumentsByAddress =
    sellerDocumentCandidates.filter(row =>
      !clean(row.property_id) &&
      addressesMatch(
        address,
        row.property_address || row.address_text || row.address
      )
    );

  const sellerDocuments = mergeUniqueRows(
    sellerDocumentsById,
    sellerDocumentsByAddress
  );

  const normalizeGroup = (rows, transform, defaults) =>
    rows.map(row =>
      normalizeEvidenceRow(
        transform ? transform(row) : row,
        { propertyId: property.id, ...defaults }
      )
    );

  const entries = [
    ...normalizeGroup(reportEntries, null, {
      originalTable: "property_report_entries"
    }),

    ...normalizeGroup(homeownerUpdates, row => ({
      ...row,
      source_type: "homeowner_update",
      statement: row.note || row.update_type || "Homeowner update",
      system_name: row.update_type || "Homeowner update",
      event_date: row.approximate_date || row.created_at,
      source_name: row.contractor || "Homeowner",
      verification_status:
        row.record_status || "homeowner_submitted"
    }), {
      category: "Homeowner Reported Update",
      sourceType: "homeowner_update",
      sourceName: "Homeowner",
      verificationStatus: "homeowner_submitted",
      originalTable: "homeowner_updates"
    }),

    ...normalizeGroup(contractorWork, row => ({
      ...row,
      statement:
        row.description || row.work_type || "Contractor work record",
      system_name: row.work_type || "Contractor work",
      event_date: row.completed_date || row.created_at,
      source_name:
        row.contractors?.business_name ||
        row.contractor_name || "Contractor",
      verification_status:
        row.status || "contractor_submitted",
      document_type: row.permit_number ? "Permit reference" : ""
    }), {
      category: "Contractor Work Record",
      sourceType: "contractor_record",
      sourceName: "Contractor",
      verificationStatus: "contractor_submitted",
      originalTable: "contractor_work_submissions"
    }),

    ...normalizeGroup(contractorDocuments, null, {
      category: "Contractor Document",
      sourceType: "contractor_document",
      sourceName: "Contractor",
      verificationStatus: "document_uploaded",
      originalTable: "contractor_documents"
    }),

    ...normalizeGroup(propertyDocuments, null, {
      category: "Property Document",
      sourceType: "property_document",
      sourceName: "BlueVera Document",
      verificationStatus: "document_uploaded",
      originalTable: "property_documents"
    }),

    ...normalizeGroup(sellerDocuments, null, {
      category: "Seller Document",
      sourceType: "seller_document",
      sourceName: "Seller",
      verificationStatus: "document_uploaded",
      originalTable: "seller_documents"
    }),

    ...normalizeGroup(propertyHistoryItems, null, {
      category: "Property History Item",
      sourceType: "property_history",
      sourceName: "BlueVera",
      verificationStatus: "recorded",
      originalTable: "property_history_items"
    })
  ];

  const adjustments = Array.isArray(adjustmentRows)
    ? adjustmentRows : [];

  const adjustmentTotal = adjustments.reduce(
    (total, row) =>
      total + Number(row.adjustment_points || 0),
    0
  );

  return {
    property: sanitizeProperty(
      property, includePrivateFields
    ),

    entries: sortEvidenceRows(entries).map(entry =>
      sanitizeEntry(entry, includePrivateFields)
    ),

    adjustments: includeAdjustments ? adjustments : [],
    adjustmentTotal: includeAdjustments ? adjustmentTotal : 0,

    evidenceCounts: {
      legacyHomeownerSourceAvailable:
        legacyHomeownerStatus.available,

      listingAndReportEntries: reportEntries.length,
      homeownerUpdates: homeownerUpdates.length,
      homeownerByPropertyId: homeownerById.length,
      homeownerByAddress: homeownerByAddress.length,
      contractorWork: contractorWork.length,
      contractorByPropertyId: contractorById.length,
      contractorByAddress: contractorByAddress.length,
      contractorDocuments: contractorDocuments.length,
      propertyDocuments: propertyDocuments.length,
      sellerDocuments: sellerDocuments.length,
      sellerDocumentsByPropertyId: sellerDocumentsById.length,
      sellerDocumentsByAddress: sellerDocumentsByAddress.length,
      propertyHistoryItems: propertyHistoryItems.length
    }
  };
}

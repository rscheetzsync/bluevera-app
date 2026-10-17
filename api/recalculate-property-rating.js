export const config = {
  api: {
    bodyParser: { sizeLimit: "1mb" }
  }
};

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const INTERNAL_API_KEY = process.env.BLUEVERA_INTERNAL_API_KEY || "";
const RATING_VERSION = "bluevera-v5-3-sold-mls-years";

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalize(value) {
  return clean(value).toLowerCase();
}

function clamp(value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.round(number)));
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
    .replace(/\bcircle\b/g, "cir")
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
  const number = parts.find(part => /^\d+[a-z]?$/.test(part)) || "";
  const words = parts.filter(part => !/^\d+[a-z]?$/.test(part));
  return { normalized, number, words };
}

function addressesMatch(firstAddress, secondAddress) {
  const first = addressParts(firstAddress);
  const second = addressParts(secondAddress);

  if (!first.normalized || !second.normalized) return false;

  if (
    first.number &&
    second.number &&
    first.number !== second.number
  ) {
    return false;
  }

  if (first.normalized === second.normalized) return true;

  if (
    first.normalized.includes(second.normalized) ||
    second.normalized.includes(first.normalized)
  ) {
    return true;
  }

  const sharedWords = first.words.filter(
    word => word.length >= 3 && second.words.includes(word)
  );

  return sharedWords.length >= 1;
}

function mergeUniqueRows(...groups) {
  const rows = new Map();

  groups.flat().forEach(row => {
    if (!row) return;

    const key =
      clean(row.id) ||
      [
        clean(row.property_id),
        clean(row.property_address),
        clean(row.created_at),
        clean(row.statement),
        clean(row.description),
        clean(row.note)
      ].join("|");

    if (!rows.has(key)) rows.set(key, row);
  });

  return Array.from(rows.values());
}

function dedupeHomeownerUpdates(rows) {
  const unique = new Map();

  (Array.isArray(rows) ? rows : []).forEach((row, index) => {
    const key =
      clean(
        row?.update_type ||
        row?.system_name ||
        row?.category ||
        row?.title ||
        row?.work_type
      )
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim() ||
      `record-${clean(row?.id) || index}`;

    const existing = unique.get(key);

    const rank = item => {
      const status = clean(
        item?.verification_status ||
        item?.record_status ||
        item?.status
      ).toLowerCase();

      return {
        evidence: /verified/.test(status)
          ? 3
          : /documented|receipt|invoice|permit/.test(status)
          ? 2
          : 1,
        time:
          Date.parse(
            item?.updated_at ||
            item?.created_at ||
            item?.completed_date ||
            item?.approximate_date ||
            ""
          ) || 0
      };
    };

    if (!existing) {
      unique.set(key, row);
      return;
    }

    const oldRank = rank(existing);
    const newRank = rank(row);

    if (
      newRank.evidence > oldRank.evidence ||
      (
        newRank.evidence === oldRank.evidence &&
        newRank.time > oldRank.time
      )
    ) {
      unique.set(key, row);
    }
  });

  return Array.from(unique.values());
}

function ratingBand(score) {
  if (score >= 95) return "Blue Ribbon";
  if (score >= 90) return "Strong";
  if (score >= 75) return "Well Documented";
  if (score >= 60) return "Partial";
  if (score >= 40) return "Limited";
  return "Incomplete";
}

async function supabaseRequest(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
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

async function optionalSupabaseRequest(path, options = {}) {
  try {
    const data = await supabaseRequest(path, options);
    return Array.isArray(data) ? data : [];
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
  const authorization = clean(req.headers.authorization);
  const token = authorization.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    throw new Error("Authentication token is missing.");
  }

  if (!ANON_KEY) {
    throw new Error("SUPABASE_ANON_KEY is not configured.");
  }

  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${token}`
    }
  });

  const user = await response.json().catch(() => null);

  if (!response.ok || !user?.id) {
    throw new Error("The login session is invalid or expired.");
  }

  return user;
}

async function findProperty({ propertyId, address }) {
  if (clean(propertyId)) {
    const rows = await supabaseRequest(
      `properties?id=eq.${encodeURIComponent(clean(propertyId))}&select=*&limit=1`,
      { method: "GET" }
    );

    return Array.isArray(rows) ? rows[0] || null : null;
  }

  const normalizedAddress = normalizeAddress(address);
  if (!normalizedAddress) return null;

  const exactRows = await supabaseRequest(
    `properties?normalized_address=eq.${encodeURIComponent(normalizedAddress)}&select=*&limit=25`,
    { method: "GET" }
  );

  if (Array.isArray(exactRows) && exactRows.length) {
    exactRows.sort((first, second) => {
      const firstCalculated =
        first.rating_updated_at &&
        first.current_rating !== null &&
        first.current_rating !== undefined
          ? 1
          : 0;

      const secondCalculated =
        second.rating_updated_at &&
        second.current_rating !== null &&
        second.current_rating !== undefined
          ? 1
          : 0;

      if (firstCalculated !== secondCalculated) {
        return secondCalculated - firstCalculated;
      }

      return (
        (
          Date.parse(
            second.rating_updated_at ||
            second.updated_at ||
            second.created_at ||
            ""
          ) || 0
        ) -
        (
          Date.parse(
            first.rating_updated_at ||
            first.updated_at ||
            first.created_at ||
            ""
          ) || 0
        )
      );
    });

    return exactRows[0];
  }

  const allRows = await supabaseRequest(
    "properties?select=*&order=created_at.desc&limit=1000",
    { method: "GET" }
  );

  const matches = (Array.isArray(allRows) ? allRows : []).filter(
    property => addressesMatch(
      address,
      property.full_address || property.address || property.street || ""
    )
  );

  matches.sort((first, second) => {
    const firstCalculated =
      first.rating_updated_at &&
      first.current_rating !== null &&
      first.current_rating !== undefined
        ? 1
        : 0;

    const secondCalculated =
      second.rating_updated_at &&
      second.current_rating !== null &&
      second.current_rating !== undefined
        ? 1
        : 0;

    if (firstCalculated !== secondCalculated) {
      return secondCalculated - firstCalculated;
    }

    return (
      (
        Date.parse(
          second.rating_updated_at ||
          second.updated_at ||
          second.created_at ||
          ""
        ) || 0
      ) -
      (
        Date.parse(
          first.rating_updated_at ||
          first.updated_at ||
          first.created_at ||
          ""
        ) || 0
      )
    );
  });

  return matches[0] || null;
}

async function loadPropertyEntries(propertyId) {
  const encodedId = encodeURIComponent(propertyId);

  const [
    reportEntries,
    historyItems,
    listingSources,
    permanentHistoryRecords
  ] = await Promise.all([
    optionalSupabaseRequest(
      `property_report_entries?property_id=eq.${encodedId}&select=*`,
      { method: "GET" }
    ),
    optionalSupabaseRequest(
      `property_history_items?property_id=eq.${encodedId}&status=eq.active&select=*`,
      { method: "GET" }
    ),
    optionalSupabaseRequest(
      `property_listing_sources?property_id=eq.${encodedId}&select=*`,
      { method: "GET" }
    ),
    optionalSupabaseRequest(
      `property_history_records?property_id=eq.${encodedId}&select=*`,
      { method: "GET" }
    )
  ]);

  const normalizedHistoryItems = historyItems.map(row =>
    normalizeContributorEntry(
      {
        ...row,
        system_name: row.item_label || row.category,
        statement: row.description || row.item_label,
        event_year: row.year,
        event_date: row.year ? `${row.year}-01-01` : row.created_at,
        source_type: row.source_type || "listing_claim",
        verification_status:
          row.verified_status || "listing_claim_not_verified"
      },
      {
        propertyId,
        category: "Property History Item",
        sourceType: "listing_claim",
        sourceName: "Listing Claim",
        verificationStatus: "listing_claim_not_verified"
      }
    )
  );

  const normalizedListingSources = listingSources.map(row =>
    normalizeContributorEntry(
      {
        ...row,
        category: "Public Listing Remarks",
        system_name: "Public Listing Remarks",
        statement:
          row.pasted_text || row.source_name || "Public listing remarks",
        source_type: "listing_source",
        source_name: row.source_name || "Public Listing Remarks",
        verification_status:
          row.review_status || "listing_claim_not_verified"
      },
      {
        propertyId,
        category: "Public Listing Remarks",
        sourceType: "listing_source",
        sourceName: "Public Listing Remarks",
        verificationStatus: "listing_claim_not_verified"
      }
    )
  );

  const normalizedPermanentHistoryRecords =
    permanentHistoryRecords.map(row => {
      const isArmls =
        normalize(row.source_name) === "armls" ||
        normalize(row.verification_status) === "listing_reported" ||
        normalize(row.history_type) === "listing_update";

      return normalizeContributorEntry(
        {
          ...row,
          category: row.history_type || "Property History Record",
          system_name: row.system_type || row.event_type || "",
          statement:
            row.statement ||
            (
              row.system_type && row.event_year
                ? `${row.system_type} update reported for ${row.event_year}`
                : "Property history record"
            ),
          event_year: row.event_year,
          event_date: row.event_date || row.created_at,
          source_type: isArmls
            ? "armls_listing_history"
            : row.history_type || "property_history_record",
          source_name:
            row.source_name || (isArmls ? "ARMLS" : "Property History"),
          verification_status:
            row.verification_status ||
            (isArmls ? "listing_reported" : "submitted")
        },
        {
          propertyId,
          category: "Property History Record",
          sourceType: isArmls
            ? "armls_listing_history"
            : "property_history_record",
          sourceName: isArmls ? "ARMLS" : "Property History",
          verificationStatus: isArmls ? "listing_reported" : "submitted"
        }
      );
    });

  return mergeUniqueRows(
    reportEntries,
    normalizedHistoryItems,
    normalizedListingSources,
    normalizedPermanentHistoryRecords
  );
}

/*
 * Structured ARMLS sold-listing fields are independent of advertising remarks.
 * Use dated input-form fields for major-system history credit only.
 * Matching is restricted to the same parcel or the exact normalized address.
 * No database writes occur here; the usual central rating save follows.
 */
async function loadSoldArmlsRatingEntries(property) {
  const parcelRaw = clean(property?.apn || property?.parcel_number);
  const parcelKey = parcelRaw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const parcelForms = new Set([parcelRaw]);
  if (/^\d{8}[A-Z]?$/.test(parcelKey)) {
    parcelForms.add(`${parcelKey.slice(0, 3)}-${parcelKey.slice(3, 5)}-${parcelKey.slice(5)}`);
  }
  const address = clean(property?.full_address || property?.address || property?.street);
  const normalized = normalizeAddress(address);
  const streetNumber = normalized.match(/^\d+/)?.[0] || "";
  const candidates = new Map();

  async function collect(filter) {
    const rows = await optionalSupabaseRequest(
      `armls_sold_properties?select=*&${filter}&limit=500`,
      { method: "GET" }
    );
    for (const row of rows) {
      if (clean(row.mls_number)) candidates.set(clean(row.mls_number), row);
    }
  }

  for (const form of parcelForms) {
    if (form) await collect(`parcel_number=eq.${encodeURIComponent(form)}`);
  }
  if (streetNumber) {
    await collect(`property_address=ilike.${encodeURIComponent(streetNumber + " %")}`);
  }

  const propertyZip = clean(property?.zip || property?.zip_code || address.match(/\b\d{5}\b/)?.[0]);
  const output = [];
  const systems = ["roof", "hvac", "electrical", "plumbing", "pool", "kitchen", "bathrooms", "flooring", "room_additions"];
  const currentYear = new Date().getFullYear();
  const seen = new Set();
  for (const sold of candidates.values()) {
    const soldParcel = clean(sold.parcel_number).toUpperCase().replace(/[^A-Z0-9]/g, "");
    const sameParcel = Boolean(parcelKey && soldParcel && parcelKey === soldParcel);
    const sameAddress = Boolean(normalized && normalizeAddress(sold.property_address) === normalized);
    if (!sameParcel && !sameAddress) continue;
    if (propertyZip && clean(sold.zip_code) && propertyZip !== clean(sold.zip_code)) continue;
    const mls = clean(sold.mls_number);
    for (const system of systems) {
      const year = Number(sold[`${system}_year`]);
      if (!Number.isInteger(year) || year < 1900 || year > currentYear + 1) continue;
      const key = `${mls}|${system}|${year}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push({
        id: `sold-mls-${key}`,
        property_id: property.id,
        category: "listing_update",
        system_name: system,
        event_year: year,
        statement: `${system} update reported for ${year}${clean(sold[system]) ? ` (${clean(sold[system])})` : ""}`,
        source_type: "armls_listing_history",
        source_name: "ARMLS",
        verification_status: "listing_reported"
      });
    }
  }
  return output;
}

async function loadRatingInput(propertyId) {
  const rows = await optionalSupabaseRequest(
    `property_rating_inputs?property_id=eq.${encodeURIComponent(propertyId)}&select=*&limit=1`,
    { method: "GET" }
  );
  return rows[0] || null;
}

async function loadRatingAdjustments(propertyId) {
  return optionalSupabaseRequest(
    `property_rating_adjustments?property_id=eq.${encodeURIComponent(propertyId)}&select=*&order=created_at.asc`,
    { method: "GET" }
  );
}

function isActiveDocument(row) {
  if (row?.deleted_at || row?.is_deleted === true) return false;

  return ![
    row?.status,
    row?.verification_status,
    row?.record_status
  ].some(value =>
    ["deleted", "archived", "rejected", "removed"].includes(normalize(value))
  );
}

async function loadPropertyDocuments(property) {
  const propertyId = clean(property?.id);
  const propertyAddress = clean(
    property?.full_address || property?.address || property?.street
  );

  const [
    propertyDocuments,
    sellerDocuments,
    contractorDocuments
  ] = await Promise.all([
    optionalSupabaseRequest(
      "property_documents?select=*&order=created_at.desc&limit=1000",
      { method: "GET" }
    ),
    optionalSupabaseRequest(
      "seller_documents?select=*&order=created_at.desc&limit=1000",
      { method: "GET" }
    ),
    optionalSupabaseRequest(
      "contractor_documents?select=*,contractor_work_submissions(property_id,property_address)&order=created_at.desc&limit=1000",
      { method: "GET" }
    )
  ]);

  const belongsToProperty = row => {
    const linkedPropertyId = clean(
      row.property_id || row.contractor_work_submissions?.property_id
    );

    if (linkedPropertyId && linkedPropertyId === propertyId) return true;

    const rowAddress = clean(
      row.property_address ||
      row.address_text ||
      row.address ||
      row.contractor_work_submissions?.property_address
    );

    return Boolean(
      propertyAddress &&
      rowAddress &&
      addressesMatch(propertyAddress, rowAddress)
    );
  };

  return mergeUniqueRows(
    propertyDocuments.filter(
      row => belongsToProperty(row) && isActiveDocument(row)
    ),
    sellerDocuments.filter(
      row => belongsToProperty(row) && isActiveDocument(row)
    ),
    contractorDocuments.filter(
      row => belongsToProperty(row) && isActiveDocument(row)
    )
  );
}

function normalizeContributorEntry(row, defaults = {}) {
  return {
    id: row.id || null,
    property_id: row.property_id || defaults.propertyId || null,
    category:
      row.category ||
      row.update_type ||
      row.work_type ||
      defaults.category ||
      "Property Record",
    system_name:
      row.system_name ||
      row.update_type ||
      row.work_type ||
      defaults.systemName ||
      "",
    event_year: row.event_year || row.year || null,
    event_date:
      row.event_date ||
      row.approximate_date ||
      row.completed_date ||
      row.created_at ||
      null,
    statement: clean(
      row.statement ||
      row.note ||
      row.description ||
      row.update_type ||
      row.work_type ||
      "Property record"
    ),
    source_type: row.source_type || defaults.sourceType || "property_record",
    source_name:
      row.source_name ||
      row.contractor ||
      row.email ||
      row.contractors?.business_name ||
      defaults.sourceName ||
      "",
    verification_status:
      row.verification_status ||
      row.record_status ||
      row.status ||
      defaults.verificationStatus ||
      "submitted",
    document_type:
      row.document_type || (row.permit_number ? "permit" : ""),
    document_url: row.document_url || row.file_url || "",
    created_at: row.created_at || null,
    updated_at: row.updated_at || row.created_at || null
  };
}

async function loadContributorEntries(property) {
  const propertyId = clean(property.id);
  const encodedId = encodeURIComponent(propertyId);
  const propertyAddress = clean(
    property.full_address || property.address || property.street
  );

  const [
    homeownerById,
    contractorById,
    allHomeownerUpdates,
    allContractorWork
  ] = await Promise.all([
    optionalSupabaseRequest(
      `homeowner_updates?property_id=eq.${encodedId}&select=*`,
      { method: "GET" }
    ),
    optionalSupabaseRequest(
      `contractor_work_submissions?property_id=eq.${encodedId}&select=*,contractors(business_name,phone,email,license_number,insurance_status)`,
      { method: "GET" }
    ),
    optionalSupabaseRequest(
      "homeowner_updates?status=eq.active&select=*&order=created_at.desc",
      { method: "GET" }
    ),
    optionalSupabaseRequest(
      "contractor_work_submissions?select=*,contractors(business_name,phone,email,license_number,insurance_status)&order=created_at.desc",
      { method: "GET" }
    )
  ]);

  const homeownerByAddress = allHomeownerUpdates.filter(row =>
    addressesMatch(propertyAddress, row.property_address)
  );

  const contractorByAddress = allContractorWork.filter(row =>
    addressesMatch(propertyAddress, row.property_address)
  );

  const homeownerUpdates = dedupeHomeownerUpdates(
    mergeUniqueRows(homeownerById, homeownerByAddress)
  );

  const contractorWork = mergeUniqueRows(
    contractorById,
    contractorByAddress
  );

  const entries = [
    ...homeownerUpdates.map(row =>
      normalizeContributorEntry(row, {
        propertyId,
        category: "Homeowner Reported Update",
        sourceType: "homeowner_update",
        sourceName: "Homeowner",
        verificationStatus: "homeowner_submitted"
      })
    ),
    ...contractorWork.map(row =>
      normalizeContributorEntry(row, {
        propertyId,
        category: "Contractor Work Record",
        sourceType: "contractor_record",
        sourceName: "Contractor",
        verificationStatus: "contractor_submitted"
      })
    )
  ];

  return {
    entries,
    counts: {
      homeownerUpdates: homeownerUpdates.length,
      homeownerByPropertyId: homeownerById.length,
      homeownerByAddress: homeownerByAddress.length,
      contractorWork: contractorWork.length,
      contractorByPropertyId: contractorById.length,
      contractorByAddress: contractorByAddress.length
    }
  };
}

function entryText(entry) {
  return normalize(
    [
      entry.category,
      entry.system_name,
      entry.statement,
      entry.source_type,
      entry.source_name,
      entry.verification_status,
      entry.document_type
    ].filter(Boolean).join(" ")
  );
}

function documentText(document) {
  return normalize(
    [
      document.document_type,
      document.type,
      document.category,
      document.title,
      document.name,
      document.file_name,
      document.statement,
      document.note,
      document.description,
      document.system_name,
      document.source_type,
      document.source_name
    ].filter(Boolean).join(" ")
  )
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsAny(text, terms) {
  return terms.some(term => text.includes(term));
}

function hasEntryMatching(entries, terms) {
  return entries.some(entry => containsAny(entryText(entry), terms));
}

function hasDocumentMatching(documents, terms) {
  return documents.some(document =>
    containsAny(documentText(document), terms)
  );
}

function majorSystemKey(entry) {
  const text = entryText(entry);

  if (containsAny(text, [
    "hvac",
    "air conditioner",
    "air conditioning",
    "furnace",
    "heat pump"
  ])) {
    return "hvac";
  }

  if (containsAny(text, ["roof", "shingle", "underlayment"])) {
    return "roof";
  }

  if (containsAny(text, ["water heater", "tankless"])) {
    return "waterHeater";
  }

  if (containsAny(text, [
    "electrical panel",
    "electrical",
    "breaker panel",
    "breaker"
  ])) {
    return "electrical";
  }

  return "";
}

function entryHasSystemYear(entry) {
  const directYear = Number(entry?.event_year || entry?.year || 0);

  if (
    Number.isFinite(directYear) &&
    directYear >= 1900 &&
    directYear <= 2100
  ) {
    return true;
  }

  const text = clean(
    [
      entry?.statement,
      entry?.description,
      entry?.note,
      entry?.event_date,
      entry?.approximate_date,
      entry?.completed_date
    ].filter(Boolean).join(" ")
  );

  return Boolean(text.match(/\b(19\d{2}|20\d{2}|2100)\b/));
}

function entrySystemYear(entry) {
  const directYear = Number(entry?.event_year || entry?.year || 0);

  if (
    Number.isFinite(directYear) &&
    directYear >= 1900 &&
    directYear <= 2100
  ) {
    return Math.round(directYear);
  }

  const text = clean(
    [
      entry?.statement,
      entry?.description,
      entry?.note,
      entry?.event_date,
      entry?.approximate_date,
      entry?.completed_date
    ].filter(Boolean).join(" ")
  );

  const match = text.match(/\b(19\d{2}|20\d{2}|2100)\b/);
  return match ? Number(match[1]) : null;
}

function majorSystemSourceLevel(entry) {
  const sourceType = normalize(entry?.source_type);
  const sourceName = normalize(entry?.source_name);
  const verificationStatus = normalize(entry?.verification_status);
  const text = entryText(entry);

  // Advertising remarks are not structured MLS improvement fields.
  if (sourceType === "listing_source" ||
      sourceType === "public_listing_history" ||
      normalize(entry?.category).includes("public listing remarks")) {
    return { level: "other", label: "Advertising remarks — no system-year credit", points: 0 };
  }

  const homeowner =
    sourceType.includes("homeowner") ||
    sourceName.includes("homeowner") ||
    containsAny(text, [
      "homeowner submitted",
      "homeowner reported",
      "owner reported",
      "owner update"
    ]);

  if (homeowner) {
    return {
      level: "homeowner",
      label: "Homeowner reported",
      points: 5
    };
  }

  const documented =
    containsAny(verificationStatus, [
      "verified",
      "documented",
      "permit_documented",
      "contractor_documented",
      "verified_by_document"
    ]) ||
    (
      containsAny(sourceType, ["contractor_record", "permit_record"]) &&
      containsAny(text, [
        "documented",
        "verified",
        "receipt",
        "invoice",
        "permit"
      ])
    );

  if (documented) {
    return {
      level: "documented",
      label: "Documented / verified",
      points: 5
    };
  }

  const listing =
    sourceType.includes("listing") ||
    sourceType.includes("armls") ||
    sourceName.includes("armls") ||
    verificationStatus === "listing_reported" ||
    containsAny(text, [
      "armls",
      "listing claim",
      "listing update",
      "public listing history"
    ]);

  if (listing) {
    return {

         level: "armls",
      label: "ARMLS / listing reported",
      points: 5
    };
  }

  return {
    level: "other",
    label: "Other property record",
    points: 0
  };
}

function calculateMajorSystemPoints(entries) {
  const systems = {
    hvac: {
      label: "HVAC",
      maximum: 5,
      points: 0,
      source: "none",
      sourceLabel: "No year available",
      year: null,
      homeownerYear: null,
      armlsYear: null,
      documentedYear: null
    },
    roof: {
      label: "Roof",
      maximum: 5,
      points: 0,
      source: "none",
      sourceLabel: "No year available",
      year: null,
      homeownerYear: null,
      armlsYear: null,
      documentedYear: null
    },
    waterHeater: {
      label: "Water Heater",
      maximum: 5,
      points: 0,
      source: "none",
      sourceLabel: "No year available",
      year: null,
      homeownerYear: null,
      armlsYear: null,
      documentedYear: null
    },
    electrical: {
      label: "Electrical Panel",
      maximum: 5,
      points: 0,
      source: "none",
      sourceLabel: "No year available",
      year: null,
      homeownerYear: null,
      armlsYear: null,
      documentedYear: null
    }
  };

  (Array.isArray(entries) ? entries : []).forEach(entry => {
    const systemKey = majorSystemKey(entry);

    if (!systemKey || !entryHasSystemYear(entry)) return;

    const year = entrySystemYear(entry);
    const source = majorSystemSourceLevel(entry);
    const current = systems[systemKey];

    if (source.level === "homeowner") {
      current.homeownerYear = year || current.homeownerYear;
    }

    if (source.level === "armls") {
      current.armlsYear = year || current.armlsYear;
    }

    if (source.level === "documented") {
      current.documentedYear = year || current.documentedYear;
    }

    if (source.points > current.points) {
      current.points = source.points;
      current.source = source.level;
      current.sourceLabel = source.label;
      current.year = year;
    }
  });

  const score = Object.values(systems).reduce(
    (total, system) => total + Number(system.points || 0),
    0
  );

  const completedSystems = Object.values(systems).filter(
    system => Number(system.points || 0) > 0
  ).length;

  return {
    score,
    maximum: 20,
    count: completedSystems,
    systems
  };
}

function calculatePermitPoints(entries, ratingInput) {
  const permitEntries = entries.filter(entry => {
    const status = normalize(entry.verification_status);
    const type = normalize(entry.document_type);
    const text = entryText(entry);

    return (
      status === "permit_documented" ||
      type === "permit" ||
      text.includes("permit documented") ||
      text.includes("permit found")
    );
  });

  const storedPermitCount = Number(ratingInput?.permit_count);
  const storedPermitStatus = normalize(ratingInput?.permit_status);

  const storedCountUsable =
    Number.isFinite(storedPermitCount) &&
    storedPermitCount >= 0 &&
    ![
      "not_checked",
      "unavailable",
      "unsupported",
      "error"
    ].includes(storedPermitStatus);

  const count = storedCountUsable
    ? Math.round(storedPermitCount)
    : permitEntries.length;

  let observedPoints = 0;
  if (count >= 11) observedPoints = 9;
  else if (count >= 6) observedPoints = 6;
  else if (count >= 1) observedPoints = 3;

  return {
    points: 0,
    maximum: 0,
    observedPoints,
    observedMaximum: 9,
    count,
    status: storedCountUsable
      ? storedPermitStatus || "completed"
      : permitEntries.length
      ? "documented_records"
      : storedPermitStatus || "not_checked",
    source: storedCountUsable
      ? "map_public_record_input"
      : permitEntries.length
      ? "documented_property_records"
      : "none"
  };
}

function calculateHistoryScore(property, entries, ratingInput) {
  const breakdown = {};
  let coreFields = 0;

  if (clean(property.full_address || property.address || property.street)) {
    coreFields += 1;
  }
  if (property.year_built) coreFields += 1;
  if (property.living_sqft) coreFields += 1;

  if (
    clean(property.apn) ||
    (
      property.latitude !== null &&
      property.longitude !== null
    )
  ) {
    coreFields += 1;
  }

  const propertyRecordPoints =
    clean(property.full_address || property.address || property.street)
      ? 20
      : 0;

  breakdown.propertyRecord = {
    label: "Core property record available",
    score: propertyRecordPoints,
    maximum: 20,
    fieldsAvailable: coreFields
  };

  const majorSystemResult = calculateMajorSystemPoints(entries);

  breakdown.majorSystems = {
    label: "Major system years",
    score: majorSystemResult.score,
    maximum: 20,
    count: majorSystemResult.count,
    systems: majorSystemResult.systems,
    scoringRule:
      "Each system is worth 5 points when a homeowner-reported or documented/verified year is available, 5 points when a dated ARMLS/listing-reported year is available, and 0 when no year is available."
  };

  const permitResult = calculatePermitPoints(entries, ratingInput);

  breakdown.permitInformation = {
    label: "Permit information (diagnostic only)",
    score: 0,
    maximum: 0,
    observedScore: permitResult.observedPoints,
    observedMaximum: permitResult.observedMaximum,
    count: permitResult.count,
    status: permitResult.status,
    source: permitResult.source
  };

  const listingEntries = entries.filter(entry => {
    const sourceType = normalize(entry.source_type);
    return (
      sourceType.includes("listing") ||
      sourceType === "public_listing_history"
    );
  });

  breakdown.publicListingRemarks = {
    label: "Public listing remarks (diagnostic only)",
    score: 0,
    maximum: 0,
    count: listingEntries.length,
    observed: listingEntries.length > 0
  };

  const datedEntries = listingEntries.filter(
    entry => Boolean(entry.event_year || entry.event_date)
  );

  breakdown.datedInformation = {
    label: "Dated listing information (diagnostic only)",
    score: 0,
    maximum: 0,
    count: datedEntries.length,
    observed: datedEntries.length > 0
  };

  const homeownerEntries = entries.filter(entry =>
    containsAny(entryText(entry), ["homeowner", "owner update"])
  );

  const contractorEntries = entries.filter(entry =>
    containsAny(entryText(entry), ["contractor", "licensed contractor"])
  );

  const inspectorEntries = entries.filter(entry =>
    containsAny(entryText(entry), ["inspector", "inspection"])
  );

  const warrantyEntries = entries.filter(entry =>
    containsAny(entryText(entry), [
      "home warranty",
      "warranty company",
      "insurance claim",
      "insurance company"
    ])
  );

  breakdown.contributorRecords = {
    label: "Contributor records (diagnostic only)",
    score: 0,
    maximum: 0,
    counts: {
      homeowner: homeownerEntries.length,
      contractor: contractorEntries.length,
      inspector: inspectorEntries.length,
      warrantyOrInsurance: warrantyEntries.length
    }
  };

  const score = clamp(
    propertyRecordPoints + majorSystemResult.score,
    0,
    40
  );

  return { score, maximum: 40, breakdown };
}

function calculateDocumentScore(entries, documents) {
  const documentedEntries = entries
    .filter(isActiveDocument)
    .filter(entry => {
      const status = normalize(entry.verification_status);

      return Boolean(
        clean(
          entry.document_url ||
          entry.file_url ||
          entry.storage_path
        ) ||
        (
          status === "uploaded" &&
          /\.(pdf|png|jpe?g|webp)\b/i.test(
            [
              entry.file_name,
              entry.title,
              entry.name,
              entry.statement
            ].filter(Boolean).join(" ")
          )
        ) ||
        [
          "verified",
          "verified_by_document",
          "document_uploaded",
          "documentation_mentioned",
          "permit_documented",
          "contractor_documented"
        ].includes(status)
      );
    });

  const combinedDocuments = [
    ...documents.filter(isActiveDocument),
    ...documentedEntries
  ];

  const rules = [
    {
      key: "inspectionReport",
      label: "Inspection Report",
      maximum: 12,
      terms: ["inspection report", "home inspection", "inspection page"]
    },
    {
      key: "sellerDisclosure",
      label: "Seller Property Disclosure",
      maximum: 12,
      terms: ["seller disclosure", "spds", "property disclosure"]
    },
    {
      key: "workRepairReceipts",
      label: "Work / Repair Receipts",
      maximum: 10,
      terms: ["receipt", "invoice", "repair record", "work order"]
    },
    {
      key: "hoaDocuments",
      label: "HOA Documents",
      maximum: 6,
      terms: ["hoa document", "homeowners association", "cc&r", "ccrs"]
    },
    {
      key: "surveySitePlan",
      label: "Survey / Site Plan",
      maximum: 6,
      terms: ["survey", "site plan", "property sketch"]
    },
    {
      key: "hvacMaintenanceReceipt",
      label: "HVAC Maintenance Receipt",
      maximum: 4,
      terms: [
        "hvac maintenance",
        "air conditioning service",
        "furnace service"
      ]
    },
    {
      key: "newHvacSystemReceipt",
      label: "New HVAC System Receipt",
      maximum: 5,
      terms: [
        "hvac replacement",
        "new hvac",
        "air conditioner replacement",
        "furnace replacement"
      ]
    },
    {
      key: "poolEquipmentWork",
      label: "Pool Equipment / Work",
      maximum: 3,
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
    const found = hasDocumentMatching(combinedDocuments, rule.terms);

    breakdown[rule.key] = {
      label: rule.label,
      score: found ? rule.maximum : 0,
      maximum: rule.maximum,
      found
    };
  });

  // Coverage credit supplements document-type credit.
  // Only the best available evidence per system counts.
  // Uploaded files are supporting evidence, not independent verification.
  const coverageRules = [
    {
      key: "roofEvidence",
      label: "Roof evidence",
      terms: ["roof", "roofing"],
      maximum: 6
    },
    {
      key: "hvacEvidence",
      label: "HVAC evidence",
      terms: [
        "hvac",
        "heating",
        "cooling",
        "air conditioner",
        "air conditioning",
        "furnace"
      ],
      maximum: 6
    },
    {
      key: "electricalEvidence",
      label: "Electrical / panel evidence",
      terms: [
        "electrical",
        "wiring",
        "panel upgraded",
        "panel replacement"
      ],
      maximum: 6
    },
    {
      key: "plumbingEvidence",
      label: "Plumbing evidence",
      terms: ["plumbing", "plmbg", "supply pipe", "supply line"],
      maximum: 6
    },
    {
      key: "sewerEvidence",
      label: "Sewer / drain evidence",
      terms: ["sewer", "drain line", "sewer line"],
      maximum: 6
    },
    {
      key: "waterHeaterEvidence",
      label: "Water heater evidence",
      terms: ["water heater", "tankless"],
      maximum: 6
    },
    {
      key: "windowsDoorsEvidence",
      label: "Windows / doors evidence",
      terms: ["window", "windows", "door", "doors"],
      maximum: 6
    },
    {
      key: "solarEvidence",
      label: "Solar documentation",
      terms: ["solar", "photovoltaic", "lightreach", "powerwall"],
      maximum: 4
    },
    {
      key: "poolEvidence",
      label: "Pool evidence",
      terms: ["pool", "pool pump"],
      maximum: 4
    }
  ];

  const supportedStatuses = [
    "documented",
    "verified",
    "verified_by_document",
    "permit_documented",
    "contractor_documented",
    "document_uploaded"
  ];

  const fileStatuses = [
    "uploaded",   

        "document_uploaded",
    "verified_by_document"
  ];

  const evidenceRows = [
    ...documents.filter(isActiveDocument).map(row => ({
      row,
      fromDocumentTable: true
    })),
    ...entries.filter(isActiveDocument).map(row => ({
      row,
      fromDocumentTable: false
    }))
  ];

  const matchTerms = (text, terms) =>
    terms.some(term =>
      (" " + text + " ").includes(" " + term + " ")
    );

  const textOf = values =>
    normalize(values.filter(Boolean).join(" "))
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  coverageRules.forEach(rule => {
    let best = 0;
    let evidenceLevel = "none";

    evidenceRows.forEach(({ row, fromDocumentTable }) => {
      const status = normalize(
        row.verification_status || row.record_status || row.status
      );

      const hasFile = Boolean(
        fromDocumentTable ||
        clean(row.document_url || row.file_url || row.storage_path) ||
        (
          fileStatuses.includes(status) &&
          /\.(pdf|png|jpe?g|webp)\b/i.test(
            [
              row.file_name,
              row.title,
              row.name,
              row.statement
            ].filter(Boolean).join(" ")
          )
        )
      );

      const supported = supportedStatuses.includes(status);
      if (!hasFile && !supported) return;

      // Prefer explicit system/category information.
      // Company names are not used to identify a system.
      const explicit = textOf([
        row.category,
        row.system_name,
        row.system_type
      ]);

      const namedSystems = coverageRules.filter(candidate =>
        matchTerms(explicit, candidate.terms)
      );

      const description = textOf([
        row.file_name,
        row.title,
        row.name,
        row.statement,
        row.description,
        row.note
      ]);

      const matches = namedSystems.length
        ? namedSystems.some(candidate => candidate.key === rule.key)
        : matchTerms(description, rule.terms);

      if (!matches) return;

      const points = hasFile ? rule.maximum : rule.maximum / 2;

      if (points > best) {
        best = points;
        evidenceLevel = hasFile
          ? "supporting_file_available"
          : "marked_documented_without_linked_file";
      }
    });

    breakdown[rule.key] = {
      label: rule.label,
      score: best,
      maximum: rule.maximum,
      found: best > 0,
      evidenceLevel,
      note:
        "Best available evidence per system; duplicate records add no coverage points."
    };
  });

  const score = clamp(
    Object.values(breakdown).reduce(
      (total, item) => total + Number(item.score || 0),
      0
    ),
    0,
    60
  );

  return { score, maximum: 60, breakdown };
}

function buildImprovementItems(historyResult, documentResult) {
  const items = [];
  const history = historyResult.breakdown;
  const documents = documentResult.breakdown;

  if (history.majorSystems.score < history.majorSystems.maximum) {
    const missingSystems = Object.values(
      history.majorSystems.systems || {}
    )
      .filter(system => Number(system?.points || 0) < 5)
      .map(system => system?.label)
      .filter(Boolean);

    items.push(
      missingSystems.length
        ? `Add or confirm homeowner years for: ${missingSystems.join(", ")}.`
        : "Add or confirm homeowner years for the four major systems."
    );
  }

  if (!documents.inspectionReport.found) {
    items.push("Upload an available inspection report.");
  }

  if (!documents.sellerDisclosure.found) {
    items.push("Upload the seller property disclosure when available.");
  }

  if (!documents.workRepairReceipts.found) {
    items.push("Upload available repair receipts, invoices, or warranties.");
  }

  return items;
}

async function saveRating(propertyId, rating) {
  const now = new Date().toISOString();

  const previousRows = await optionalSupabaseRequest(
    `property_ratings?property_id=eq.${encodeURIComponent(propertyId)}&select=*&limit=1`,
    { method: "GET" }
  );

  const previous = previousRows[0] || null;

  const payload = {
    property_id: propertyId,
    disclosure_rating: rating.score,
    rating_level: rating.band,
    base_rating: rating.baseRating,
    history_score: rating.historyScore,
    document_score: rating.documentScore,
    rating_breakdown: rating.breakdown,
    rating_improvement_items: rating.improvementItems,
    formula_version: RATING_VERSION,
    calculated_by: "central-server",
    rating_input_counts: rating.inputCounts,
    adjustment_total: rating.adjustmentTotal,
    source_status: "calculated",
    calculated_at: now,
    updated_at: now
  };

  const rows = await supabaseRequest(
    "property_ratings?on_conflict=property_id",
    {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=representation"
      },
      body: JSON.stringify(payload)
    }
  );

  const saved = Array.isArray(rows) ? rows[0] || null : null;
  const previousRating = previous
    ? Number(previous.disclosure_rating)
    : null;

  if (
    saved &&
    (
      previousRating === null ||
      previousRating !== rating.score
    )
  ) {
    await supabaseRequest("rating_audit_log", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        property_id: propertyId,
        previous_rating: previousRating,
        new_rating: rating.score,
        points_changed:
          previousRating === null
            ? rating.score
            : rating.score - previousRating,
        source_type: "central_recalculation",
        source_record_id: null,
        reason:
          "Authoritative property rating recalculated from current stored inputs.",
        formula_version: RATING_VERSION,
        created_at: now
      })
    });
  }

  const propertyRows = await supabaseRequest(
    `properties?id=eq.${encodeURIComponent(propertyId)}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        current_rating: rating.score,
        rating_band: rating.band,
        rating_version: RATING_VERSION,
        rating_calculated_by: "central-server",
        rating_updated_at: now
      })
    }
  );

  const updatedProperty = Array.isArray(propertyRows)
    ? propertyRows[0] || null
    : propertyRows;

  return {
    ratingRecord: saved,
    property: updatedProperty
  };
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Allow", "POST, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed. Use POST."
    });
  }

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({
      success: false,
      error: "Supabase server environment variables are not configured."
    });
  }

  try {
    const internalKey = clean(
      req.headers["x-bluevera-internal-key"]
    );

    const user =
      internalKey &&
      INTERNAL_API_KEY &&
      internalKey === INTERNAL_API_KEY
        ? { id: "bluevera-internal-server" }
        : await verifySupabaseUser(req);

    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body || {};

    const property = await findProperty({
      propertyId: body.propertyId || body.property_id,
      address: body.address || body.fullAddress
    });

    if (!property?.id) {
      return res.status(404).json({
        success: false,
        error: "The property record was not found."
      });
    }

    const [
      reportEntries,
      contributorResult,
      documents,
      ratingInput,
      adjustments,
      soldArmlsEntries
    ] = await Promise.all([
      loadPropertyEntries(property.id),
      loadContributorEntries(property),
      loadPropertyDocuments(property),
      loadRatingInput(property.id),
      loadRatingAdjustments(property.id),
      loadSoldArmlsRatingEntries(property)
    ]);

    const entries = [
      ...reportEntries,
      ...contributorResult.entries,
      ...soldArmlsEntries
    ];

    const historyResult = calculateHistoryScore(
      property,
      entries,
      ratingInput
    );

    const documentResult = calculateDocumentScore(
      entries,
      documents
    );

    const finalHistoryScore = clamp(historyResult.score, 0, 40);
    const finalDocumentScore = clamp(documentResult.score, 0, 60);

    const baseRating = clamp(
      finalHistoryScore + finalDocumentScore,
      0,
      100
    );

    const adjustmentTotal = (
      Array.isArray(adjustments) ? adjustments : []
    ).reduce(
      (total, row) => total + Number(row.adjustment_points || 0),
      0
    );

    const finalScore = clamp(
      baseRating + adjustmentTotal,
      0,
      100
    );

    const improvementItems = buildImprovementItems(
      historyResult,
      documentResult
    );

    const sourceCounts = entries.reduce((counts, entry) => {
      const source = normalize(
        entry.source_type || "unknown"
      ).replace(/[^a-z0-9]+/g, "_");

      counts[source] = (counts[source] || 0) + 1;
      return counts;
    }, {});

    const rating = {
      score: finalScore,
      baseRating,
      adjustmentTotal,
      band: ratingBand(finalScore),
      historyScore: finalHistoryScore,
      documentScore: finalDocumentScore,

      breakdown: {
        publicHistory: finalHistoryScore,
        publicHistoryMax: 40,
        uploadedDocumentation: finalDocumentScore,
        uploadedDocumentationMax: 60,
        baseRating,
        adjustmentTotal,
        total: finalScore,
        totalMax: 100,

        publicHistoryDetails: {
          corePropertyRecord: historyResult.breakdown.propertyRecord,
          permitsPublicRecords:
            historyResult.breakdown.permitInformation.score,
          permitsPublicRecordsMax:
            historyResult.breakdown.permitInformation.maximum,
          permitCount:
            historyResult.breakdown.permitInformation.count,
          permitStatus:
            historyResult.breakdown.permitInformation.status,
          publicListingRemarksEntered:
            historyResult.breakdown.publicListingRemarks.score,
          remarksIncludeDates:
            historyResult.breakdown.datedInformation.score,
          majorSystemsMentioned:
            historyResult.breakdown.majorSystems.score,
          majorSystemsMax:
            historyResult.breakdown.majorSystems.maximum,
          majorSystemDetails:
            historyResult.breakdown.majorSystems.systems,
          contributorRecords:
            historyResult.breakdown.contributorRecords
        },

        uploadedDocumentationDetails: Object.fromEntries(
          Object.entries(documentResult.breakdown).map(
            ([key, value]) => [key, Number(value?.score || 0)]
          )
        ),

        history: historyResult.breakdown,
        documents: documentResult.breakdown
      },

      improvementItems,

      inputCounts: {
        reportEntries: reportEntries.length,
        soldArmlsEntries: soldArmlsEntries.length,
        contributorEntries: contributorResult.entries.length,
        homeownerUpdates: contributorResult.counts.homeownerUpdates,
        homeownerByPropertyId:
          contributorResult.counts.homeownerByPropertyId,
        homeownerByAddress:
          contributorResult.counts.homeownerByAddress,
        contractorWork: contributorResult.counts.contractorWork,
        contractorByPropertyId:
          contributorResult.counts.contractorByPropertyId,
        contractorByAddress:
          contributorResult.counts.contractorByAddress,
        propertyDocuments: documents.length,
        permitCount: historyResult.breakdown.permitInformation.count,
        permitStatus: historyResult.breakdown.permitInformation.status,
        adjustments:
          Array.isArray(adjustments) ? adjustments.length : 0,
        sourceTypes: sourceCounts
      }
    };

    const savedRating = await saveRating(property.id, rating);

    return res.status(200).json({
      success: true,
      propertyId: property.id,
      calculatedBy: "central-server",
      ratingVersion: RATING_VERSION,
      rating: rating.score,
      band: rating.band,
      historyScore: rating.historyScore,
      documentScore: rating.documentScore,
      breakdown: rating.breakdown,
      improvementItems: rating.improvementItems,
      inputCounts: rating.inputCounts,
      property: savedRating.property,
      ratingRecord: savedRating.ratingRecord,
      calculatedForUser: user.id
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
      /authentication|session|token|expired/i.test(message)
        ? 401
        : 500;

    return res.status(status).json({
      success: false,
      error: message
    });
  }
}
    

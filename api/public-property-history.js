import {
  searchProperties,
  loadPropertyEvidence
} from "../lib/property-evidence.js";

const SUPABASE_URL = String(
  process.env.SUPABASE_URL || ""
).replace(/\/+$/, "");

const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  "";

function clean(value) {
  return String(value ?? "").trim();
}

function cleanUuid(value) {
  const text = clean(value);

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    text
  )
    ? text
    : "";
}

function applyCors(res) {
  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept"
  );
}

function activeEntry(entry) {
  const status = clean(
    entry?.verification_status
  ).toLowerCase();

  return ![
    "deleted",
    "archived",
    "rejected",
    "removed",
    "inactive"
  ].includes(status);
}

function sourceType(entry) {
  return clean(
    entry?.source_type
  ).toLowerCase();
}

function originalTable(entry) {
  return clean(
    entry?.original_table
  ).toLowerCase();
}

function safeText(
  value,
  maxLength = 1200
) {
  return clean(value)
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

function readableStatus(value) {
  const status = clean(value)
    .toLowerCase()
    .replace(/[_-]+/g, " ");

  if (
    status.includes("verified")
  ) {
    return "Verified";
  }

  if (
    status.includes("document")
  ) {
    return "Documented";
  }

  if (
    status.includes("owner reported") ||
    status.includes("homeowner submitted")
  ) {
    return "Homeowner Reported";
  }

  if (
    status.includes("contractor submitted")
  ) {
    return "Contractor Submitted";
  }

  if (
    status.includes("listing")
  ) {
    return "Listing Information";
  }

  if (
    status.includes("uploaded")
  ) {
    return "Document Uploaded";
  }

  if (
    status.includes("recorded")
  ) {
    return "Recorded";
  }

  return status
    ? status.replace(
        /\b\w/g,
        letter =>
          letter.toUpperCase()
      )
    : "Recorded";
}

function displayDate(entry) {
  if (entry?.event_year) {
    return String(
      entry.event_year
    );
  }

  const value =
    entry?.event_date ||
    entry?.created_at ||
    entry?.updated_at;

  if (!value) {
    return "";
  }

  const parsed =
    new Date(value);

  if (
    Number.isNaN(
      parsed.getTime()
    )
  ) {
    return safeText(
      value,
      80
    );
  }

  return parsed.toLocaleDateString(
    "en-US",
    {
      year: "numeric",
      month: "short"
    }
  );
}

function publicTimelineEntry(entry) {
  const type =
    sourceType(entry);

  let sourceLabel =
    "BlueVera Property Record";

  if (
    type ===
    "homeowner_update"
  ) {
    sourceLabel =
      "Homeowner Update";
  } else if (
    type ===
      "contractor_record" ||
    type ===
      "contractor_document"
  ) {
    sourceLabel =
      "Contractor Record";
  } else if (
    [
      "public_listing_history",
      "listing_update",
      "listing",
      "listing_claim",
      "mls_listing"
    ].includes(type)
  ) {
    sourceLabel =
      "Listing Information";
  } else if (
    type ===
      "seller_document"
  ) {
    sourceLabel =
      "Seller Document";
  } else if (
    type ===
      "property_document"
  ) {
    sourceLabel =
      "Property Document";
  }

  return {
    id:
      entry.id,

    title:
      safeText(
        entry.system_name ||
        entry.category ||
        "Property update",
        180
      ),

    category:
      safeText(
        entry.category ||
        "Property Record",
        180
      ),

    system:
      safeText(
        entry.system_name,
        180
      ),

    date:
      displayDate(entry),

    year:
      entry.event_year ||
      null,

    summary:
      safeText(
        entry.statement ||
        "Property record available.",
        1200
      ),

    sourceType:
      type,

    sourceLabel,

    sourceName:
      safeText(
        entry.source_name,
        180
      ),

    verificationStatus:
      clean(
        entry.verification_status
      ),

    verificationLabel:
      readableStatus(
        entry.verification_status
      ),

    documentType:
      safeText(
        entry.document_type,
        120
      ),

    createdAt:
      entry.created_at ||
      null,

    updatedAt:
      entry.updated_at ||
      null
  };
}


/* =========================================================
   HOMEOWNER HISTORY CLASSIFICATION + DEDUPLICATION
   ========================================================= */

function isHomeownerEntry(entry) {
  const type =
    sourceType(entry);

  const table =
    originalTable(entry);

  const sourceName =
    clean(
      entry?.source_name
    ).toLowerCase();

  const verification =
    clean(
      entry?.verification_status
    ).toLowerCase();

  const text =
    [
      entry?.category,
      entry?.system_name,
      entry?.statement,
      entry?.source_type,
      entry?.source_name,
      entry?.verification_status
    ]
      .map(clean)
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

  return (
    type ===
      "homeowner_update" ||
    type.includes(
      "homeowner"
    ) ||
    table ===
      "homeowner_updates" ||
    sourceName.includes(
      "homeowner"
    ) ||
    verification.includes(
      "homeowner"
    ) ||
    verification.includes(
      "owner_reported"
    ) ||
    verification.includes(
      "owner reported"
    ) ||
    text.includes(
      "homeowner submitted"
    ) ||
    text.includes(
      "homeowner reported"
    )
  );
}

function normalizeHomeownerText(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function homeownerYear(entry) {
  const direct =
    Number(
      entry?.event_year ||
      entry?.year ||
      0
    );

  if (
    Number.isFinite(direct) &&
    direct >= 1900 &&
    direct <= 2100
  ) {
    return String(
      Math.round(direct)
    );
  }

  const text =
    [
      entry?.event_date,
      entry?.approximate_date,
      entry?.created_at,
      entry?.updated_at,
      entry?.statement,
      entry?.description,
      entry?.note
    ]
      .map(clean)
      .filter(Boolean)
      .join(" ");

  const match =
    text.match(
      /\b(19\d{2}|20\d{2}|2100)\b/
    );

  return match
    ? match[1]
    : "";
}

function homeownerSystemKey(entry) {
  const text =
    normalizeHomeownerText(
      [
        entry?.update_type,
        entry?.item_label,
        entry?.system_name,
        entry?.category,
        entry?.title,
        entry?.statement,
        entry?.description,
        entry?.note
      ]
        .map(clean)
        .filter(Boolean)
        .join(" ")
    );

  if (!text) {
    return "";
  }

  if (
    /\b(hvac|air conditioner|air conditioning|furnace|heat pump)\b/
      .test(text)
  ) {
    return "hvac";
  }

  if (
    /\b(water heater|tankless)\b/
      .test(text)
  ) {
    return "water_heater";
  }

  if (
    /\b(roof|shingle|underlayment)\b/
      .test(text)
  ) {
    return "roof";
  }

  if (
    /\b(electrical|panel|breaker)\b/
      .test(text)
  ) {
    return "electrical";
  }

  if (
    /\b(plumbing|plumber|sewer|drain|pipe|repiping|repipe)\b/
      .test(text)
  ) {
    return "plumbing";
  }

  if (
    /\b(window|windows)\b/
      .test(text)
  ) {
    return "windows";
  }

  if (
    /\b(door|doors)\b/
      .test(text)
  ) {
    return "doors";
  }

  if (
    /\b(solar|photovoltaic)\b/
      .test(text)
  ) {
    return "solar";
  }

  if (
    /\b(appliance|appliances|dishwasher|range|oven|refrigerator)\b/
      .test(text)
  ) {
    return "appliances";
  }

  if (
    /\b(pest|termite)\b/
      .test(text)
  ) {
    return "pest";
  }

  if (
    /\b(pool|spa)\b/
      .test(text)
  ) {
    return "pool";
  }

  if (
    /\b(kitchen)\b/
      .test(text)
  ) {
    return "kitchen";
  }

  if (
    /\b(bathroom|bath)\b/
      .test(text)
  ) {
    return "bathroom";
  }

  if (
    /\b(floor|flooring|tile|carpet)\b/
      .test(text)
  ) {
    return "flooring";
  }

  if (
    /\b(irrigation|landscape|landscaping)\b/
      .test(text)
  ) {
    return "landscaping";
  }

  return normalizeHomeownerText(
    entry?.update_type ||
    entry?.item_label ||
    entry?.system_name ||
    entry?.category ||
    entry?.title ||
    ""
  );
}

function homeownerLinkedId(entry) {
  const table =
    originalTable(entry);

  const explicitLinkedId =
    clean(
      entry?.homeowner_update_id ||
      entry?.homeownerUpdateId ||
      entry?.source_record_id ||
      entry?.sourceRecordId ||
      entry?.original_record_id ||
      entry?.originalRecordId ||
      entry?.original_id ||
      entry?.originalId
    );

  if (explicitLinkedId) {
    return explicitLinkedId;
  }

  if (
    table ===
      "homeowner_updates"
  ) {
    return clean(
      entry?.id
    );
  }

  return "";
}

function homeownerEntryRank(entry) {
  const title =
    normalizeHomeownerText(
      entry?.item_label ||
      entry?.update_type ||
      entry?.system_name ||
      entry?.category ||
      ""
    );

  const statement =
    normalizeHomeownerText(
      entry?.statement ||
      entry?.description ||
      entry?.note ||
      ""
    );

  const eventDate =
    clean(
      entry?.event_date ||
      entry?.approximate_date ||
      ""
    );

  let score = 0;

  if (
    homeownerLinkedId(entry)
  ) {
    score += 100;
  }

  if (
    eventDate &&
    !/^\d{4}$/.test(eventDate)
  ) {
    score += 20;
  }

  if (
    title.split(" ").length > 1
  ) {
    score += 10;
  }

  score += Math.min(
    statement.length,
    200
  ) / 20;

  return score;
}

function dedupeHomeownerEntries(entries) {
  const linkedGroups =
    new Map();

  const unlinked = [];

  (
    Array.isArray(entries)
      ? entries
      : []
  ).forEach(entry => {
    const linkedId =
      homeownerLinkedId(entry);

    if (linkedId) {
      const key =
        `linked:${linkedId}`;

      const existing =
        linkedGroups.get(key);

      if (
        !existing ||
        homeownerEntryRank(entry) >
          homeownerEntryRank(existing)
      ) {
        linkedGroups.set(
          key,
          entry
        );
      }

      return;
    }

    unlinked.push(entry);
  });

  const semanticGroups =
    new Map();

  unlinked.forEach(entry => {
    const system =
      homeownerSystemKey(entry);

    const year =
      homeownerYear(entry);

    const fallbackLabel =
      normalizeHomeownerText(
        entry?.item_label ||
        entry?.update_type ||
        entry?.system_name ||
        entry?.category ||
        entry?.title ||
        entry?.statement ||
        "homeowner update"
      );

    const key =
      system && year
        ? `semantic:${system}|${year}`
        : `semantic:${fallbackLabel}|${year}`;

    const existing =
      semanticGroups.get(key);

    if (
      !existing ||
      homeownerEntryRank(entry) >
        homeownerEntryRank(existing)
    ) {
      semanticGroups.set(
        key,
        entry
      );
    }
  });

  return [
    ...linkedGroups.values(),
    ...semanticGroups.values()
  ];
}


/* =========================================================
   OTHER HISTORY TYPES
   ========================================================= */

function isContractorEntry(entry) {
  const type =
    sourceType(entry);

  const table =
    originalTable(entry);

  return (
    type ===
      "contractor_record" ||
    type ===
      "contractor_document" ||
    table ===
      "contractor_work_submissions" ||
    table ===
      "contractor_documents"
  );
}

function isListingEntry(entry) {
  const type =
    sourceType(entry);

  return [
    "public_listing_history",
    "listing_update",
    "listing",
    "listing_claim",
    "mls_listing"
  ].includes(type);
}

function isMaintenanceEntry(entry) {
  const type =
    sourceType(entry);

  return [
    "maintenance",
    "maintenance_record",
    "home_maintenance",
    "service_record"
  ].includes(type);
}

function uniqueEntries(entries) {
  const rows =
    new Map();

  entries.forEach(entry => {
    const key =
      clean(entry.id) ||
      [
        clean(entry.title),
        clean(entry.date),
        clean(entry.summary),
        clean(entry.sourceLabel)
      ].join("|");

    if (!rows.has(key)) {
      rows.set(
        key,
        entry
      );
    }
  });

  return Array.from(
    rows.values()
  );
}


/* =========================================================
   PROPERTY LOOKUP
   ========================================================= */

async function resolvePropertyId(
  req
) {
  const requestedId =
    cleanUuid(
      req.query.propertyId ||
      req.query.property_id
    );

  if (requestedId) {
    return requestedId;
  }

  const address =
    clean(
      req.query.address
    );

  if (!address) {
    return "";
  }

  const results =
    await searchProperties(
      address,
      {
        supabaseUrl:
          SUPABASE_URL,

        serviceKey:
          SERVICE_KEY
      }
    );

  if (
    !Array.isArray(results) ||
    !results.length
  ) {
    return "";
  }

  return clean(
    results[0]?.id
  );
}


/* =========================================================
   API HANDLER
   ========================================================= */

export default async function handler(
  req,
  res
) {
  applyCors(res);

  res.setHeader(
    "Content-Type",
    "application/json"
  );

  res.setHeader(
    "Cache-Control",
    "no-store, max-age=0"
  );

  res.setHeader(
    "X-Content-Type-Options",
    "nosniff"
  );

  if (
    req.method ===
    "OPTIONS"
  ) {
    return res
      .status(204)
      .end();
  }

  if (
    req.method !==
    "GET"
  ) {
    res.setHeader(
      "Allow",
      "GET, OPTIONS"
    );

    return res
      .status(405)
      .json({
        success: false,
        error:
          "Method not allowed."
      });
  }

  if (
    !SUPABASE_URL ||
    !SERVICE_KEY
  ) {
    return res
      .status(500)
      .json({
        success: false,

        error:
          "Supabase server environment variables are not configured."
      });
  }

  try {
    const propertyId =
      await resolvePropertyId(req);

    if (!propertyId) {
      return res
        .status(404)
        .json({
          success: false,

          error:
            "The central property record was not found."
        });
    }

    const result =
      await loadPropertyEvidence(
        {
          propertyId,

          includePrivateFields:
            false,

          includeAdjustments:
            false,

          includeDocuments:
            true
        },

        {
          supabaseUrl:
            SUPABASE_URL,

          serviceKey:
            SERVICE_KEY
        }
      );

    const rawEntries =
      Array.isArray(
        result.entries
      )
        ? result.entries.filter(
            activeEntry
          )
        : [];

    const timeline =
      uniqueEntries(
        rawEntries.map(
          publicTimelineEntry
        )
      );

    /*
     * Homeowner records are cleaned before they are
     * exposed publicly.
     *
     * This prevents a homeowner_updates row and its
     * matching property-history/evidence row from being
     * counted as two separate homeowner updates.
     */
    const homeownerEntries =
      dedupeHomeownerEntries(
        rawEntries.filter(
          isHomeownerEntry
        )
      );

    const homeownerUpdates =
      uniqueEntries(
        homeownerEntries.map(
          publicTimelineEntry
        )
      );

    const contractorRecords =
      uniqueEntries(
        rawEntries
          .filter(
            isContractorEntry
          )
          .map(
            publicTimelineEntry
          )
      );

    const listingItems =
      uniqueEntries(
        rawEntries
          .filter(
            isListingEntry
          )
          .map(
            publicTimelineEntry
          )
      );

    const maintenanceRecords =
      uniqueEntries(
        rawEntries
          .filter(
            isMaintenanceEntry
          )
          .map(
            publicTimelineEntry
          )
      );

    return res
      .status(200)
      .json({
        success: true,

        property:
          result.property,

        counts: {
          timeline:
            timeline.length,

          homeownerUpdates:
            homeownerUpdates.length,

          contractorUpdates:
            contractorRecords.length,

          listingUpdates:
            listingItems.length,

          maintenanceRecords:
            maintenanceRecords.length
        },

        evidenceCounts:
          result.evidenceCounts ||
          {},

        timeline,
        homeownerUpdates,
        contractorRecords,
        listingItems,
        maintenanceRecords
      });
  } catch (error) {
    console.error(
      "Public property history error:",
      error
    );

    return res
      .status(500)
      .json({
        success: false,

        error:
          error?.message ||
          "The public property history could not be loaded."
      });
  }
}

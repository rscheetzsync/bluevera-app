const SUPABASE_URL = String(
  process.env.SUPABASE_URL || ""
).replace(/\/+$/, "");

const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  "";

const ALLOWED_ORIGINS = new Set([
  "https://bluevera.org",
  "https://www.bluevera.org",
  "https://bluevera.app",
  "https://www.bluevera.app"
]);

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

  const parts = normalized
    .split(" ")
    .filter(Boolean);

  return {
    normalized,

    number:
      parts.find(part =>
        /^\d+[a-z]?$/.test(part)
      ) || "",

    words:
      parts.filter(part =>
        !/^\d+[a-z]?$/.test(part)
      )
  };
}

function addressesMatch(
  firstValue,
  secondValue
) {
  const first = addressParts(firstValue);
  const second = addressParts(secondValue);

  if (
    !first.normalized ||
    !second.normalized
  ) {
    return false;
  }

  if (
    first.number &&
    second.number &&
    first.number !== second.number
  ) {
    return false;
  }

  if (
    first.normalized === second.normalized ||
    first.normalized.includes(
      second.normalized
    ) ||
    second.normalized.includes(
      first.normalized
    )
  ) {
    return true;
  }

  const shared = first.words.filter(
    word =>
      word.length >= 3 &&
      second.words.includes(word)
  );

  return shared.length >= 1;
}

async function readJson(response) {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function rest(path) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      method: "GET",

      headers: {
        apikey: SERVICE_KEY,

        Authorization:
          `Bearer ${SERVICE_KEY}`,

        Accept: "application/json"
      }
    }
  );

  const data = await readJson(response);

  if (!response.ok) {
    const error = new Error(
      data?.message ||
      data?.details ||
      data?.hint ||
      data?.error ||
      `Supabase request failed (${response.status})`
    );

    error.status = response.status;

    throw error;
  }

  return Array.isArray(data)
    ? data
    : [];
}

async function optionalRest(path) {
  try {
    return await rest(path);
  } catch (error) {
    console.warn(
      "Optional public property history source unavailable:",
      path,
      error?.message
    );

    return [];
  }
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
        clean(row.update_type),
        clean(row.note),
        clean(row.description)
      ].join("|");

    if (!rows.has(key)) {
      rows.set(key, row);
    }
  });

  return Array.from(rows.values());
}

function propertyAddress(property) {
  return clean(
    property?.full_address ||
    property?.address ||
    property?.street
  );
}

function propertyQuality(property) {
  return {
    calculated:
      property?.rating_updated_at &&
      property?.current_rating !== null &&
      property?.current_rating !== undefined
        ? 1
        : 0,

    updated:
      Date.parse(
        property?.rating_updated_at ||
        property?.updated_at ||
        property?.created_at ||
        ""
      ) || 0
  };
}

function preferProperty(
  first,
  second
) {
  const firstQuality =
    propertyQuality(first);

  const secondQuality =
    propertyQuality(second);

  if (
    firstQuality.calculated !==
    secondQuality.calculated
  ) {
    return secondQuality.calculated >
      firstQuality.calculated
      ? second
      : first;
  }

  return secondQuality.updated >
    firstQuality.updated
    ? second
    : first;
}

async function resolveProperty({
  propertyId,
  address
}) {
  if (propertyId) {
    const rows = await rest(
      `properties?id=eq.${encodeURIComponent(
        propertyId
      )}&select=*&limit=1`
    );

    return rows[0] || null;
  }

  const requestedAddress =
    clean(address);

  if (!requestedAddress) {
    return null;
  }

  const number =
    addressParts(
      requestedAddress
    ).number;

  const wildcard =
    number
      ? `*${number}*`
      : `*${requestedAddress}*`;

  const candidates = await rest(
    `properties?or=(` +
    `full_address.ilike.${encodeURIComponent(
      wildcard
    )},` +
    `address.ilike.${encodeURIComponent(
      wildcard
    )},` +
    `street.ilike.${encodeURIComponent(
      wildcard
    )}` +
    `)&select=*&limit=500`
  );

  const matches = candidates.filter(
    property =>
      addressesMatch(
        requestedAddress,
        propertyAddress(property)
      )
  );

  if (!matches.length) {
    return null;
  }

  const canonical = matches.reduce(
    (best, candidate) =>
      best
        ? preferProperty(
            best,
            candidate
          )
        : candidate,

    null
  );

  return canonical
    ? {
        ...canonical,

        matching_property_ids:
          matches
            .map(item => item.id)
            .filter(Boolean)
      }
    : null;
}

function activeRow(row) {
  const status = clean(
    row?.status
  ).toLowerCase();

  return ![
    "deleted",
    "archived",
    "rejected",
    "removed",
    "inactive"
  ].includes(status);
}

function safeText(
  value,
  maxLength = 1200
) {
  return clean(value)
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

function homeownerPublicRow(row) {
  return {
    id: clean(row.id),

    propertyId:
      clean(row.property_id),

    updateType:
      safeText(
        row.update_type ||
        row.item_label ||
        row.category ||
        "Homeowner update",
        180
      ),

    recordStatus:
      safeText(
        row.record_status ||
        row.verified_status ||
        row.status ||
        "owner-reported",
        80
      ),

    approximateDate:
      safeText(
        row.approximate_date ||
        row.event_date ||
        row.created_at,
        80
      ),

    contractor:
      safeText(
        row.contractor ||
        row.contractor_name,
        180
      ),

    note:
      safeText(
        row.note ||
        row.description ||
        row.update_description,
        1200
      ),

    createdAt:
      row.created_at || null,

    sourceType:
      "homeowner_update",

    sourceLabel:
      "Homeowner Update"
  };
}

function contractorPublicRow(row) {
  const contractor =
    row.contractors || {};

  return {
    id: clean(row.id),

    propertyId:
      clean(row.property_id),

    workType:
      safeText(
        row.work_type ||
        row.service_type ||
        row.category ||
        "Contractor completed work",
        180
      ),

    status:
      safeText(
        row.status ||
        "contractor-submitted",
        80
      ),

    completedDate:
      safeText(
        row.completed_date ||
        row.completed_at ||
        row.work_date ||
        row.created_at,
        80
      ),

    contractorName:
      safeText(
        contractor.business_name ||
        row.contractor_name ||
        row.business_name ||
        "Contractor",
        180
      ),

    description:
      safeText(
        row.description ||
        row.work_description ||
        row.notes,
        1200
      ),

    permitNumber:
      safeText(
        row.permit_number,
        100
      ),

    createdAt:
      row.created_at || null,

    sourceType:
      "contractor_record",

    sourceLabel:
      "Contractor Record"
  };
}

function listingPublicRow(row) {
  return {
    id: clean(row.id),

    propertyId:
      clean(row.property_id),

    category:
      safeText(
        row.category ||
        "Listing Information",
        180
      ),

    itemLabel:
      safeText(
        row.item_label ||
        row.label ||
        row.title ||
        "Listing update",
        180
      ),

    year:
      row.year || null,

    month:
      row.month || null,

    description:
      safeText(
        row.description ||
        row.statement ||
        row.note,
        1200
      ),

    verifiedStatus:
      safeText(
        row.verified_status ||
        "listing_claimed_verify",
        80
      ),

    confidenceLevel:
      safeText(
        row.confidence_level ||
        "medium",
        80
      ),

    createdAt:
      row.created_at || null,

    sourceType:
      clean(
        row.source_type ||
        "public_listing_history"
      ),

    sourceLabel:
      "Listing Information"
  };
}

function maintenancePublicRow(row) {
  return {
    id: clean(row.id),

    propertyId:
      clean(row.property_id),

    category:
      safeText(
        row.category ||
        row.item_label ||
        "Maintenance record",
        180
      ),

    itemLabel:
      safeText(
        row.item_label ||
        row.category ||
        "Maintenance record",
        180
      ),

    year:
      row.year || null,

    month:
      row.month || null,

    description:
      safeText(
        row.description ||
        row.note,
        1200
      ),

    verifiedStatus:
      safeText(
        row.verified_status ||
        row.status ||
        "recorded",
        80
      ),

    createdAt:
      row.created_at || null,

    sourceType:
      clean(
        row.source_type ||
        "maintenance"
      ),

    sourceLabel:
      "Maintenance Record"
  };
}

function dedupe(rows) {
  const found = new Map();

  rows.forEach(row => {
    const key =
      clean(row.id) ||
      JSON.stringify([
        row.updateType ||
        row.workType ||
        row.itemLabel ||
        row.category,

        row.approximateDate ||
        row.completedDate ||
        row.year,

        row.note ||
        row.description
      ]);

    if (!found.has(key)) {
      found.set(
        key,
        row
      );
    }
  });

  return Array.from(
    found.values()
  );
}

function applyCors(
  req,
  res
) {
  const origin =
    clean(req.headers.origin);

  if (
    origin &&
    ALLOWED_ORIGINS.has(origin)
  ) {
    res.setHeader(
      "Access-Control-Allow-Origin",
      origin
    );

    res.setHeader(
      "Vary",
      "Origin"
    );
  }

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );
}

export default async function handler(
  req,
  res
) {
  applyCors(req, res);

  res.setHeader(
    "Cache-Control",
    "public, max-age=0, s-maxage=60, stale-while-revalidate=300"
  );

  res.setHeader(
    "X-Content-Type-Options",
    "nosniff"
  );

  if (req.method === "OPTIONS") {
    return res
      .status(204)
      .end();
  }

  if (req.method !== "GET") {
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
          "Supabase server configuration is missing."
      });
  }

  try {
    const propertyId =
      cleanUuid(
        req.query.propertyId ||
        req.query.property_id
      );

    const address =
      clean(req.query.address);

    if (
      !propertyId &&
      !address
    ) {
      return res
        .status(400)
        .json({
          success: false,

          error:
            "A propertyId or address is required."
        });
    }

    const property =
      await resolveProperty({
        propertyId,
        address
      });

    if (!property?.id) {
      return res
        .status(404)
        .json({
          success: false,

          error:
            "The central property record was not found."
        });
    }

    const id =
      encodeURIComponent(
        property.id
      );

    const matchingPropertyIds =
      Array.isArray(
        property.matching_property_ids
      ) &&
      property.matching_property_ids.length
        ? property.matching_property_ids
        : [property.id];

    const propertyFilter =
      matchingPropertyIds.length === 1
        ? `eq.${encodeURIComponent(
            matchingPropertyIds[0]
          )}`
        : `in.(${matchingPropertyIds
            .map(value =>
              encodeURIComponent(value)
            )
            .join(",")})`;

    const [
      homeownerByProperty,
      allHomeownerRows,
      contractorByProperty,
      allContractorRows,
      historyRows,
      ratingRows
    ] =
      await Promise.all([
        optionalRest(
          `homeowner_updates` +
          `?property_id=${propertyFilter}` +
          `&select=*` +
          `&order=created_at.desc`
        ),

        optionalRest(
          `homeowner_updates` +
          `?status=eq.active` +
          `&select=*` +
          `&order=created_at.desc`
        ),

        optionalRest(
          `contractor_work_submissions` +
          `?property_id=${propertyFilter}` +
          `&select=*,contractors(business_name)` +
          `&order=created_at.desc`
        ),

        optionalRest(
          `contractor_work_submissions` +
          `?select=*,contractors(business_name)` +
          `&order=created_at.desc`
        ),

        optionalRest(
          `property_history_items` +
          `?property_id=${propertyFilter}` +
          `&select=*` +
          `&order=year.desc,created_at.desc`
        ),

        optionalRest(
          `property_current_ratings` +
          `?property_id=eq.${id}` +
          `&select=*` +
          `&limit=1`
        )
      ]);

    const centralAddress =
      propertyAddress(property);

    const homeownerByAddress =
      allHomeownerRows.filter(row =>
        addressesMatch(
          centralAddress,
          row.property_address ||
          row.address ||
          row.address_text
        )
      );

    const contractorByAddress =
      allContractorRows.filter(row =>
        addressesMatch(
          centralAddress,
          row.property_address ||
          row.address ||
          row.address_text
        )
      );

    const homeownerRows =
      mergeUniqueRows(
        homeownerByProperty,
        homeownerByAddress
      );

    const contractorRows =
      mergeUniqueRows(
        contractorByProperty,
        contractorByAddress
      );

    const listingSourceTypes =
      new Set([
        "public_listing_history",
        "listing_update",
        "listing",
        "listing_claim",
        "mls_listing"
      ]);

    const maintenanceSourceTypes =
      new Set([
        "maintenance",
        "maintenance_record",
        "home_maintenance",
        "service_record"
      ]);

    const homeownerUpdates =
      dedupe(
        homeownerRows
          .filter(activeRow)
          .map(homeownerPublicRow)
      );

    const contractorRecords =
      dedupe(
        contractorRows
          .filter(activeRow)
          .map(contractorPublicRow)
      );

    const listingItems =
      dedupe(
        historyRows
          .filter(activeRow)
          .filter(row =>
            listingSourceTypes.has(
              clean(
                row.source_type ||
                row.sourceType
              ).toLowerCase()
            )
          )
          .map(listingPublicRow)
      );

    const maintenanceRecords =
      dedupe(
        historyRows
          .filter(activeRow)
          .filter(row =>
            maintenanceSourceTypes.has(
              clean(
                row.source_type ||
                row.sourceType
              ).toLowerCase()
            )
          )
          .map(maintenancePublicRow)
      );

    const rating =
      ratingRows[0] ||
      null;

    const inputCounts =
      rating?.rating_input_counts ||
      {};

    return res
      .status(200)
      .json({
        success: true,

        property: {
          id:
            property.id,

          fullAddress:
            property.full_address ||
            property.address ||
            property.street ||
            "",

          city:
            property.city ||
            null,

          state:
            property.state ||
            null,

          zip:
            property.zip ||
            null,

          apn:
            property.apn ||
            null
        },

        counts: {
          homeownerUpdates:
            homeownerUpdates.length,

          homeownerByProperty:
            homeownerByProperty.length,

          homeownerByAddress:
            homeownerByAddress.length,

          contractorUpdates:
            contractorRecords.length,

          contractorByProperty:
            contractorByProperty.length,

          contractorByAddress:
            contractorByAddress.length,

          listingUpdates:
            listingItems.length,

          maintenanceRecords:
            maintenanceRecords.length
        },

        centralRatingInputCounts:
          inputCounts,

        homeownerUpdates,
        contractorRecords,
        listingItems,
        maintenanceRecords
      });
  } catch (error) {
    console.error(
      "public-property-history:",
      error
    );

    const status =
      Number(error?.status) >= 400 &&
      Number(error?.status) < 600
        ? Number(error.status)
        : 500;

    return res
      .status(status)
      .json({
        success: false,

        error:
          error instanceof Error
            ? error.message
            : "The public property history could not be loaded."
      });
  }
}

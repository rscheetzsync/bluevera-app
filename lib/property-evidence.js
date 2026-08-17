const DEFAULT_CONFIG = {
  supabaseUrl: "",
  serviceKey: ""
};

function clean(value) {
  return String(value ?? "").trim();
}

function getConfig(config = {}) {
  const supabaseUrl = clean(
    config.supabaseUrl ||
    DEFAULT_CONFIG.supabaseUrl
  ).replace(/\/+$/, "");

  const serviceKey = clean(
    config.serviceKey ||
    DEFAULT_CONFIG.serviceKey
  );

  if (
    !supabaseUrl ||
    !serviceKey
  ) {
    throw new Error(
      "Supabase configuration is missing from the property evidence loader."
    );
  }

  return {
    supabaseUrl,
    serviceKey
  };
}


/* =========================================================
   ADDRESS HELPERS
   ========================================================= */

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
  const normalized =
    normalizeAddress(value);

  const parts =
    normalized
      .split(" ")
      .filter(Boolean);

  const numberIndex =
    parts.findIndex(part =>
      /^\d+[a-z]?$/.test(part)
    );

  const number =
    numberIndex >= 0
      ? parts[numberIndex]
      : "";

  const directions = new Set([
    "n", "s", "e", "w",
    "ne", "nw", "se", "sw"
  ]);

  const streetTypes = new Set([
    "st", "ave", "rd", "dr", "blvd",
    "pl", "ct", "cir", "ln", "ter",
    "pkwy", "trl", "hwy", "way"
  ]);

  let direction = "";
  let streetType = "";
  const streetWords = [];

  if (numberIndex >= 0) {
    let cursor = numberIndex + 1;

    if (directions.has(parts[cursor] || "")) {
      direction = parts[cursor];
      cursor += 1;
    }

    for (
      let index = cursor;
      index < parts.length;
      index += 1
    ) {
      const part = parts[index];

      if (streetTypes.has(part)) {
        streetType = part;
        break;
      }

      if (
        directions.has(part) &&
        streetWords.length > 0
      ) {
        if (!direction) {
          direction = part;
        }

        continue;
      }

      streetWords.push(part);
    }
  }

  return {
    normalized,
    number,
    direction,
    streetName:
      streetWords.join(" "),
    streetType,
    words:
      streetWords
  };
}

function addressesMatch(
  firstAddress,
  secondAddress
) {
  const first =
    addressParts(firstAddress);

  const second =
    addressParts(secondAddress);

  /*
   * House number must be identical.
   */
  if (
    !first.number ||
    !second.number ||
    first.number !== second.number
  ) {
    return false;
  }

  /*
   * Direction is part of property identity.
   *
   * Example:
   * 1927 E Weldon Ave
   * MUST NOT match
   * 1927 W Weldon Ave
   */
  if (
    first.direction ||
    second.direction
  ) {
    if (
      !first.direction ||
      !second.direction ||
      first.direction !==
        second.direction
    ) {
      return false;
    }
  }

  /*
   * Require the complete street name.
   */
  if (
    !first.streetName ||
    !second.streetName ||
    first.streetName !==
      second.streetName
  ) {
    return false;
  }

  /*
   * If both addresses have a street type,
   * it must match.
   */
  if (
    first.streetType &&
    second.streetType &&
    first.streetType !==
      second.streetType
  ) {
    return false;
  }

  return true;
}

function propertyAddress(property) {
  return clean(
    property?.full_address ||
    property?.address ||
    property?.street
  );
}

function addressLookupPattern(value) {
  const parts =
    addressParts(value);

  if (!parts.number) {
    return "";
  }

  const streetWords =
    parts.words
      .filter(word =>
        word.length >= 3
      )
      .slice(0, 2);

  if (!streetWords.length) {
    return "";
  }

  return `*${[
    parts.number,
    ...streetWords
  ].join("*")}*`;
}

function sellerDocumentAddressPath(
  address
) {
  const pattern =
    addressLookupPattern(
      address
    );

  if (!pattern) {
    return "";
  }

  return (
    "seller_documents?" +
    `property_address=ilike.${encodeURIComponent(
      pattern
    )}` +
    "&select=*&limit=100"
  );
}


/* =========================================================
   PROPERTY MATCHING
   ========================================================= */

function propertyQuality(property) {
  const hasCalculatedRating =
    property?.rating_updated_at &&
    property?.current_rating !==
      null &&
    property?.current_rating !==
      undefined;

  const ratingTime =
    Date.parse(
      property?.rating_updated_at ||
      property?.updated_at ||
      property?.created_at ||
      ""
    ) || 0;

  return {
    calculated:
      hasCalculatedRating
        ? 1
        : 0,

    ratingTime,

    evidence:
      Number(
        property?.history_score ||
        0
      ) +
      Number(
        property?.document_score ||
        0
      )
  };
}

function preferCanonicalProperty(
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
    return (
      secondQuality.calculated >
      firstQuality.calculated
    )
      ? second
      : first;
  }

  if (
    firstQuality.ratingTime !==
    secondQuality.ratingTime
  ) {
    return (
      secondQuality.ratingTime >
      firstQuality.ratingTime
    )
      ? second
      : first;
  }

  if (
    firstQuality.evidence !==
    secondQuality.evidence
  ) {
    return (
      secondQuality.evidence >
      firstQuality.evidence
    )
      ? second
      : first;
  }

  return first;
}

function collapseDuplicateProperties(
  properties
) {
  const canonical = [];

  (
    Array.isArray(properties)
      ? properties
      : []
  ).forEach(property => {
    const address =
      propertyAddress(property);

    const duplicateIndex =
      canonical.findIndex(
        existing =>
          addressesMatch(
            address,
            propertyAddress(
              existing
            )
          )
      );

    if (
      duplicateIndex < 0
    ) {
      canonical.push(
        property
      );

      return;
    }

    canonical[
      duplicateIndex
    ] =
      preferCanonicalProperty(
        canonical[
          duplicateIndex
        ],
        property
      );
  });

  return canonical;
}


/* =========================================================
   SUPABASE REQUEST HELPERS
   ========================================================= */

async function rest(
  path,
  options = {},
  config = {}
) {
  const {
    supabaseUrl,
    serviceKey
  } = getConfig(config);

  const response =
    await fetch(
      `${supabaseUrl}/rest/v1/${path}`,
      {
        ...options,

        headers: {
          apikey:
            serviceKey,

          Authorization:
            `Bearer ${serviceKey}`,

          "Content-Type":
            "application/json",

          ...(options.headers || {})
        }
      }
    );

  const text =
    await response.text();

  let data = null;

  try {
    data =
      text
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

async function optionalRest(
  path,
  options = {},
  config = {}
) {
  try {
    const data =
      await rest(
        path,
        options,
        config
      );

    return Array.isArray(data)
      ? data
      : [];
  } catch (error) {
    console.warn(
      "Optional property evidence source unavailable:",
      path,
      error?.message
    );

    return [];
  }
}


/* =========================================================
   ROW NORMALIZATION
   ========================================================= */

function mergeUniqueRows(
  ...groups
) {
  const rows =
    new Map();

  groups
    .flat()
    .forEach(row => {
      if (!row) {
        return;
      }

      const key =
        clean(row.id) ||
        [
          clean(
            row.property_id
          ),

          clean(
            row.property_address
          ),

          clean(
            row.created_at
          ),

          clean(
            row.statement
          ),

          clean(
            row.description
          ),

          clean(
            row.note
          )
        ].join("|");

      if (
        !rows.has(key)
      ) {
        rows.set(
          key,
          row
        );
      }
    });

  return Array.from(
    rows.values()
  );
}

function dedupeHomeownerUpdates(
  rows
) {
  const unique =
    new Map();

  (
    Array.isArray(rows)
      ? rows
      : []
  ).forEach(
    (
      row,
      index
    ) => {
      const key =
        clean(
          row?.update_type ||
          row?.system_name ||
          row?.category ||
          row?.title ||
          row?.work_type
        )
          .toLowerCase()
          .replace(
            /[^a-z0-9]+/g,
            " "
          )
          .trim() ||
        `record-${clean(
          row?.id
        ) || index}`;

      const existing =
        unique.get(key);

      if (!existing) {
        unique.set(
          key,
          row
        );

        return;
      }

      const rank = item => {
        const status =
          clean(
            item?.verification_status ||
            item?.record_status ||
            item?.status
          ).toLowerCase();

        return {
          evidence:
            /verified/.test(
              status
            )
              ? 3
              : /documented|receipt|invoice|permit/.test(
                  status
                )
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

      const oldRank =
        rank(existing);

      const newRank =
        rank(row);

      if (
        newRank.evidence >
          oldRank.evidence ||
        (
          newRank.evidence ===
            oldRank.evidence &&
          newRank.time >
            oldRank.time
        )
      ) {
        unique.set(
          key,
          row
        );
      }
    }
  );

  return Array.from(
    unique.values()
  );
}

function firstValue(
  row,
  keys,
  fallback = ""
) {
  for (
    const key
    of keys
  ) {
    const value =
      row?.[key];

    if (
      value !== null &&
      value !== undefined &&
      clean(value) !== ""
    ) {
      return value;
    }
  }

  return fallback;
}

function normalizeEvidenceRow(
  row,
  defaults = {}
) {
  const statement =
    firstValue(
      row,
      [
        "statement",
        "description",
        "work_description",
        "update_description",
        "note",
        "notes",
        "details",
        "summary",
        "title",
        "document_name",
        "file_name"
      ],
      "Record available"
    );

  return {
    id:
      firstValue(
        row,
        ["id"],
        `${defaults.sourceType || "record"}-${Math.random()}`
      ),

    property_id:
      firstValue(
        row,
        ["property_id"],
        defaults.propertyId ||
        null
      ),

    category:
      firstValue(
        row,
        [
          "category",
          "record_category",
          "update_type",
          "work_type",
          "document_type"
        ],
        defaults.category ||
        "Property Record"
      ),

    system_name:
      firstValue(
        row,
        [
          "system_name",
          "system",
          "home_system",
          "trade",
          "service_type",
          "update_type",
          "work_type"
        ],
        defaults.systemName ||
        "—"
      ),

    event_year:
      firstValue(
        row,
        [
          "event_year",
          "year",
          "service_year",
          "work_year",
          "installed_year",
          "replacement_year"
        ],
        null
      ),

    event_date:
      firstValue(
        row,
        [
          "event_date",
          "service_date",
          "work_date",
          "completed_date",
          "completed_at",
          "inspection_date",
          "approximate_date"
        ],
        null
      ),

    statement:
      clean(statement),

    source_type:
      firstValue(
        row,
        ["source_type"],
        defaults.sourceType ||
        "property_record"
      ),

    source_name:
      firstValue(
        row,
        [
          "source_name",
          "business_name",
          "contractor_name",
          "homeowner_name",
          "company_name",
          "contractor",
          "email"
        ],
        defaults.sourceName ||
        ""
      ),

    verification_status:
      firstValue(
        row,
        [
          "verification_status",
          "verified_status",
          "status",
          "record_status"
        ],
        defaults.verificationStatus ||
        "submitted"
      ),

    document_type:
      firstValue(
        row,
        [
          "document_type",
          "file_type"
        ],
        defaults.documentType ||
        ""
      ),

    document_url:
      firstValue(
        row,
        [
          "document_url",
          "file_url",
          "report_url",
          "receipt_url",
          "invoice_url",
          "storage_url",
          "public_url"
        ],
        ""
      ),

    created_at:
      firstValue(
        row,
        [
          "created_at",
          "submitted_at"
        ],
        null
      ),

    updated_at:
      firstValue(
        row,
        [
          "updated_at",
          "modified_at",
          "created_at",
          "submitted_at"
        ],
        null
      ),

    original_table:
      defaults.originalTable ||
      ""
  };
}

function sortEvidenceRows(
  rows
) {
  return [
    ...rows
  ].sort(
    (
      first,
      second
    ) => {
      const firstDate =
        Date.parse(
          first.updated_at ||
          first.created_at ||
          first.event_date ||
          ""
        ) || 0;

      const secondDate =
        Date.parse(
          second.updated_at ||
          second.created_at ||
          second.event_date ||
          ""
        ) || 0;

      return (
        secondDate -
        firstDate
      );
    }
  );
}


/* =========================================================
   PUBLIC-SAFE FIELD FILTERING
   ========================================================= */

function sanitizeProperty(
  property,
  includePrivateFields
) {
  if (
    includePrivateFields
  ) {
    return property;
  }

  return {
    id:
      property.id,

    full_address:
      property.full_address ||
      property.address ||
      property.street ||
      "",

    street:
      property.street ||
      null,

    city:
      property.city ||
      null,

    state:
      property.state ||
      null,

    zip:
      property.zip ||
      null,

    county:
      property.county ||
      null,

    apn:
      property.apn ||
      null,

    year_built:
      property.year_built ||
      null,

    living_sqft:
      property.living_sqft ||
      null,

    current_rating:
      property.current_rating ??
      null,

    rating_band:
      property.rating_band ||
      null,

    history_score:
      property.history_score ??
      null,

    document_score:
      property.document_score ??
      null,

    rating_input_counts:
      property.rating_input_counts ||
      {},

    rating_updated_at:
      property.rating_updated_at ||
      null,

    rating_version:
      property.rating_version ||
      null
  };
}

function sanitizeEntry(
  entry,
  includePrivateFields
) {
  if (
    includePrivateFields
  ) {
    return entry;
  }

  return {
    id:
      entry.id,

    property_id:
      entry.property_id,

    category:
      entry.category,

    system_name:
      entry.system_name,

    event_year:
      entry.event_year,

    event_date:
      entry.event_date,

    statement:
      entry.statement,

    source_type:
      entry.source_type,

    source_name:
      sanitizeSourceName(
        entry.source_name,
        entry.source_type
      ),

    verification_status:
      entry.verification_status,

    document_type:
      entry.document_type,

    created_at:
      entry.created_at,

    updated_at:
      entry.updated_at,

    original_table:
      entry.original_table
  };
}

function sanitizeSourceName(
  sourceName,
  sourceType
) {
  const type =
    clean(
      sourceType
    ).toLowerCase();

  const name =
    clean(sourceName);

  if (
    type ===
      "homeowner_update" &&
    (
      !name ||
      name.includes("@")
    )
  ) {
    return "Homeowner";
  }

  if (
    name.includes("@")
  ) {
    return "Property Contributor";
  }

  return (
    name ||
    "BlueVera Record"
  );
}


/* =========================================================
   PROPERTY SEARCH
   ========================================================= */

export async function searchProperties(
  query,
  config = {}
) {
  const q =
    clean(query);

  if (!q) {
    return [];
  }

  const encoded =
    encodeURIComponent(
      `*${q}*`
    );

  const uuidLike =
    /^[0-9a-f-]{30,}$/i.test(
      q
    );

  let path;

  if (uuidLike) {
    path =
      "properties?or=(" +
      `id.eq.${encodeURIComponent(q)},` +
      `full_address.ilike.${encoded},` +
      `normalized_address.ilike.${encoded},` +
      `apn.ilike.${encoded}` +
      ")&select=*&limit=25";
  } else {
    path =
      "properties?or=(" +
      `full_address.ilike.${encoded},` +
      `address.ilike.${encoded},` +
      `street.ilike.${encoded},` +
      `normalized_address.ilike.${encoded},` +
      `apn.ilike.${encoded}` +
      ")&select=*&limit=25";
  }

  const rows =
    await rest(
      path,
      {
        method:
          "GET"
      },
      config
    );

  return collapseDuplicateProperties(
    Array.isArray(rows)
      ? rows
      : []
  );
}


/* =========================================================
   LOAD CENTRAL PROPERTY EVIDENCE
   ========================================================= */

export async function loadPropertyEvidence(
  options = {},
  config = {}
) {
  const propertyId =
    clean(
      options.propertyId ||
      options.property_id
    );

  if (!propertyId) {
    throw new Error(
      "A property ID is required."
    );
  }

  const includePrivateFields =
    options.includePrivateFields ===
    true;

  const includeAdjustments =
    options.includeAdjustments !==
    false;

  const includeDocuments =
    options.includeDocuments !==
    false;

  const encodedPropertyId =
    encodeURIComponent(
      propertyId
    );

  const properties =
    await rest(
      `properties?id=eq.${encodedPropertyId}&select=*&limit=1`,
      {
        method:
          "GET"
      },
      config
    );

  let property =
    Array.isArray(properties)
      ? properties[0]
      : null;

  if (!property) {
    throw new Error(
      "The central property record was not found."
    );
  }

  const ratingRows =
    await optionalRest(
      `property_current_ratings?property_id=eq.${encodedPropertyId}&select=*&limit=1`,
      {
        method:
          "GET"
      },
      config
    );

  const authoritativeRating =
    ratingRows[0] ||
    null;

  if (
    authoritativeRating
  ) {
    property = {
      ...property,

      current_rating:
        authoritativeRating
          .disclosure_rating,

      rating_band:
        authoritativeRating
          .rating_level,

      history_score:
        authoritativeRating
          .history_score,

      document_score:
        authoritativeRating
          .document_score,

      rating_breakdown:
        authoritativeRating
          .rating_breakdown,

      rating_improvement_items:
        authoritativeRating
          .rating_improvement_items,

      rating_input_counts:
        authoritativeRating
          .rating_input_counts,

      rating_version:
        authoritativeRating
          .formula_version,

      rating_updated_at:
        authoritativeRating
          .calculated_at,

      rating_source:
        "property_ratings"
    };
  }

  const propertyAddressValue =
    propertyAddress(
      property
    );

  const documentPromises =
    includeDocuments
      ? [
          optionalRest(
            `contractor_documents?property_id=eq.${encodedPropertyId}&select=*`,
            {
              method:
                "GET"
            },
            config
          ),

          optionalRest(
            `property_documents?property_id=eq.${encodedPropertyId}&select=*`,
            {
              method:
                "GET"
            },
            config
          ),

          optionalRest(
            `seller_documents?property_id=eq.${encodedPropertyId}&select=*`,
            {
              method:
                "GET"
            },
            config
          ),

          sellerDocumentAddressPath(
            propertyAddressValue
          )
            ? optionalRest(
                sellerDocumentAddressPath(
                  propertyAddressValue
                ),
                {
                  method:
                    "GET"
                },
                config
              )
            : Promise.resolve([])
        ]
      : [
          Promise.resolve([]),
          Promise.resolve([]),
          Promise.resolve([]),
          Promise.resolve([])
        ];

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
  ] =
    await Promise.all([
      optionalRest(
        `property_report_entries?property_id=eq.${encodedPropertyId}&select=*`,
        {
          method:
            "GET"
        },
        config
      ),

      includeAdjustments
        ? optionalRest(
            `property_rating_adjustments?property_id=eq.${encodedPropertyId}&select=*&order=created_at.desc`,
            {
              method:
                "GET"
            },
            config
          )
        : Promise.resolve([]),

      optionalRest(
        `homeowner_updates?property_id=eq.${encodedPropertyId}&select=*`,
        {
          method:
            "GET"
        },
        config
      ),

      optionalRest(
        `contractor_work_submissions?property_id=eq.${encodedPropertyId}&select=*,contractors(business_name,phone,email,license_number,insurance_status)`,
        {
          method:
            "GET"
        },
        config
      ),

      /*
       * Legacy homeowner records are still loaded so older
       * records without a property_id can be recovered.
       *
       * IMPORTANT:
       * rows that already have a property_id are rejected from
       * the address fallback below.
       */
      optionalRest(
        "homeowner_updates?status=eq.active&select=*&order=created_at.desc",
        {
          method:
            "GET"
        },
        config
      ),

      /*
       * Legacy contractor records are handled the same way.
       */
      optionalRest(
        "contractor_work_submissions?select=*,contractors(business_name,phone,email,license_number,insurance_status)&order=created_at.desc",
        {
          method:
            "GET"
        },
        config
      ),

      documentPromises[0],
      documentPromises[1],
      documentPromises[2],
      documentPromises[3],

      optionalRest(
        `property_history_items?property_id=eq.${encodedPropertyId}&select=*`,
        {
          method:
            "GET"
        },
        config
      )
    ]);

  /*
   * PROPERTY-ID SAFETY RULE
   *
   * Address fallback is allowed ONLY for old records that do
   * not already contain a property_id.
   *
   * If a row has a property_id belonging to another property,
   * that row can never be merged into this property.
   */
  const homeownerByAddress =
    allHomeownerUpdates.filter(
      row =>
        !clean(row.property_id) &&
        addressesMatch(
          propertyAddressValue,
          row.property_address ||
          row.address ||
          row.address_text
        )
    );

  const contractorByAddress =
    allContractorWork.filter(
      row =>
        !clean(row.property_id) &&
        addressesMatch(
          propertyAddressValue,
          row.property_address ||
          row.address ||
          row.address_text
        )
    );

  const homeownerUpdates =
    dedupeHomeownerUpdates(
      mergeUniqueRows(
        homeownerById,
        homeownerByAddress
      )
    );

  const contractorWork =
    mergeUniqueRows(
      contractorById,
      contractorByAddress
    );

  /*
   * Seller-document address fallback is also limited to
   * legacy records with no property_id.
   */
  const sellerDocumentsByAddress =
    sellerDocumentCandidates.filter(
      row =>
        !clean(row.property_id) &&
        addressesMatch(
          propertyAddressValue,
          row.property_address ||
          row.address_text ||
          row.address
        )
    );

  const sellerDocuments =
    mergeUniqueRows(
      sellerDocumentsById,
      sellerDocumentsByAddress
    );

  const entries = [
    ...reportEntries.map(
      row =>
        normalizeEvidenceRow(
          row,
          {
            propertyId:
              property.id,

            originalTable:
              "property_report_entries"
          }
        )
    ),

    ...homeownerUpdates.map(
      row =>
        normalizeEvidenceRow(
          {
            ...row,

            statement:
              row.note ||
              row.update_type ||
              "Homeowner update",

            system_name:
              row.update_type ||
              "Homeowner update",

            event_date:
              row.approximate_date ||
              row.created_at,

            source_name:
              row.contractor ||
              row.email ||
              "Homeowner",

            verification_status:
              row.record_status ||
              "homeowner_submitted"
          },
          {
            propertyId:
              property.id,

            category:
              "Homeowner Reported Update",

            sourceType:
              "homeowner_update",

            sourceName:
              "Homeowner",

            verificationStatus:
              "homeowner_submitted",

            originalTable:
              "homeowner_updates"
          }
        )
    ),

    ...contractorWork.map(
      row =>
        normalizeEvidenceRow(
          {
            ...row,

            statement:
              row.description ||
              row.work_type ||
              "Contractor work record",

            system_name:
              row.work_type ||
              "Contractor work",

            event_date:
              row.completed_date ||
              row.created_at,

            source_name:
              row.contractors
                ?.business_name ||
              row.contractor_name ||
              "Contractor",

            verification_status:
              row.status ||
              "contractor_submitted",

            document_type:
              row.permit_number
                ? "Permit reference"
                : ""
          },
          {
            propertyId:
              property.id,

            category:
              "Contractor Work Record",

            sourceType:
              "contractor_record",

            sourceName:
              "Contractor",

            verificationStatus:
              "contractor_submitted",

            originalTable:
              "contractor_work_submissions"
          }
        )
    ),

    ...contractorDocuments.map(
      row =>
        normalizeEvidenceRow(
          row,
          {
            propertyId:
              property.id,

            category:
              "Contractor Document",

            sourceType:
              "contractor_document",

            sourceName:
              "Contractor",

            verificationStatus:
              "document_uploaded",

            originalTable:
              "contractor_documents"
          }
        )
    ),

    ...propertyDocuments.map(
      row =>
        normalizeEvidenceRow(
          row,
          {
            propertyId:
              property.id,

            category:
              "Property Document",

            sourceType:
              "property_document",

            sourceName:
              "BlueVera Document",

            verificationStatus:
              "document_uploaded",

            originalTable:
              "property_documents"
          }
        )
    ),

    ...sellerDocuments.map(
      row =>
        normalizeEvidenceRow(
          row,
          {
            propertyId:
              property.id,

            category:
              "Seller Document",

            sourceType:
              "seller_document",

            sourceName:
              "Seller",

            verificationStatus:
              "document_uploaded",

            originalTable:
              "seller_documents"
          }
        )
    ),

    ...propertyHistoryItems.map(
      row =>
        normalizeEvidenceRow(
          row,
          {
            propertyId:
              property.id,

            category:
              "Property History Item",

            sourceType:
              row.source_type ||
              "property_history",

            sourceName:
              row.source_name ||
              "BlueVera",

            verificationStatus:
              row.verified_status ||
              "recorded",

            originalTable:
              "property_history_items"
          }
        )
    )
  ];

  const sortedEntries =
    sortEvidenceRows(
      entries
    );

  const adjustments =
    Array.isArray(
      adjustmentRows
    )
      ? adjustmentRows
      : [];

  const adjustmentTotal =
    adjustments.reduce(
      (
        total,
        row
      ) =>
        total +
        Number(
          row.adjustment_points ||
          0
        ),
      0
    );

  return {
    property:
      sanitizeProperty(
        property,
        includePrivateFields
      ),

    entries:
      sortedEntries.map(
        entry =>
          sanitizeEntry(
            entry,
            includePrivateFields
          )
      ),

    adjustments:
      includeAdjustments
        ? adjustments
        : [],

    adjustmentTotal:
      includeAdjustments
        ? adjustmentTotal
        : 0,

    evidenceCounts: {
      listingAndReportEntries:
        reportEntries.length,

      homeownerUpdates:
        homeownerUpdates.length,

      homeownerByPropertyId:
        homeownerById.length,

      homeownerByAddress:
        homeownerByAddress.length,

      contractorWork:
        contractorWork.length,

      contractorByPropertyId:
        contractorById.length,

      contractorByAddress:
        contractorByAddress.length,

      contractorDocuments:
        contractorDocuments.length,

      propertyDocuments:
        propertyDocuments.length,

      sellerDocuments:
        sellerDocuments.length,

      sellerDocumentsByPropertyId:
        sellerDocumentsById.length,

      sellerDocumentsByAddress:
        sellerDocumentsByAddress.length,

      propertyHistoryItems:
        propertyHistoryItems.length
    }
  };
}

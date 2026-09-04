import crypto from "crypto";

/* ============================================================
   BASIC HELPERS
============================================================ */

function clean(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  return String(value)
    .replace(/\s+/g, " ")
    .trim();
}

function digitsOnly(value) {
  return clean(value)
    .replace(/\D/g, "");
}

function normalizeApn(value) {
  return clean(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizeAddress(value) {
  return clean(value)
    .toUpperCase()
    .replace(/\./g, "")
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\bWEST\b/g, "W")
    .replace(/\bEAST\b/g, "E")
    .replace(/\bNORTH\b/g, "N")
    .replace(/\bSOUTH\b/g, "S")
    .replace(/\bAVENUE\b/g, "AVE")
    .replace(/\bSTREET\b/g, "ST")
    .replace(/\bDRIVE\b/g, "DR")
    .replace(/\bROAD\b/g, "RD")
    .replace(/\bBOULEVARD\b/g, "BLVD")
    .replace(/\bPLACE\b/g, "PL")
    .replace(/\bCOURT\b/g, "CT")
    .replace(/\bCIRCLE\b/g, "CIR")
    .replace(/\bLANE\b/g, "LN")
    .trim();
}

function toNumberOrNull(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

function toIntegerOrNull(value) {
  const number =
    toNumberOrNull(value);

  if (number === null) {
    return null;
  }

  return Math.trunc(number);
}

function safeDate(value) {
  const text =
    clean(value);

  if (!text) {
    return null;
  }

  const date =
    new Date(text);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return null;
  }

  return date
    .toISOString();
}

function isReasonableYear(value) {
  const year =
    Number(value);

  const currentYear =
    new Date()
      .getFullYear();

  return (
    Number.isInteger(year) &&
    year >= 1900 &&
    year <= currentYear + 1
  );
}

function randomUuid() {
  if (
    typeof crypto.randomUUID ===
    "function"
  ) {
    return crypto.randomUUID();
  }

  return [
    crypto.randomBytes(4)
      .toString("hex"),
    crypto.randomBytes(2)
      .toString("hex"),
    "4" +
      crypto.randomBytes(2)
        .toString("hex")
        .slice(1),
    (
      (
        parseInt(
          crypto.randomBytes(1)
            .toString("hex"),
          16
        ) &
        0x3f
      ) |
      0x80
    )
      .toString(16) +
      crypto.randomBytes(1)
        .toString("hex"),
    crypto.randomBytes(6)
      .toString("hex")
  ].join("-");
}


/* ============================================================
   SUPABASE
============================================================ */

const SUPABASE_URL =
  process.env.SUPABASE_URL;

const SUPABASE_SECRET_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY;

function getSupabaseHeaders(
  extra = {}
) {
  return {
    "Content-Type":
      "application/json",

    apikey:
      SUPABASE_SECRET_KEY,

    Authorization:
      `Bearer ${SUPABASE_SECRET_KEY}`,

    ...extra
  };
}

async function supabaseRequest(
  path,
  options = {}
) {
  const response =
    await fetch(
      `${SUPABASE_URL}/rest/v1/${path}`,
      {
        ...options,

        headers:
          getSupabaseHeaders(
            options.headers || {}
          )
      }
    );

  const text =
    await response.text();

  let data = null;

  if (text) {
    try {
      data =
        JSON.parse(text);
    } catch {
      data =
        text;
    }
  }

  if (!response.ok) {
    throw new Error(
      `Supabase ${response.status}: ${
        typeof data === "string"
          ? data
          : JSON.stringify(data)
      }`
    );
  }

  return data;
}


/* ============================================================
   SPARK / ARMLS
============================================================ */

const SPARK_BASE_URL =
  "https://replication.sparkapi.com/v1";

async function fetchSparkListing(
  mlsNumber
) {
  const SPARK_ACCESS_TOKEN =
    process.env.SPARK_ACCESS_TOKEN;

  if (!SPARK_ACCESS_TOKEN) {
    throw new Error(
      "Missing SPARK_ACCESS_TOKEN"
    );
  }

  const url =
    `${SPARK_BASE_URL}/listings` +
    `?_filter=${encodeURIComponent(
      `ListingId Eq '${mlsNumber}'`
    )}` +
    `&_limit=1`;

  const response =
    await fetch(
      url,
      {
        method:
          "GET",

        headers: {
          Authorization:
            `Bearer ${SPARK_ACCESS_TOKEN}`,

          Accept:
            "application/json"
        }
      }
    );

  const data =
    await response.json();

  if (!response.ok) {
    throw new Error(
      `Spark ${response.status}: ${JSON.stringify(
        data
      )}`
    );
  }

  const result =
    Array.isArray(data?.D?.Results)
      ? data.D.Results[0]
      : Array.isArray(data?.Results)
        ? data.Results[0]
        : null;

  if (!result) {
    return null;
  }

  return result;
}


/* ============================================================
   EXTRACT STRUCTURED ARMLS UPDATE FIELDS
============================================================ */

function flattenCustomFields(
  customFields
) {
  const result = {};

  if (
    !Array.isArray(customFields)
  ) {
    return result;
  }

  for (
    const group
    of customFields
  ) {
    if (!group) {
      continue;
    }

    const main =
      Array.isArray(group.Main)
        ? group.Main
        : [];

    for (
      const section
      of main
    ) {
      if (
        !section ||
        typeof section !== "object"
      ) {
        continue;
      }

      for (
        const [
          key,
          value
        ]
        of Object.entries(
          section
        )
      ) {
        result[key] =
          value;
      }
    }
  }

  return result;
}

function findCustomFieldValue(
  flattened,
  candidates
) {
  const entries =
    Object.entries(
      flattened
    );

  for (
    const candidate
    of candidates
  ) {
    const target =
      clean(candidate)
        .toLowerCase();

    for (
      const [
        key,
        value
      ]
      of entries
    ) {
      if (
        clean(key)
          .toLowerCase() ===
        target
      ) {
        return value;
      }
    }
  }

  return null;
}

function parseUpdateField(
  rawValue
) {
  if (
    rawValue === null ||
    rawValue === undefined
  ) {
    return null;
  }

  if (
    typeof rawValue === "number"
  ) {
    const year =
      Math.trunc(rawValue);

    if (
      isReasonableYear(year)
    ) {
      return {
        year,
        scope:
          null
      };
    }

    return null;
  }

  if (
    typeof rawValue === "string"
  ) {
    const text =
      clean(rawValue);

    if (!text) {
      return null;
    }

    const yearMatch =
      text.match(
        /\b(19\d{2}|20\d{2})\b/
      );

    const year =
      yearMatch
        ? Number(
            yearMatch[1]
          )
        : null;

    if (
      !isReasonableYear(year)
    ) {
      return null;
    }

    let scope =
      null;

    if (
      /\bfull\b/i.test(
        text
      )
    ) {
      scope =
        "Full";
    } else if (
      /\bpartial\b/i.test(
        text
      )
    ) {
      scope =
        "Partial";
    }

    return {
      year,
      scope
    };
  }

  if (
    typeof rawValue === "object"
  ) {
    const possibleYear =
      rawValue.Year ??
      rawValue.year ??
      rawValue.UpdateYear ??
      rawValue.updateYear ??
      rawValue.Value ??
      rawValue.value ??
      null;

    const possibleScope =
      rawValue.Scope ??
      rawValue.scope ??
      rawValue.UpdateScope ??
      rawValue.updateScope ??
      null;

    const year =
      toIntegerOrNull(
        possibleYear
      );

    if (
      !isReasonableYear(year)
    ) {
      return null;
    }

    let scope =
      clean(
        possibleScope
      );

    if (!scope) {
      scope =
        null;
    }

    return {
      year,
      scope
    };
  }

  return null;
}

function extractUpdates(
  customFields
) {
  const flattened =
    flattenCustomFields(
      customFields
    );

  const definitions = [
    {
      systemType:
        "flooring",

      candidates: [
        "Flooring Updated",
        "Flooring Update",
        "Flooring Year",
        "Flooring"
      ]
    },

    {
      systemType:
        "electrical",

      candidates: [
        "Electrical Updated",
        "Electrical Update",
        "Electrical Year",
        "Wiring Updated",
        "Wiring Update",
        "Wiring Year"
      ]
    },

    {
      systemType:
        "plumbing",

      candidates: [
        "Plumbing Updated",
        "Plumbing Update",
        "Plumbing Year"
      ]
    },

    {
      systemType:
        "hvac",

      candidates: [
        "HVAC Updated",
        "HVAC Update",
        "HVAC Year",
        "Heating Cooling Updated",
        "Heating/Cooling Updated"
      ]
    },

    {
      systemType:
        "roof",

      candidates: [
        "Roof Updated",
        "Roof Update",
        "Roof Year"
      ]
    },

    {
      systemType:
        "kitchen",

      candidates: [
        "Kitchen Updated",
        "Kitchen Update",
        "Kitchen Year"
      ]
    },

    {
      systemType:
        "bathrooms",

      candidates: [
        "Bath Updated",
        "Bath Update",
        "Bath Year",
        "Bathroom Updated",
        "Bathrooms Updated"
      ]
    },

    {
      systemType:
        "room_addition",

      candidates: [
        "Room Addition Updated",
        "Room Addition",
        "Addition Updated",
        "Addition Year"
      ]
    },

    {
      systemType:
        "pool",

      candidates: [
        "Pool Updated",
        "Pool Update",
        "Pool Year"
      ]
    }
  ];

  const result = {};

  for (
    const definition
    of definitions
  ) {
    const rawValue =
      findCustomFieldValue(
        flattened,
        definition.candidates
      );

    const parsed =
      parseUpdateField(
        rawValue
      );

    if (!parsed) {
      continue;
    }

    result[
      definition.systemType
    ] = {
      systemType:
        definition.systemType,

      year:
        parsed.year,

      scope:
        parsed.scope
    };
  }

  return result;
}


/* ============================================================
   SCAN ARMLS PUBLIC REMARKS

   IMPORTANT:
   - This scanner is deterministic. No outside AI is used.
   - These are listing-reported signals, normally without a year.
   - Structured ARMLS dated updates always take priority.
============================================================ */

const PUBLIC_REMARK_RULES = [
  {
    systemType: "hvac",
    category: "HVAC",
    patterns: [
      /\bnew\s+hvac\b/i,
      /\bupdated\s+hvac\b/i,
      /\breplaced\s+hvac\b/i,
      /\bnew\s+a\/c\b/i,
      /\bnew\s+ac\b/i,
      /\bupdated\s+a\/c\b/i,
      /\bupdated\s+ac\b/i,
      /\bair\s+conditioner\b/i,
      /\bcentral\s+hvac\b/i,
      /\bnew\s+furnace\b/i,
      /\bupdated\s+furnace\b/i,
      /\bheat\s+pump\b/i
    ]
  },

  {
    systemType: "plumbing",
    category: "Plumbing",
    patterns: [
      /\bnew\s+supply\s+plumbing\b/i,
      /\bupdated\s+plumbing\b/i,
      /\bnew\s+plumbing\b/i,
      /\bre[-\s]?piped\b/i,
      /\brepiped\b/i,
      /\bplumbing\s+updated\b/i
    ]
  },

  {
    systemType: "electrical",
    category: "Electrical",
    patterns: [
      /\bnew\s+electrical\b/i,
      /\bupdated\s+electrical\b/i,
      /\belectrical\s+update\b/i,
      /\bnew\s+panel\b/i,
      /\bupdated\s+panel\b/i,
      /\bbreaker\s+panel\b/i,
      /\bsubpanel\b/i,
      /\bwiring\b/i,
      /\b200[-\s]?amp\b/i,
      /\b100[-\s]?amp\b/i,
      /\b40[-\s]?amp\b/i,
      /\b50[-\s]?amp\b/i,
      /\b60[-\s]?amp\b/i,
      /\belectrical\s+service\b/i
    ]
  },

  {
    systemType: "roof",
    category: "Roof",
    patterns: [
      /\bnew\s+roof\b/i,
      /\bupdated\s+roof\b/i,
      /\broof\s+replaced\b/i,
      /\breplacement\s+roof\b/i,
      /\brehabbed\s+roof\b/i,
      /\broof\s+updated\b/i
    ]
  },

  {
    systemType: "flooring",
    category: "Flooring",
    patterns: [
      /\bbrand\s+new\s+flooring\b/i,
      /\bnew\s+flooring\b/i,
      /\bupdated\s+flooring\b/i,
      /\btile\s+flooring\b/i,
      /\bwood[-\s]?look\s+tile\b/i,
      /\bhardwood\s+floors?\b/i,
      /\boriginal\s+hardwood\b/i,
      /\brefinished\s+hardwood\b/i,
      /\bceramic\s+tile\s+flooring\b/i,
      /\blvp\b/i,
      /\bluxury\s+vinyl\b/i
    ]
  },

  {
    systemType: "kitchen",
    category: "Kitchen",
    patterns: [
      /\bupdated\s+kitchen\b/i,
      /\bnew\s+kitchen\b/i,
      /\bremodeled\s+kitchen\b/i,
      /\brenovated\s+kitchen\b/i,
      /\bchef'?s\s+kitchen\b/i,
      /\bkitchen\s+island\b/i,
      /\btile\s+backsplash\b/i,
      /\bnew\s+cabinet(?:s|ry)?\b/i,
      /\bupdated\s+cabinet(?:s|ry)?\b/i,
      /\bcabinetry\b/i,
      /\bnew\s+countertops?\b/i,
      /\bgranite\s+(?:kitchen\s+)?countertops?\b/i,
      /\bquartz\s+(?:kitchen\s+)?countertops?\b/i,
      /\bstainless\s+steel\s+appliances\b/i
    ]
  },

  {
    systemType: "bathrooms",
    category: "Bathrooms",
    patterns: [
      /\bupdated\s+bath(?:room)?s?\b/i,
      /\bremodeled\s+bath(?:room)?s?\b/i,
      /\brenovated\s+bath(?:room)?s?\b/i,
      /\bprimary\s+bath\b/i,
      /\ben[-\s]?suite\b/i,
      /\bsoaking\s+tub\b/i,
      /\bnew\s+vanit(?:y|ies)\b/i,
      /\bupdated\s+vanit(?:y|ies)\b/i,
      /\bnew\s+toilet\b/i,
      /\bupdated\s+toilet\b/i,
      /\btile\s+surround\b/i,
      /\bwalk[-\s]?in\s+shower\b/i,
      /\brain\s+shower\b/i,
      /\bglass\s+shower\s+enclosures?\b/i
    ]
  },

  {
    systemType: "room_addition",
    category: "Room Addition",
    patterns: [
      /\broom\s+addition\b/i,
      /\bhome\s+addition\b/i,
      /\badded\s+(?:room|bedroom|bathroom|living\s+space)\b/i,
      /\bguest\s+house\b/i,
      /\bcasita\b/i,
      /\badu\b/i,
      /\baccessory\s+dwelling\b/i,
      /\bconverted\s+garage\b/i,
      /\bgarage\s+conversion\b/i,
      /\bconverted\s+space\b/i,
      /\bseparate\s+living\s+area\b/i,
      /\bin[-\s]?law\s+suite\b/i,
      /\bmother[-\s]?in[-\s]?law\b/i,
      /\bdetached\s+(?:living|guest|studio|unit|quarters)\b/i
    ]
  },

  {
    systemType: "pool",
    category: "Pool",
    patterns: [
      /\bupdated\s+pool\b/i,
      /\bnew\s+pool\b/i,
      /\bpool\s+resurfaced\b/i,
      /\bresurfaced\s+pool\b/i,
      /\bpool\s+remodeled\b/i,
      /\bnew\s+spa\b/i,
      /\bupdated\s+spa\b/i,
      /\bpool\s+pump\s+replaced\b/i,
      /\bnew\s+pool\s+pump\b/i
    ]
  }
];

function scanPublicRemarks(
  publicRemarks,
  structuredUpdates = {}
) {
  const remarks =
    clean(publicRemarks);

  if (!remarks) {
    return [];
  }

  const results = [];

  for (
    const rule
    of PUBLIC_REMARK_RULES
  ) {
    /*
      No duplicate category:
      if ARMLS already supplied a structured dated update,
      do not create an undated PublicRemarks signal.
    */
    if (
      Object.prototype.hasOwnProperty.call(
        structuredUpdates,
        rule.systemType
      )
    ) {
      continue;
    }

    let matchedText = "";

    for (
      const pattern
      of rule.patterns
    ) {
      const match =
        remarks.match(
          pattern
        );

      if (
        match?.[0]
      ) {
        matchedText =
          clean(
            match[0]
          );

        break;
      }
    }

    if (!matchedText) {
      continue;
    }

    results.push({
      systemType:
        rule.systemType,

      category:
        rule.category,

      signalType:
        "listing_reported_improvement",

      statement:
        `${rule.category} improvement or feature reported in ARMLS Public Remarks`,

      matchedText
    });
  }

  return results;
}


/* ============================================================
   SAVE ARMLS PUBLIC REMARK SIGNALS
============================================================ */

async function replaceRemarkSignals({
  propertyId,
  propertyListingId,
  mlsNumber,
  signals
}) {
  /*
    These rows are derived from the CURRENT ARMLS PublicRemarks.
    They are safe to regenerate.

    Remove only ARMLS-generated public-remarks signals for this
    one property listing so stale scanner results do not remain
    after remarks are edited.
  */
  await supabaseRequest(
    "property_listing_remark_signals" +
    "?property_listing_id=eq." +
    encodeURIComponent(
      propertyListingId
    ) +
    "&source_type=eq.public_remarks" +
    "&source_name=eq.ARMLS",
    {
      method:
        "DELETE"
    }
  );

  if (!signals.length) {
    return [];
  }

  const now =
    new Date()
      .toISOString();

  const payload =
    signals.map(
      signal => ({
        property_id:
          propertyId,

        property_listing_id:
          propertyListingId,

        mls_number:
          mlsNumber,

        category:
          signal.category,

        signal_type:
          signal.signalType,

        statement:
          signal.statement,

        matched_text:
          signal.matchedText,

        source_type:
          "public_remarks",

        source_name:
          "ARMLS",

        reported_year:
          null,

        has_year:
          false,

        verification_status:
          "listing_reported",

        evidence_level:
          "source_reported",

        public_visible:
          true,

        agent_visible:
          true,

        homeowner_visible:
          false,

        updated_at:
          now
      })
    );

  const rows =
    await supabaseRequest(
      "property_listing_remark_signals",
      {
        method:
          "POST",

        headers: {
          Prefer:
            "return=representation"
        },

        body:
          JSON.stringify(
            payload
          )
      }
    );

  return Array.isArray(rows)
    ? rows
    : [];
}


/* ============================================================
   ADDRESS HELPERS
============================================================ */

function buildAddressFromFields(
  fields
) {
  const parts = [
    clean(
      fields.StreetNumber
    ),

    clean(
      fields.StreetDirPrefix
    ),

    clean(
      fields.StreetName
    ),

    clean(
      fields.StreetSuffix
    ),

    clean(
      fields.UnitNumber
    )
  ].filter(Boolean);

  return parts
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildFullAddress(
  fields
) {
  const street =
    buildAddressFromFields(
      fields
    );

  return [
    street,
    clean(fields.City),
    clean(
      fields.StateOrProvince
    ),
    clean(
      fields.PostalCode
    )
  ]
    .filter(Boolean)
    .join(", ");
}

function extractApn(
  fields
) {
  return clean(
    fields.ParcelNumber ||
    fields.TaxParcelNumber ||
    fields.AssessorParcelNumber ||
    fields.APN ||
    ""
  );
}


/* ============================================================
   CENTRAL PROPERTY MATCH
============================================================ */

async function findPropertyByApn(
  apn
) {
  const normalized =
    normalizeApn(apn);

  if (!normalized) {
    return null;
  }

  const rows =
    await supabaseRequest(
      "properties" +
      "?select=*" +
      "&apn=not.is.null" +
      "&limit=5000",
      {
        method:
          "GET"
      }
    );

  if (
    !Array.isArray(rows)
  ) {
    return null;
  }

  return (
    rows.find(row =>
      normalizeApn(
        row.apn
      ) ===
      normalized
    ) ||
    null
  );
}

async function findPropertyByAddress(
  fullAddress
) {
  const normalized =
    normalizeAddress(
      fullAddress
    );

  if (!normalized) {
    return null;
  }

  const rows =
    await supabaseRequest(
      "properties" +
      "?select=*" +
      "&limit=5000",
      {
        method:
          "GET"
      }
    );

  if (
    !Array.isArray(rows)
  ) {
    return null;
  }

  return (
    rows.find(row => {
      const candidate =
        row.full_address ||
        row.address ||
        row.street ||
        "";

      return (
        normalizeAddress(
          candidate
        ) ===
        normalized
      );
    }) ||
    null
  );
}

async function createProperty({
  fullAddress,
  street,
  city,
  state,
  zip,
  county,
  apn,
  lat,
  lng,
  yearBuilt,
  livingSqft,
  lotSqft
}) {
  const payload = {
    id:
      randomUuid(),

    full_address:
      fullAddress,

    street:
      street ||
      null,

    city:
      city ||
      null,

    state:
      state ||
      null,

    zip:
      zip ||
      null,

    county:
      county ||
      null,

    apn:
      apn ||
      null,

    lat:
      lat,

    lng:
      lng,

    year_built:
      yearBuilt,

    living_sqft:
      livingSqft,

    lot_sqft:
      lotSqft,

    created_at:
      new Date()
        .toISOString(),

    updated_at:
      new Date()
        .toISOString()
  };

  const rows =
    await supabaseRequest(
      "properties",
      {
        method:
          "POST",

        headers: {
          Prefer:
            "return=representation"
        },

        body:
          JSON.stringify(
            payload
          )
      }
    );

  return Array.isArray(rows)
    ? rows[0]
    : null;
}

async function findOrCreateProperty({
  fullAddress,
  street,
  city,
  state,
  zip,
  county,
  apn,
  lat,
  lng,
  yearBuilt,
  livingSqft,
  lotSqft
}) {
  if (apn) {
    const byApn =
      await findPropertyByApn(
        apn
      );

    if (byApn) {
      return {
        property:
          byApn,

        action:
          "matched_existing",

        matchType:
          "apn"
      };
    }
  }

  const byAddress =
    await findPropertyByAddress(
      fullAddress
    );

  if (byAddress) {
    return {
      property:
        byAddress,

      action:
        "matched_existing",

      matchType:
        "address"
    };
  }

  const created =
    await createProperty({
      fullAddress,
      street,
      city,
      state,
      zip,
      county,
      apn,
      lat,
      lng,
      yearBuilt,
      livingSqft,
      lotSqft
    });

  return {
    property:
      created,

    action:
      "created_new_property",

    matchType:
      "no_match"
  };
}


/* ============================================================
   PROPERTY LISTING
============================================================ */

async function findExistingPropertyListing({
  propertyId,
  listingKey,
  mlsNumber
}) {
  if (listingKey) {
    const rows =
      await supabaseRequest(
        "property_listings" +
        "?select=*" +
        "&listing_key=eq." +
        encodeURIComponent(
          listingKey
        ) +
        "&limit=1",
        {
          method:
            "GET"
        }
      );

    if (
      Array.isArray(rows) &&
      rows[0]
    ) {
      return rows[0];
    }
  }

  const rows =
    await supabaseRequest(
      "property_listings" +
      "?select=*" +
      "&property_id=eq." +
      encodeURIComponent(
        propertyId
      ) +
      "&mls_number=eq." +
      encodeURIComponent(
        mlsNumber
      ) +
      "&limit=1",
      {
        method:
          "GET"
      }
    );

  return (
    Array.isArray(rows)
      ? rows[0] || null
      : null
  );
}

async function savePropertyListing({
  propertyId,
  listingKey,
  mlsNumber,
  status,
  listPrice,
  listingDate,
  modificationTimestamp
}) {
  const existing =
    await findExistingPropertyListing({
      propertyId,
      listingKey,
      mlsNumber
    });

  const payload = {
    property_id:
      propertyId,

    source_type:
      "armls",

    mls_number:
      mlsNumber,

    listing_key:
      listingKey ||
      null,

    listing_status:
      status ||
      null,

    list_price:
      listPrice,

    listing_date:
      listingDate,

    modification_timestamp:
      modificationTimestamp,

    source_payload_updated_at:
      modificationTimestamp,

    updated_at:
      new Date()
        .toISOString()
  };

  if (existing) {
    const rows =
      await supabaseRequest(
        "property_listings" +
        "?id=eq." +
        encodeURIComponent(
          existing.id
        ),
        {
          method:
            "PATCH",

          headers: {
            Prefer:
              "return=representation"
          },

          body:
            JSON.stringify(
              payload
            )
        }
      );

    return {
      row:
        Array.isArray(rows)
          ? rows[0]
          : null,

      action:
        "updated_existing"
    };
  }

  const rows =
    await supabaseRequest(
      "property_listings",
      {
        method:
          "POST",

        headers: {
          Prefer:
            "return=representation"
        },

        body:
          JSON.stringify({
            id:
              randomUuid(),

            ...payload,

            created_at:
              new Date()
                .toISOString()
          })
      }
    );

  return {
    row:
      Array.isArray(rows)
        ? rows[0]
        : null,

    action:
      "created_new"
  };
}


/* ============================================================
   PERMANENT STRUCTURED HISTORY
============================================================ */

async function findExistingHistoryRecord({
  propertyId,
  mlsNumber,
  systemType,
  year
}) {
  const rows =
    await supabaseRequest(
      "property_history_records" +
      "?select=*" +
      "&property_id=eq." +
      encodeURIComponent(
        propertyId
      ) +
      "&history_type=eq.listing_update" +
      "&source_record_id=eq." +
      encodeURIComponent(
        mlsNumber
      ) +
      "&system_type=eq." +
      encodeURIComponent(
        systemType
      ) +
      "&event_year=eq." +
      encodeURIComponent(
        year
      ) +
      "&limit=1",
      {
        method:
          "GET"
      }
    );

  return (
    Array.isArray(rows)
      ? rows[0] || null
      : null
  );
}

async function saveHistoryRecord({
  propertyId,
  propertyListingId,
  mlsNumber,
  systemType,
  year,
  scope
}) {
  const existing =
    await findExistingHistoryRecord({
      propertyId,
      mlsNumber,
      systemType,
      year
    });

  if (existing) {
    return {
      action:
        "already_exists",

      row:
        existing
    };
  }

  const payload = {
    id:
      randomUuid(),

    property_id:
      propertyId,

    property_listing_id:
      propertyListingId,

    history_type:
      "listing_update",

    system_type:
      systemType,

    event_year:
      year,

    update_scope:
      scope ||
      null,

    statement:
      `${systemType} update reported for ${year}`,

    source_type:
      "listing_update",

    source_name:
      "ARMLS",

    source_record_id:
      mlsNumber,

    verification_status:
      "listing_reported",

    evidence_level:
      "source_reported",

    public_visible:
      true,

    agent_visible:
      true,

    homeowner_visible:
      false,

    created_at:
      new Date()
        .toISOString(),

    updated_at:
      new Date()
        .toISOString()
  };

  const rows =
    await supabaseRequest(
      "property_history_records",
      {
        method:
          "POST",

        headers: {
          Prefer:
            "return=representation"
        },

        body:
          JSON.stringify(
            payload
          )
      }
    );

  return {
    action:
      "created",

    row:
      Array.isArray(rows)
        ? rows[0]
        : null
  };
}


/* ============================================================
   API HANDLER
============================================================ */

export default async function handler(
  req,
  res
) {
  res.setHeader(
    "Cache-Control",
    "no-store, max-age=0"
  );

  try {
    if (
      req.method !== "GET"
    ) {
      return res
        .status(405)
        .json({
          success:
            false,

          error:
            "Method not allowed"
        });
    }

    if (
      !SUPABASE_URL ||
      !SUPABASE_SECRET_KEY
    ) {
      return res
        .status(500)
        .json({
          success:
            false,

          error:
            "Missing Supabase environment variables"
        });
    }

    const mlsNumber =
      clean(
        req.query.mls ||
        req.query.mlsNumber
      );

    if (!mlsNumber) {
      return res
        .status(400)
        .json({
          success:
            false,

          error:
            "Missing MLS number"
        });
    }

    const listing =
      await fetchSparkListing(
        mlsNumber
      );

    if (!listing) {
      return res
        .status(404)
        .json({
          success:
            false,

          error:
            "ARMLS listing not found",

          mlsNumber
        });
    }

    const fields =
      listing.StandardFields ||
      listing.standardFields ||
      {};

    const customFields =
      listing.CustomFields ||
      listing.customFields ||
      [];

    const listingKey =
      clean(
        listing.Id ||
        listing.ListingKey ||
        fields.ListingKey ||
        fields.ListingId ||
        ""
      );

    const fullAddress =
      buildFullAddress(
        fields
      );

    const street =
      buildAddressFromFields(
        fields
      );

    const city =
      clean(
        fields.City
      );

    const state =
      clean(
        fields.StateOrProvince ||
        fields.State
      );

    const zip =
      clean(
        fields.PostalCode
      );

    const county =
      clean(
        fields.CountyOrParish ||
        fields.County
      );

    const apn =
      extractApn(
        fields
      );

    const lat =
      toNumberOrNull(
        fields.Latitude
      );

    const lng =
      toNumberOrNull(
        fields.Longitude
      );

    const yearBuilt =
      toIntegerOrNull(
        fields.YearBuilt
      );

    const livingSqft =
      toIntegerOrNull(
        fields.LivingArea
      );

    const lotSqft =
      toIntegerOrNull(
        fields.LotSizeSquareFeet
      );

    const status =
      clean(
        fields.StandardStatus ||
        fields.MlsStatus
      );

    const listPrice =
      toNumberOrNull(
        fields.ListPrice
      );

    const listingDate =
      safeDate(
        fields.ListingContractDate ||
        fields.OriginalEntryTimestamp
      );

    const modificationTimestamp =
      safeDate(
        fields.ModificationTimestamp ||
        listing.ModificationTimestamp
      );

    const updates =
      extractUpdates(
        customFields
      );

    const publicRemarks =
      clean(
        fields.PublicRemarks
      );

    const remarkSignals =
      scanPublicRemarks(
        publicRemarks,
        updates
      );


    /* --------------------------------------------------------
       FIND PERMANENT BLUEVERA PROPERTY
    -------------------------------------------------------- */

    const propertyResult =
      await findOrCreateProperty({
        fullAddress,
        street,
        city,
        state,
        zip,
        county,
        apn,
        lat,
        lng,
        yearBuilt,
        livingSqft,
        lotSqft
      });

    const property =
      propertyResult.property;

    if (
      !property ||
      !property.id
    ) {
      throw new Error(
        "Could not resolve permanent BlueVera property"
      );
    }


    /* --------------------------------------------------------
       SAVE PROPERTY LISTING
    -------------------------------------------------------- */

    const propertyListingResult =
      await savePropertyListing({
        propertyId:
          property.id,

        listingKey,

        mlsNumber,

        status,

        listPrice,

        listingDate,

        modificationTimestamp
      });

    const savedListing =
      propertyListingResult.row;

    if (
      !savedListing ||
      !savedListing.id
    ) {
      throw new Error(
        "Could not save property listing"
      );
    }


    /* --------------------------------------------------------
       SAVE / REFRESH ARMLS PUBLIC REMARK SIGNALS

       Structured dated categories have already been removed
       from remarkSignals by scanPublicRemarks().
    -------------------------------------------------------- */

    const savedRemarkSignals =
      await replaceRemarkSignals({
        propertyId:
          property.id,

        propertyListingId:
          savedListing.id,

        mlsNumber,

        signals:
          remarkSignals
      });


    /* --------------------------------------------------------
       SAVE PERMANENT LISTING UPDATE HISTORY
    -------------------------------------------------------- */

    const historyResults =
      [];

    for (
      const update
      of Object.values(
        updates
      )
    ) {
      const result =
        await saveHistoryRecord({
          propertyId:
            property.id,

          propertyListingId:
            savedListing.id,

          mlsNumber,

          systemType:
            update.systemType,

          year:
            update.year,

          scope:
            update.scope
        });

      historyResults.push({
        systemType:
          update.systemType,

        year:
          update.year,

        scope:
          update.scope,

        action:
          result.action,

        id:
          result.row?.id ||
          null
      });
    }


    /* --------------------------------------------------------
       RESPONSE
    -------------------------------------------------------- */

    return res
      .status(200)
      .json({
        success:
          true,

        mode:
          "CONTROLLED_REUSABLE_LISTING_WRITE",

        mlsNumber,

        property: {
          id:
            property.id,

          action:
            propertyResult.action,

          matchType:
            propertyResult.matchType,

          fullAddress:
            property.full_address ||
            fullAddress,

          apn:
            property.apn ||
            apn,

          city:
            property.city ||
            city,

          state:
            property.state ||
            state,

          zip:
            property.zip ||
            zip
        },

        propertyListing: {
          id:
            savedListing.id,

          action:
            propertyListingResult.action,

          listingKey:
            savedListing.listing_key,

          status:
            savedListing.listing_status,

          listPrice:
            savedListing.list_price,

          modificationTimestamp:
            savedListing.modification_timestamp
        },

        updatesFound:
          Object.keys(
            updates
          ).length,

        publicRemarksAvailable:
          Boolean(
            publicRemarks
          ),

        remarkSignalsFound:
          remarkSignals.length,

        remarkSignals:
          savedRemarkSignals.map(
            row => ({
              id:
                row.id,

              category:
                row.category,

              signalType:
                row.signal_type,

              matchedText:
                row.matched_text,

              reportedYear:
                row.reported_year
            })
          ),

        historyResults,

        ratingRecalculated:
          false,

        publicMapUpdated:
          false,

        protections: {
          apnFirst:
            true,

          countyAwareIdentity:
            true,

          duplicateRaceProtection:
            true,

          ratingRecalculation:
            false,

          publicMapUpdate:
            false,

          historyDuplicateProtection:
            true,

          remarkCategoryDuplicateProtection:
            true,

          structuredUpdateWinsOverRemarks:
            true
        }
      });
  } catch (error) {
    console.error(
      "ARMLS sync listing test error:",
      error
    );

    return res
      .status(500)
      .json({
        success:
          false,

        error:
          "Server error",

        details:
          error.message
      });
  }
}

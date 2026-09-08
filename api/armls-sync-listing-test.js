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
    `&_limit=1` +
    `&_expand=CustomFields`;

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

function findCustomField(
  customFields,
  label
) {
  function search(value) {
    if (
      value === null ||
      value === undefined
    ) {
      return null;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const found =
          search(item);

        if (found !== null) {
          return found;
        }
      }

      return null;
    }

    if (
      typeof value === "object"
    ) {
      if (
        Object.prototype
          .hasOwnProperty.call(
            value,
            label
          )
      ) {
        return value[label];
      }

      for (
        const child
        of Object.values(value)
      ) {
        const found =
          search(child);

        if (found !== null) {
          return found;
        }
      }
    }

    return null;
  }

  return search(customFields);
}

function extractUpdates(
  customFields
) {
  const raw = {
    flooring: {
      year:
        findCustomField(
          customFields,
          "Floor Yr Updated"
        ),

      scope:
        findCustomField(
          customFields,
          "Floor Partial/Full"
        )
    },

    electrical: {
      year:
        findCustomField(
          customFields,
          "Wiring Yr Updated"
        ),

      scope:
        findCustomField(
          customFields,
          "Wiring Partial/Full"
        )
    },

    plumbing: {
      year:
        findCustomField(
          customFields,
          "Plmbg Yr Updated"
        ),

      scope:
        findCustomField(
          customFields,
          "Plmbg Partial/Full"
        )
    },

    hvac: {
      year:
        findCustomField(
          customFields,
          "Ht/Cool Yr Updated"
        ),

      scope:
        findCustomField(
          customFields,
          "Ht/Cool Partial/Full"
        )
    },

    roof: {
      year:
        findCustomField(
          customFields,
          "Roof Yr Updated"
        ),

      scope:
        findCustomField(
          customFields,
          "Roof Partial/Full"
        )
    },

    kitchen: {
      year:
        findCustomField(
          customFields,
          "Kitchen Yr Updated"
        ),

      scope:
        findCustomField(
          customFields,
          "Kitchen Partial/Full"
        )
    },

    bathrooms: {
      year:
        findCustomField(
          customFields,
          "Bath(s) Yr Updated"
        ),

      scope:
        findCustomField(
          customFields,
          "Bath(s) Partial/Full"
        )
    },

    room_addition: {
      year:
        findCustomField(
          customFields,
          "Rm Adtn Yr Updated"
        ),

      scope:
        findCustomField(
          customFields,
          "Rm Adtn Partial/Full"
        )
    },

    pool: {
      year:
        findCustomField(
          customFields,
          "Pool Yr Updated"
        ),

      scope:
        findCustomField(
          customFields,
          "Pool Partial/Full"
        )
    }
  };

  const result = {};

  for (
    const [
      systemType,
      item
    ]
    of Object.entries(raw)
  ) {
    if (
      !isReasonableYear(
        Number(item.year)
      )
    ) {
      continue;
    }

    result[systemType] = {
      systemType,

      year:
        Number(item.year),

      scope:
        clean(item.scope) ||
        null
    };
  }

  return result;
}

/* ============================================================
   SCAN ARMLS PUBLIC REMARKS

   IMPORTANT:
   - This scanner is deterministic.
   - These are listing-reported signals, normally without a year.
   - Structured ARMLS dated updates always take priority.
============================================================ */

const PUBLIC_REMARK_RULES = [
  {
    systemType: "hvac",
    category: "HVAC",
    patterns: [
      /\bnew\s+hvac\b/i,
      /\bnewer\s+hvac\b/i,
      /\bupdated\s+hvac\b/i,
      /\breplaced\s+hvac\b/i,
      /\bnew\s+a\/c\b/i,
      /\bnew\s+ac\b/i,
      /\bupdated\s+a\/c\b/i,
      /\bupdated\s+ac\b/i,
      /\bnewer\s+a\/c\b/i,
      /\bnewer\s+ac\b/i,
      /\bnew\s+air\s+condition(?:er|ing)\b/i,
      /\bupdated\s+air\s+condition(?:er|ing)\b/i,
      /\bnewer\s+air\s+condition(?:er|ing)\b/i,
      /\bnew\s+furnace\b/i,
      /\bupdated\s+furnace\b/i,
      /\bnewer\s+furnace\b/i,
      /\bnew\s+heat\s+pump\b/i,
      /\bupdated\s+heat\s+pump\b/i
    ]
  },

  {
    systemType: "plumbing",
    category: "Plumbing",
    patterns: [
      /\bnew\s+plumbing\b/i,
      /\bnewer\s+plumbing\b/i,
      /\bupdated\s+plumbing\b/i,
      /\breplaced\s+plumbing\b/i,
      /\bplumbing\s+updated\b/i,
      /\bre[-\s]?piped\b/i,
      /\brepiped\b/i,
      /\bnew\s+piping\b/i,
      /\bupdated\s+piping\b/i,
      /\bnew\s+supply\s+plumbing\b/i
    ]
  },

  {
    systemType: "electrical",
    category: "Electrical",
    patterns: [
      /\bnew\s+electrical\b/i,
      /\bnewer\s+electrical\b/i,
      /\bupdated\s+electrical\b/i,
      /\breplaced\s+electrical\b/i,
      /\belectrical\s+update\b/i,
      /\bnew\s+wiring\b/i,
      /\bupdated\s+wiring\b/i,
      /\bnew\s+panel\b/i,
      /\bupdated\s+panel\b/i,
      /\breplaced\s+panel\b/i,
      /\bbreaker\s+panel\b/i,
      /\bsubpanel\b/i,
      /\b200[-\s]?amp\b/i,
      /\b100[-\s]?amp\b/i,
      /\b60[-\s]?amp\b/i,
      /\b50[-\s]?amp\b/i,
      /\b40[-\s]?amp\b/i,
      /\belectrical\s+service\b/i
    ]
  },

  {
    systemType: "roof",
    category: "Roof",
    patterns: [
      /\bnew\s+roof\b/i,
      /\bnewer\s+roof\b/i,
      /\bupdated\s+roof\b/i,
      /\breplaced\s+roof\b/i,
      /\broof\s+replaced\b/i,
      /\breplacement\s+roof\b/i,
      /\broof\s+updated\b/i,
      /\bnew\s+roofing\b/i
    ]
  },

  {
    systemType: "flooring",
    category: "Flooring",
    patterns: [
      /\bnew\s+flooring\b/i,
      /\bnewer\s+flooring\b/i,
      /\bupdated\s+flooring\b/i,
      /\breplaced\s+flooring\b/i,
      /\bremodeled\s+floors?\b/i,
      /\bnew\s+floors?\b/i,
      /\bupdated\s+floors?\b/i,
      /\btile\s+flooring\b/i,
      /\bhardwood\s+floors?\b/i,
      /\boriginal\s+hardwood\b/i,
      /\brefinished\s+hardwood\b/i,
      /\bengineered\s+wood\s+flooring\b/i,
      /\bwood[-\s]?look\s+tile\b/i,
      /\blvp\b/i,
      /\bluxury\s+vinyl\b/i
    ]
  },

  {
    systemType: "kitchen",
    category: "Kitchen",
    patterns: [
      /\bnew\s+kitchen\b/i,
      /\bnewer\s+kitchen\b/i,
      /\bupdated\s+kitchen\b/i,
      /\bupgraded\s+kitchen\b/i,
      /\bremodeled\s+kitchen\b/i,
      /\brenovated\s+kitchen\b/i,
      /\bnew\s+cabinet(?:s|ry)?\b/i,
      /\bupdated\s+cabinet(?:s|ry)?\b/i,
      /\bnew\s+countertops?\b/i,
      /\bupdated\s+countertops?\b/i,
      /\bgranite\s+(?:kitchen\s+)?countertops?\b/i,
      /\bquartz\s+(?:kitchen\s+)?countertops?\b/i,
      /\bstainless\s+steel\s+appliances\b/i,
      /\bnewer\s+appliances\b/i
    ]
  },

  {
    systemType: "bathrooms",
    category: "Bathrooms",
    patterns: [
      /\bnew\s+bath(?:room)?s?\b/i,
      /\bnewer\s+bath(?:room)?s?\b/i,
      /\bupdated\s+bath(?:room)?s?\b/i,
      /\bupgraded\s+bath(?:room)?s?\b/i,
      /\bremodeled\s+bath(?:room)?s?\b/i,
      /\brenovated\s+bath(?:room)?s?\b/i,
      /\bnew\s+vanit(?:y|ies)\b/i,
      /\bupdated\s+vanit(?:y|ies)\b/i,
      /\bnew\s+toilet\b/i,
      /\bupdated\s+toilet\b/i,
      /\btile\s+surround\b/i,
      /\bwalk[-\s]?in\s+shower\b/i,
      /\brain\s+shower\b/i,
      /\bglass\s+shower\s+enclosures?\b/i,
      /\bsoaking\s+tub\b/i
    ]
  },

  {
    systemType: "pool",
    category: "Pool",
    patterns: [
      /\bnew\s+pool\b/i,
      /\bnewer\s+pool\b/i,
      /\bupdated\s+pool\b/i,
      /\bnewly\s+built\s+pool\b/i,
      /\bnewly\s+constructed\s+pool\b/i,
      /\bpool\s+resurfaced\b/i,
      /\bresurfaced\s+pool\b/i,
      /\bpool\s+remodeled\b/i,
      /\bnew\s+spa\b/i,
      /\bupdated\s+spa\b/i,
      /\bnew\s+pool\s+pump\b/i,
      /\bpool\s+pump\s+replaced\b/i
    ]
  }
];


/* ============================================================
   GROUPED REMARK PHRASES

   Examples:
     newer plumbing, electrical, HVAC, roof
     updated kitchen, bathrooms and flooring
     replaced roof, HVAC and electrical
============================================================ */

const GROUPED_REMARK_SYSTEM_PATTERNS = {
  hvac:
    /\b(?:hvac|a\/c|ac|air\s+conditioning|air\s+conditioner|furnace|heat\s+pump)\b/i,

  plumbing:
    /\b(?:plumbing|pipes?|piping|repipe|repiped)\b/i,

  electrical:
    /\b(?:electrical|wiring|electrical\s+panel|breaker\s+panel|panel)\b/i,

  roof:
    /\b(?:roof|roofing)\b/i,

  flooring:
    /\b(?:flooring|floors?|hardwood|tile|lvp|luxury\s+vinyl)\b/i,

  kitchen:
    /\b(?:kitchen|cabinets?|cabinetry|countertops?)\b/i,

  bathrooms:
    /\b(?:bathrooms?|baths?|vanit(?:y|ies)|showers?)\b/i,

  pool:
    /\b(?:pool|spa)\b/i
};

function findGroupedImprovementMatch(
  remarks,
  systemType
) {
  const systemPattern =
    GROUPED_REMARK_SYSTEM_PATTERNS[
      systemType
    ];

  if (!systemPattern) {
    return "";
  }

  const groupPattern =
    /\b(new|newer|recent|recently\s+updated|newly\s+updated|updated|upgraded|replaced|renovated|remodeled)\b([^.!;]{0,140})/gi;

  let groupMatch;

  while (
    (
      groupMatch =
        groupPattern.exec(
          remarks
        )
    ) !== null
  ) {
    const modifier =
      clean(
        groupMatch[1]
      );

    const clauseTail =
      clean(
        groupMatch[2]
      );

    const fullClause =
      clean(
        `${modifier} ${clauseTail}`
      );

    if (
      /\b(?:not|never)\s+(?:been\s+)?(?:updated|replaced|upgraded|renovated|remodeled)\b/i
        .test(fullClause)
    ) {
      continue;
    }

    const systemMatch =
      fullClause.match(
        systemPattern
      );

    if (!systemMatch?.[0]) {
      continue;
    }

    return clean(
      `${modifier} ${systemMatch[0]}`
    );
  }

  return "";
}

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
    if (
      Object.prototype.hasOwnProperty.call(
        structuredUpdates,
        rule.systemType
      )
    ) {
      continue;
    }

    let matchedText =
      findGroupedImprovementMatch(
        remarks,
        rule.systemType
      );

    if (!matchedText) {
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
        `${rule.category} improvement reported in ARMLS Public Remarks`,

      matchedText
    });
  }

  return results;
}


/* ============================================================
   SAVE LISTING REMARK SIGNALS
============================================================ */

async function replaceRemarkSignals({
  propertyId,
  propertyListingId,
  mlsNumber,
  signals
}) {
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
   PERMANENT STRUCTURED LISTING UPDATE HISTORY
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
      fields.CustomFields ||
      listing.customFields ||
      fields.customFields ||
      {};

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


    /* --------------------------------------------------------
       PULL BOTH ARMLS DATA TYPES IN ONE RUN
    -------------------------------------------------------- */

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
       SAVE / REFRESH LISTING REMARKS
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
       SAVE STRUCTURED LISTING UPDATES
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

       Listing Updates and Listing Remarks remain separate.
    -------------------------------------------------------- */

    return res
      .status(200)
      .json({
        success:
          true,

        mode:
          "ARMLS_LISTING_UPDATES_AND_REMARKS",

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


        /* ----------------------------------------------------
           STRUCTURED ARMLS LISTING UPDATES
        ---------------------------------------------------- */

        listingUpdatesFound:
          Object.keys(
            updates
          ).length,

        updatesFound:
          Object.keys(
            updates
          ).length,

        listingUpdates:
          Object.values(
            updates
          ).map(
            update => ({
              systemType:
                update.systemType,

              year:
                update.year,

              scope:
                update.scope ||
                null,

              source:
                "ARMLS",

              type:
                "structured"
            })
          ),


        /* ----------------------------------------------------
           ARMLS PUBLIC REMARK SIGNALS
        ---------------------------------------------------- */

        publicRemarksAvailable:
          Boolean(
            publicRemarks
          ),

        listingRemarksFound:
          remarkSignals.length,

        remarkSignalsFound:
          remarkSignals.length,

        listingRemarks:
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
                row.reported_year,

              source:
                "ARMLS",

              type:
                "public_remarks"
            })
          ),

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


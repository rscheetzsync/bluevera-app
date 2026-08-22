export const config = {
  api: {
    bodyParser: {
      sizeLimit: "1mb"
    }
  }
};

const SPARK_BASE =
  "https://replication.sparkapi.com/v1";

const SUPABASE_URL =
  String(
    process.env.SUPABASE_URL || ""
  ).replace(/\/+$/, "");

const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  "";

const SPARK_TOKEN =
  process.env.SPARK_ACCESS_TOKEN || "";


/* ============================================================
   BASIC HELPERS
============================================================ */

function clean(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
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
    .replace(
      /\b\d{5}(?:-\d{4})?\b/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeApn(value) {
  return clean(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function validYear(value) {
  const year =
    Number(clean(value));

  const currentYear =
    new Date().getFullYear();

  return (
    Number.isInteger(year) &&
    year >= 1800 &&
    year <= currentYear + 1
  );
}


/* ============================================================
   SUPABASE
============================================================ */

async function supabaseRequest(path) {
  const response =
    await fetch(
      `${SUPABASE_URL}/rest/v1/${path}`,
      {
        method: "GET",

        headers: {
          apikey:
            SERVICE_KEY,

          Authorization:
            `Bearer ${SERVICE_KEY}`,

          "Content-Type":
            "application/json"
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
      `Supabase request failed (${response.status})`
    );
  }

  return data;
}


/* ============================================================
   ARMLS CUSTOM FIELD SEARCH
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

    if (typeof value === "object") {
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


/* ============================================================
   EXTRACT ARMLS UPDATE YEARS
============================================================ */

function extractUpdates(customFields) {
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

  const validUpdates = {};

  for (
    const [
      systemType,
      update
    ]
    of Object.entries(raw)
  ) {
    if (!validYear(update.year)) {
      continue;
    }

    validUpdates[systemType] = {
      eventYear:
        Number(update.year),

      updateScope:
        clean(update.scope) ||
        null
    };
  }

  return validUpdates;
}


/* ============================================================
   BUILD LISTING ADDRESS
============================================================ */

function buildListingAddress(fields) {
  if (clean(fields.UnparsedAddress)) {
    return clean(
      fields.UnparsedAddress
    );
  }

  return [
    fields.StreetNumber,
    fields.StreetDirPrefix,
    fields.StreetName,
    fields.StreetSuffix,
    fields.StreetDirSuffix,
    fields.UnitNumber,
    fields.City,
    fields.StateOrProvince,
    fields.PostalCode
  ]
    .filter(Boolean)
    .join(" ");
}


/* ============================================================
   FIND BLUEVERA PROPERTY
============================================================ */

async function findBlueVeraProperty({
  apn,
  address
}) {
  const normalizedApn =
    normalizeApn(apn);

  const normalizedListingAddress =
    normalizeAddress(address);

  /*
    STEP 1:
    Pull likely candidates.

    We intentionally keep this preview conservative.
  */

  const rows =
    await supabaseRequest(
      "properties?select=*&order=created_at.desc&limit=2000"
    );

  const properties =
    Array.isArray(rows)
      ? rows
      : [];

  /*
    STRONGEST MATCH:
    APN / parcel number
  */

  if (normalizedApn) {
    const apnMatch =
      properties.find(property => {
        const candidate =
          normalizeApn(
            property.apn ||
            property.parcel_number ||
            property.parcelNumber
          );

        return (
          candidate &&
          candidate === normalizedApn
        );
      });

    if (apnMatch) {
      return {
        matchType:
          "apn",

        confidence:
          "high",

        property:
          apnMatch
      };
    }
  }

  /*
    SECOND MATCH:
    normalized address
  */

  if (normalizedListingAddress) {
    const addressMatches =
      properties.filter(property => {
        const candidate =
          normalizeAddress(
            property.full_address ||
            property.address ||
            property.street ||
            property.normalized_address
          );

        return (
          candidate &&
          candidate ===
            normalizedListingAddress
        );
      });

    if (addressMatches.length === 1) {
      return {
        matchType:
          "normalized_address",

        confidence:
          "medium",

        property:
          addressMatches[0]
      };
    }

    /*
      If multiple BlueVera properties have
      the exact same normalized address,
      DO NOT guess.
    */
    if (addressMatches.length > 1) {
      return {
        matchType:
          "ambiguous_address",

        confidence:
          "unsafe",

        property:
          null,

        candidates:
          addressMatches.map(
            property => ({
              id:
                property.id,

              apn:
                property.apn ||
                null,

              address:
                property.full_address ||
                property.address ||
                property.street ||
                null
            })
          )
      };
    }
  }

  return {
    matchType:
      "no_match",

    confidence:
      "none",

    property:
      null
  };
}


/* ============================================================
   MAIN HANDLER
============================================================ */

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

  try {
    if (!SPARK_TOKEN) {
      return res
        .status(500)
        .json({
          success: false,
          error:
            "SPARK_ACCESS_TOKEN is missing"
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
            "Supabase server environment variables are missing"
        });
    }

    /*
      You can call this as:

      /api/armls-listing-history-preview?mls=7045718
    */

    const mlsNumber =
      clean(
        req.query?.mls ||
        req.query?.mlsNumber
      );

    if (!mlsNumber) {
      return res
        .status(400)
        .json({
          success: false,

          error:
            "MLS number is required.",

          example:
            "/api/armls-listing-history-preview?mls=7045718"
        });
    }

    const filter =
      `ListingId Eq '${mlsNumber.replace(
        /'/g,
        "''"
      )}'`;

    const sparkUrl =
      `${SPARK_BASE}/listings` +
      `?_filter=${encodeURIComponent(
        filter
      )}` +
      "&_limit=1" +
      "&_expand=CustomFields";

    const sparkResponse =
      await fetch(
        sparkUrl,
        {
          method: "GET",

          headers: {
            Authorization:
              `Bearer ${SPARK_TOKEN}`,

            Accept:
              "application/json"
          }
        }
      );

    const sparkText =
      await sparkResponse.text();

    let sparkData = null;

    try {
      sparkData =
        sparkText
          ? JSON.parse(sparkText)
          : null;
    } catch {
      return res
        .status(502)
        .json({
          success: false,

          error:
            "Spark returned invalid JSON",

          raw:
            sparkText.slice(
              0,
              2000
            )
        });
    }

    if (!sparkResponse.ok) {
      return res
        .status(502)
        .json({
          success: false,

          error:
            sparkData?.D?.Message ||
            sparkData?.message ||
            "Spark listing request failed",

          sparkResponse:
            sparkData
        });
    }

    const listing =
      Array.isArray(
        sparkData?.D?.Results
      )
        ? sparkData.D.Results[0]
        : null;

    if (!listing) {
      return res
        .status(404)
        .json({
          success: false,

          error:
            `MLS ${mlsNumber} was not found.`
        });
    }

    const fields =
      listing.StandardFields ||
      listing ||
      {};

    const customFields =
      listing.CustomFields ||
      fields.CustomFields ||
      {};

    const listingAddress =
      buildListingAddress(
        fields
      );

    /*
      ARMLS commonly exposes ParcelNumber.
      We keep a few fallbacks for safety.
    */

    const listingApn =
      clean(
        fields.ParcelNumber ||
        fields.ParcelNumberRaw ||
        fields.APN ||
        fields.TaxParcelNumber ||
        ""
      );

    const updates =
      extractUpdates(
        customFields
      );

    const propertyMatch =
      await findBlueVeraProperty({
        apn:
          listingApn,

        address:
          listingAddress
      });

    const property =
      propertyMatch.property;

    /*
      This is the exact object that
      the future WRITE endpoint would use.

      NOTHING IS BEING WRITTEN HERE.
    */

    const proposedListingRecord =
      property?.id
        ? {
            property_id:
              property.id,

            source_type:
              "armls",

            mls_number:
              clean(
                fields.ListingId ||
                mlsNumber
              ),

            listing_key:
              clean(
                listing.Id ||
                fields.ListingKey ||
                fields.SourceSystemKey
              ) || null,

            listing_status:
              clean(
                fields.StandardStatus ||
                fields.MlsStatus
              ) || null,

            list_price:
              Number(
                fields.ListPrice
              ) || null,

            listing_date:
              clean(
                fields.OnMarketDate ||
                fields.ListingContractDate
              ) || null,

            modification_timestamp:
              clean(
                fields.ModificationTimestamp
              ) || null
          }
        : null;

    const proposedHistoryRecords =
      property?.id
        ? Object.entries(
            updates
          ).map(
            ([
              systemType,
              update
            ]) => ({
              property_id:
                property.id,

              history_type:
                "listing_update",

              system_type:
                systemType,

              event_year:
                update.eventYear,

              event_type:
                "update",

              update_scope:
                update.updateScope,

              source_type:
                "armls",

              source_name:
                "ARMLS",

              source_record_id:
                clean(
                  fields.ListingId ||
                  mlsNumber
                ),

              evidence_level:
                "source_reported",

              verification_status:
                "listing_reported",

              agent_visible:
                true,

              homeowner_visible:
                false,

              public_visible:
                false
            })
          )
        : [];

    return res
      .status(200)
      .json({
        success:
          true,

        mode:
          "PREVIEW_ONLY",

        writesPerformed:
          false,

        listing: {
          mlsNumber:
            clean(
              fields.ListingId ||
              mlsNumber
            ),

          listingKey:
            clean(
              listing.Id ||
              fields.ListingKey ||
              fields.SourceSystemKey
            ) || null,

          status:
            clean(
              fields.StandardStatus ||
              fields.MlsStatus
            ) || null,

          address:
            listingAddress,

          normalizedAddress:
            normalizeAddress(
              listingAddress
            ),

          apn:
            listingApn || null,

          normalizedApn:
            normalizeApn(
              listingApn
            ) || null,

          listPrice:
            Number(
              fields.ListPrice
            ) || null,

          modificationTimestamp:
            clean(
              fields.ModificationTimestamp
            ) || null
        },

        propertyMatch: {
          matchType:
            propertyMatch.matchType,

          confidence:
            propertyMatch.confidence,

          propertyId:
            property?.id ||
            null,

          blueVeraAddress:
            property
              ? (
                  property.full_address ||
                  property.address ||
                  property.street ||
                  null
                )
              : null,

          blueVeraApn:
            property
              ? (
                  property.apn ||
                  property.parcel_number ||
                  null
                )
              : null,

          candidates:
            propertyMatch.candidates ||
            []
        },

        updatesFound:
          Object.keys(
            updates
          ).length,

        updates,

        proposedListingRecord,

        proposedHistoryRecords,

        safeToWrite:
          Boolean(
            property?.id &&
            (
              propertyMatch.matchType ===
                "apn" ||
              propertyMatch.matchType ===
                "normalized_address"
            )
          )
      });

  } catch (error) {
    console.error(
      "ARMLS listing history preview failed:",
      error
    );

    return res
      .status(500)
      .json({
        success: false,

        error:
          error?.message ||
          "ARMLS listing history preview failed"
      });
  }
}

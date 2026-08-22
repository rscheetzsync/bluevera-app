export const config = {
  api: {
    bodyParser: {
      sizeLimit: "1mb"
    }
  }
};

const MLS_NUMBER = "7045718";

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

function normalizeApn(value) {
  return clean(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
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
    .replace(/\barizona\b/g, "az")
    .replace(/\s+/g, " ")
    .trim();
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

function dateOnly(value) {
  const text = clean(value);

  if (!text) {
    return null;
  }

  const parsed =
    new Date(text);

  if (
    Number.isNaN(
      parsed.getTime()
    )
  ) {
    return null;
  }

  return parsed
    .toISOString()
    .slice(0, 10);
}


/* ============================================================
   SUPABASE
============================================================ */

async function supabaseRequest(
  path,
  options = {}
) {
  const response =
    await fetch(
      `${SUPABASE_URL}/rest/v1/${path}`,
      {
        ...options,

        headers: {
          apikey:
            SERVICE_KEY,

          Authorization:
            `Bearer ${SERVICE_KEY}`,

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
      data?.details ||
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


/* ============================================================
   EXTRACT LISTING UPDATE YEARS
============================================================ */

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
    if (!validYear(item.year)) {
      continue;
    }

    result[systemType] = {
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
   ADDRESS
============================================================ */

function buildAddress(fields) {
  if (
    clean(
      fields.UnparsedAddress
    )
  ) {
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
   FIND EXISTING PROPERTY
============================================================ */

async function findExistingProperty({
  apn,
  address,
  city,
  state,
  zip
}) {
  const normalizedApn =
    normalizeApn(apn);

  /*
    First search likely properties in
    the same geographic area.
  */

  let path =
    "properties" +
    "?select=id,full_address,street,city,state,zip,apn";

  if (city) {
    path +=
      "&city=ilike." +
      encodeURIComponent(city);
  }

  if (state) {
    path +=
      "&state=eq." +
      encodeURIComponent(state);
  }

  if (zip) {
    path +=
      "&zip=eq." +
      encodeURIComponent(zip);
  }

  path +=
    "&limit=500";

  const rows =
    await supabaseRequest(
      path,
      {
        method: "GET"
      }
    );

  const properties =
    Array.isArray(rows)
      ? rows
      : [];


  /* ----------------------------------------------------------
     APN FIRST
  ---------------------------------------------------------- */

  if (normalizedApn) {
    const apnMatches =
      properties.filter(
        property =>
          normalizeApn(
            property.apn
          ) ===
          normalizedApn
      );

    if (
      apnMatches.length === 1
    ) {
      return {
        property:
          apnMatches[0],

        matchType:
          "apn"
      };
    }

    if (
      apnMatches.length > 1
    ) {
      throw new Error(
        "Multiple BlueVera properties matched this APN. Write stopped."
      );
    }
  }


  /* ----------------------------------------------------------
     ADDRESS SECOND
  ---------------------------------------------------------- */

  const targetAddress =
    normalizeAddress(
      address
    );

  if (targetAddress) {
    const addressMatches =
      properties.filter(
        property => {
          const candidate =
            normalizeAddress(
              property.full_address ||
              [
                property.street,
                property.city,
                property.state,
                property.zip
              ]
                .filter(Boolean)
                .join(" ")
            );

          return (
            candidate ===
            targetAddress
          );
        }
      );

    if (
      addressMatches.length === 1
    ) {
      return {
        property:
          addressMatches[0],

        matchType:
          "normalized_address"
      };
    }

    if (
      addressMatches.length > 1
    ) {
      throw new Error(
        "Multiple BlueVera properties matched this address. Write stopped."
      );
    }
  }

  return {
    property:
      null,

    matchType:
      "no_match"
  };
}


/* ============================================================
   CREATE PROPERTY
============================================================ */

async function createProperty({
  address,
  street,
  city,
  state,
  zip,
  apn
}) {
const payload = {
  full_address:
    address,

  street:
    street,

  city:
    city,

  state:
    state,

  zip:
    zip,

  apn:
    apn ||
    null
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

  const property =
    Array.isArray(rows)
      ? rows[0]
      : rows;

  if (!property?.id) {
    throw new Error(
      "ARMLS property was created but no property ID was returned."
    );
  }

  return property;
}


/* ============================================================
   UPSERT PROPERTY LISTING
============================================================ */

async function savePropertyListing({
  propertyId,
  listing,
  fields
}) {
  const payload = {
    property_id:
      propertyId,

    source_type:
      "armls",

    mls_number:
      MLS_NUMBER,

    listing_key:
      clean(
        listing.Id ||
        fields.ListingKey ||
        fields.SourceSystemKey
      ) ||
      null,

    listing_status:
      clean(
        fields.StandardStatus ||
        fields.MlsStatus
      ) ||
      null,

    list_price:
      Number(
        fields.ListPrice
      ) ||
      null,

    listing_date:
      dateOnly(
        fields.OnMarketDate ||
        fields.ListingContractDate
      ),

    modification_timestamp:
      clean(
        fields.ModificationTimestamp
      ) ||
      null,

    source_payload_updated_at:
      new Date().toISOString(),

    updated_at:
      new Date().toISOString()
  };

  const rows =
    await supabaseRequest(
      "property_listings" +
      "?on_conflict=source_type,mls_number",
      {
        method:
          "POST",

        headers: {
          Prefer:
            "resolution=merge-duplicates,return=representation"
        },

        body:
          JSON.stringify(
            payload
          )
      }
    );

  const saved =
    Array.isArray(rows)
      ? rows[0]
      : rows;

  if (!saved?.id) {
    throw new Error(
      "Property listing could not be saved."
    );
  }

  return saved;
}


/* ============================================================
   SAVE ONE HISTORY RECORD
============================================================ */

async function saveHistoryRecord({
  propertyId,
  propertyListingId,
  systemType,
  year,
  scope
}) {
  /*
    Check first.

    This makes the test idempotent:
    running it again does not create
    another copy of the same MLS event.
  */

  const existing =
    await supabaseRequest(
      "property_history_records" +
      "?select=*" +
      "&property_id=eq." +
      encodeURIComponent(
        propertyId
      ) +
      "&source_type=eq.armls" +
      "&source_record_id=eq." +
      encodeURIComponent(
        MLS_NUMBER
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

  if (
    Array.isArray(existing) &&
    existing[0]?.id
  ) {
    /*
      Keep same permanent event,
      but allow scope/listing link
      to be refreshed.
    */

    const updated =
      await supabaseRequest(
        "property_history_records" +
        "?id=eq." +
        encodeURIComponent(
          existing[0].id
        ),
        {
          method:
            "PATCH",

          headers: {
            Prefer:
              "return=representation"
          },

          body:
            JSON.stringify({
              property_listing_id:
                propertyListingId,

              update_scope:
                scope,

              updated_at:
                new Date()
                  .toISOString()
            })
        }
      );

    return {
      action:
        "existing_updated",

      record:
        Array.isArray(updated)
          ? updated[0]
          : updated
    };
  }


  /*
    New permanent listing-history event.
  */

  const payload = {
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

    event_type:
      "update",

    update_scope:
      scope,

    source_type:
      "armls",

    source_name:
      "ARMLS",

    source_record_id:
      MLS_NUMBER,

    statement:
      `${systemType} update reported for ${year}`,

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

    record:
      Array.isArray(rows)
        ? rows[0]
        : rows
  };
}


/* ============================================================
   MAIN
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


    /* --------------------------------------------------------
       FETCH MLS 7045718
    -------------------------------------------------------- */

    const filter =
      `ListingId Eq '${MLS_NUMBER}'`;

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

    let sparkData;

    try {
      sparkData =
        JSON.parse(
          sparkText
        );
    } catch {
      throw new Error(
        "Spark returned invalid JSON."
      );
    }

    if (!sparkResponse.ok) {
      throw new Error(
        sparkData?.D?.Message ||
        "Spark listing request failed."
      );
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
          success:
            false,

          error:
            `MLS ${MLS_NUMBER} was not found.`
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

    const address =
      buildAddress(
        fields
      );

    const street =
      clean(
        fields.UnparsedAddress
      ) ||
      [
        fields.StreetNumber,
        fields.StreetDirPrefix,
        fields.StreetName,
        fields.StreetSuffix,
        fields.StreetDirSuffix
      ]
        .filter(Boolean)
        .join(" ");

    const city =
      clean(
        fields.City
      );

    const state =
      clean(
        fields.StateOrProvince
      ) ||
      "AZ";

    const zip =
      clean(
        fields.PostalCode
      );

    const apn =
      clean(
        fields.ParcelNumber ||
        fields.ParcelNumberRaw ||
        fields.APN ||
        fields.TaxParcelNumber
      );

    const updates =
      extractUpdates(
        customFields
      );


    /* --------------------------------------------------------
       FIND OR CREATE PERMANENT PROPERTY
    -------------------------------------------------------- */

    const match =
      await findExistingProperty({
        apn,
        address,
        city,
        state,
        zip
      });

    let property =
      match.property;

    let propertyAction =
      "matched_existing";

    if (!property?.id) {
      property =
        await createProperty({
          address,
          street,
          city,
          state,
          zip,
          apn
        });

      propertyAction =
        "created_new_property";
    }


    /* --------------------------------------------------------
       SAVE MLS LISTING
    -------------------------------------------------------- */

    const savedListing =
      await savePropertyListing({
        propertyId:
          property.id,

        listing,

        fields
      });


    /* --------------------------------------------------------
       SAVE DATED LISTING UPDATES
    -------------------------------------------------------- */

    const historyResults = [];

    for (
      const [
        systemType,
        update
      ]
      of Object.entries(
        updates
      )
    ) {
      const result =
        await saveHistoryRecord({
          propertyId:
            property.id,

          propertyListingId:
            savedListing.id,

          systemType,

          year:
            update.year,

          scope:
            update.scope
        });

      historyResults.push({
        systemType,
        eventYear:
          update.year,
        updateScope:
          update.scope,
        action:
          result.action,
        historyRecordId:
          result.record?.id ||
          null
      });
    }


    /* --------------------------------------------------------
       RETURN TEST RESULT

       IMPORTANT:
       NO RATING RECALCULATION HERE.
       NO MAP WRITE HERE.
    -------------------------------------------------------- */

    return res
      .status(200)
      .json({
        success:
          true,

        mode:
          "CONTROLLED_SINGLE_LISTING_WRITE",

        mlsNumber:
          MLS_NUMBER,

        property: {
          id:
            property.id,

          action:
            propertyAction,

          matchType:
            match.matchType,

          address:
            property.full_address ||
            address,

          apn:
            property.apn ||
            apn
        },

        propertyListing: {
          id:
            savedListing.id,

          mlsNumber:
            savedListing.mls_number,

          status:
            savedListing.listing_status
        },

        updatesFound:
          Object.keys(
            updates
          ).length,

        historyResults,

        ratingRecalculated:
          false,

        mapUpdated:
          false,

        note:
          "Permanent ARMLS listing history was stored. This test does not directly update map.html or recalculate the Disclosure Rating."
      });

  } catch (error) {
    console.error(
      "Controlled ARMLS write test failed:",
      error
    );

    return res
      .status(500)
      .json({
        success:
          false,

        error:
          error?.message ||
          "Controlled ARMLS write test failed."
      });
  }
}

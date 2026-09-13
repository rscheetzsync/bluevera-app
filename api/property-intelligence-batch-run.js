/*
  BlueVera Property Intelligence Batch Runner
  File: /api/property-intelligence-batch-run.js

  Receives controlled ARMLS listings from bluevera.app, gathers public
  property signals, and saves successful last-known-good values through:
    https://bluevera.org/api/property-intelligence-save

  This endpoint does NOT create claimed-property records.
*/

const PUBLIC_BASE =
  String(process.env.BLUEVERA_PUBLIC_BASE_URL || "https://bluevera.org")
    .replace(/\/+$/, "");

const BATCH_API_KEY = String(
  process.env.BLUEVERA_BATCH_API_KEY || ""
).trim();

const MAX_BATCH = 25;
const PROPERTY_CONCURRENCY = 3;
const DEFAULT_TIMEOUT_MS = 15000;

const SUPERFUND_QUERY =
  "https://services.arcgis.com/SzoH1oFM2apCSkx3/arcgis/rest/services/Superfund/FeatureServer/1/query";

const ADEQ_PLUME_QUERY =
  "https://services.arcgis.com/cfKakmeHE95cgeEK/arcgis/rest/services/GarfieldPlumeADEQBoundary_200616/FeatureServer/0/query";

const PHX_ZONING_QUERY =
  "https://maps.phoenix.gov/pub/rest/services/Public/Zoning/MapServer/0/query";

const AIRPORTS = [
  {
    name: "Phoenix Sky Harbor International Airport",
    lat: 33.4342,
    lon: -112.0116
  },
  {
    name: "Phoenix Deer Valley Airport",
    lat: 33.6883,
    lon: -112.0826
  },
  {
    name: "Scottsdale Airport",
    lat: 33.6229,
    lon: -111.9105
  },
  {
    name: "Glendale Municipal Airport",
    lat: 33.5269,
    lon: -112.2951
  },
  {
    name: "Phoenix-Goodyear Airport",
    lat: 33.4225,
    lon: -112.3759
  },
  {
    name: "Falcon Field Airport",
    lat: 33.4608,
    lon: -111.7283
  },
  {
    name: "Phoenix-Mesa Gateway Airport",
    lat: 33.3078,
    lon: -111.6555
  },
  {
    name: "Chandler Municipal Airport",
    lat: 33.2691,
    lon: -111.8111
  }
];

function clean(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanApn(value) {
  return clean(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function finiteNumber(value) {
  const n = Number(
    typeof value === "string"
      ? value.replace(/,/g, "").trim()
      : value
  );

  return Number.isFinite(n)
    ? n
    : null;
}

function integerValue(value) {
  const n = finiteNumber(value);

  return n !== null
    ? Math.round(n)
    : null;
}

function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}

function normalizeListing(raw) {
  return {
    mlsNumber: clean(
      raw?.mlsNumber ||
      raw?.mls ||
      raw?.listingId ||
      raw?.ListingId
    ),

    address: clean(
      raw?.address ||
      raw?.fullAddress ||
      raw?.propertyAddress
    ),

    status: clean(
      raw?.status ||
      "Active"
    )
  };
}

function detectCity(
  address,
  parcel = {}
) {
  const explicit = clean(
    parcel?.jurisdiction ||
    parcel?.city ||
    parcel?.rawAttributes?.JURISDICTION ||
    parcel?.rawAttributes?.CITY ||
    parcel?.rawAttributes?.MUNI
  );

  if (explicit) {
    return explicit;
  }

  const lower =
    clean(address)
      .toLowerCase();

  const names = [
    "Paradise Valley",
    "Scottsdale",
    "Phoenix",
    "Tempe",
    "Mesa",
    "Gilbert",
    "Chandler",
    "Peoria",
    "Glendale",
    "Goodyear"
  ];

  return (
    names.find(
      name =>
        lower.includes(
          name.toLowerCase()
        )
    ) ||
    ""
  );
}

function detectZip(address) {
  const match =
    clean(address)
      .match(
        /\b(\d{5})(?:-\d{4})?\b/
      );

  return match
    ? match[1]
    : "";
}

async function fetchJson(
  url,
  options = {},
  timeoutMs = DEFAULT_TIMEOUT_MS
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => controller.abort(),
      timeoutMs
    );

  try {
    const response =
      await fetch(
        url,
        {
          ...options,

          signal:
            controller.signal,

          headers: {
            Accept:
              "application/json",

            ...(options.headers || {})
          },

          cache:
            "no-store"
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
      throw new Error(
        `Invalid JSON from ${url}`
      );
    }

    if (!response.ok) {
      throw new Error(
        clean(
          data?.error ||
          data?.message
        ) ||
        `HTTP ${response.status} from ${url}`
      );
    }

    return data;

  } finally {
    clearTimeout(timer);
  }
}

function sourceResult(
  sourceKey,
  ok,
  error = null
) {
  return {
    sourceKey,

    status:
      ok
        ? "success"
        : "failed",

    error:
      ok
        ? null
        : clean(error) ||
          "Source unavailable"
  };
}

function makeSourceTracker() {
  const rows = [];

  return {
    success(sourceKey) {
      rows.push(
        sourceResult(
          sourceKey,
          true
        )
      );
    },

    fail(
      sourceKey,
      error
    ) {
      rows.push(
        sourceResult(
          sourceKey,
          false,
          error
        )
      );
    },

    rows
  };
}

function haversineMiles(
  lat1,
  lon1,
  lat2,
  lon2
) {
  const toRad =
    degrees =>
      degrees *
      Math.PI /
      180;

  const earthMiles =
    3958.7613;

  const dLat =
    toRad(
      lat2 -
      lat1
    );

  const dLon =
    toRad(
      lon2 -
      lon1
    );

  const a =
    Math.sin(
      dLat / 2
    ) ** 2 +
    Math.cos(
      toRad(lat1)
    ) *
    Math.cos(
      toRad(lat2)
    ) *
    Math.sin(
      dLon / 2
    ) ** 2;

  return (
    earthMiles *
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    )
  );
}

function nearestAirport(
  lat,
  lon
) {
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon)
  ) {
    return null;
  }

  let best = null;

  for (
    const airport
    of AIRPORTS
  ) {
    const miles =
      haversineMiles(
        lat,
        lon,
        airport.lat,
        airport.lon
      );

    if (
      !best ||
      miles <
        best.miles
    ) {
      best = {
        name:
          airport.name,

        miles:
          Number(
            miles.toFixed(2)
          )
      };
    }
  }

  return best;
}

function airportStatusFromMiles(
  miles
) {
  if (
    !Number.isFinite(miles)
  ) {
    return null;
  }

  if (
    miles <= 2
  ) {
    return `Airport: HIGH (${miles.toFixed(2)} mi)`;
  }

  if (
    miles <= 5
  ) {
    return `Airport: nearby (${miles.toFixed(2)} mi)`;
  }

  return "Airport: clear";
}

function distanceStatus(
  label,
  miles,
  thresholds
) {
  if (
    !Number.isFinite(miles)
  ) {
    return null;
  }

  if (
    miles <=
    thresholds.high
  ) {
    return `${label}: HIGH (${miles.toFixed(2)} mi)`;
  }

  if (
    miles <=
    thresholds.nearby
  ) {
    return `${label}: NEARBY (${miles.toFixed(2)} mi)`;
  }

  return `${label}: clear`;
}

async function loadParcel(
  address
) {
  const data =
    await fetchJson(
      `${PUBLIC_BASE}/api/maricopa-parcel?address=${encodeURIComponent(address)}`
    );

  if (
    !data ||
    typeof data !==
      "object"
  ) {
    throw new Error(
      "Parcel lookup returned no property data."
    );
  }

  /*
    IMPORTANT:
    This now matches map.html.

    BlueVera only accepts the parcel
    when the parcel API explicitly
    confirms data.ok === true.
  */

  if (
    data.ok !== true
  ) {
    throw new Error(
      clean(
        data.error
      ) ||
      "Maricopa parcel lookup did not return a confirmed parcel."
    );
  }

  const attrs =
    data.rawAttributes ||
    {};

  const lat =
    finiteNumber(
      data.correctedLat
    ) ??
    finiteNumber(
      data.latitude
    ) ??
    finiteNumber(
      data.lat
    ) ??
    finiteNumber(
      data.geometry?.y
    ) ??
    finiteNumber(
      data.geometry?.latitude
    );

  const lon =
    finiteNumber(
      data.correctedLon
    ) ??
    finiteNumber(
      data.longitude
    ) ??
    finiteNumber(
      data.lon
    ) ??
    finiteNumber(
      data.lng
    ) ??
    finiteNumber(
      data.geometry?.x
    ) ??
    finiteNumber(
      data.geometry?.longitude
    );

  return {
    ...data,

    apn:
      cleanApn(
        data.apn ||
        attrs.APN_DASH ||
        attrs.APN ||
        attrs.PARCEL ||
        attrs.PARCEL_NUM ||
        attrs.PARCEL_NUMBER
      ),

    livingSqft:
      integerValue(
        data.livingSqft ??
        attrs.LIVING_SPACE ??
        attrs.LIVABLE_SQFT ??
        attrs.LIVING_SQFT ??
        attrs.IMPR_SQFT ??
        attrs.BLDG_SQFT
      ),

    yearBuilt:
      integerValue(
        data.yearBuilt ??
        attrs.CONST_YEAR ??
        attrs.YEAR_BUILT ??
        attrs.YR_BUILT ??
        attrs.BUILT_YEAR
      ),

    zoning:
      clean(
        data.zoning ||
        attrs.CITY_ZONING ||
        attrs.ZONING
      ),

    jurisdiction:
      clean(
        data.jurisdiction ||
        attrs.JURISDICTION ||
        attrs.CITY ||
        attrs.MUNI
      ),

    latitude:
      lat,

    longitude:
      lon
  };
}

async function loadCountySketch(
  apn
) {
  if (!apn) {
    throw new Error(
      "APN unavailable."
    );
  }

  return fetchJson(
    `${PUBLIC_BASE}/api/county-sketch?apn=${encodeURIComponent(apn)}`
  );
}

function additionsFromSketch(
  data
) {
  if (
    !data ||
    typeof data !==
      "object"
  ) {
    return null;
  }

  if (
    data.hasAddition ===
    true
  ) {
    return true;
  }

  if (
    data.hasAddition ===
    false
  ) {
    return false;
  }

  if (
    data.additionsFound ===
    true
  ) {
    return true;
  }

  if (
    data.additionsFound ===
    false
  ) {
    return false;
  }

  if (
    Array.isArray(
      data.structures
    )
  ) {
    return (
      data.structures.length >
      1
    );
  }

  return null;
}

async function loadListingSqft(
  address
) {
  const data =
    await fetchJson(
      `${PUBLIC_BASE}/api/rentcast-cached?address=${encodeURIComponent(address)}&mode=sale&ttlHours=120`
    );

  const listings =
    Array.isArray(data)

      ? data

      : Array.isArray(
          data?.listings
        )

        ? data.listings

        : [];

  const first =
    listings[0] ||
    null;

  if (!first) {
    return {
      sqft:
        null,

      foundListing:
        false
    };
  }

  const sqft =
    finiteNumber(
      first.squareFootage ??
      first.sqft ??
      first.livingArea ??
      first.property?.squareFootage
    );

  return {
    sqft:
      sqft &&
      sqft > 0

        ? Math.round(
            sqft
          )

        : null,

    foundListing:
      true
  };
}

function phoenixPermitPayload(
  address
) {
  const text =
    clean(address);

  const m =
    text.match(
      /^(\d+)\s+([NSEW])?\s*(.+?)(?:,\s*Phoenix)?(?:,\s*AZ)?(?:\s+\d{5}(?:-\d{4})?)?$/i
    );

  return {
    address:
      text,

    fullAddress:
      text,

    houseNumber:
      m?.[1] ||
      "",

    direction:
      m?.[2] ||
      "",

    street:
      m?.[3] ||
      ""
  };
}

async function postPublic(
  path,
  body
) {
  return fetchJson(
    `${PUBLIC_BASE}${path}`,
    {
      method:
        "POST",

      headers: {
        "Content-Type":
          "application/json"
      },

      body:
        JSON.stringify(
          body
        )
    }
  );
}

function extractPermitArray(
  data
) {
  const candidates = [
    data?.permits,
    data?.records,
    data?.results,
    data?.data,
    data?.items
  ];

  for (
    const value
    of candidates
  ) {
    if (
      Array.isArray(value)
    ) {
      return value;
    }
  }

  return [];
}

function extractPermitCount(
  data
) {
  const direct = [
    data?.permitCount,
    data?.count,
    data?.total,
    data?.totalCount
  ];

  for (
    const value
    of direct
  ) {
    const n =
      finiteNumber(value);

    if (
      n !== null &&
      n >= 0
    ) {
      return Math.round(n);
    }
  }

  return (
    extractPermitArray(
      data
    ).length
  );
}

async function loadPermits(
  city,
  address
) {
  const lower =
    clean(city)
      .toLowerCase();

  if (
    lower.includes(
      "phoenix"
    )
  ) {
    return extractPermitCount(
      await postPublic(
        "/api/phx-permits",
        phoenixPermitPayload(
          address
        )
      )
    );
  }

  if (
    lower.includes(
      "paradise valley"
    )
  ) {
    return extractPermitCount(
      await postPublic(
        "/api/paradise-valley-permits",
        {
          address,
          fullAddress:
            address
        }
      )
    );
  }

  if (
    lower.includes(
      "scottsdale"
    )
  ) {
    return extractPermitCount(
      await postPublic(
        "/api/scottsdale-permits",
        {
          address,
          fullAddress:
            address
        }
      )
    );
  }

  if (
    lower.includes(
      "tempe"
    )
  ) {
    return extractPermitCount(
      await postPublic(
        "/api/tempe-permits",
        {
          address,
          fullAddress:
            address
        }
      )
    );
  }

  if (
    lower.includes(
      "gilbert"
    )
  ) {
    return extractPermitCount(
      await postPublic(
        "/api/gilbert-permits",
        {
          address,
          fullAddress:
            address
        }
      )
    );
  }

  if (
    lower.includes(
      "chandler"
    )
  ) {
    return extractPermitCount(
      await postPublic(
        "/api/chandler-permits",
        {
          address,
          fullAddress:
            address
        }
      )
    );
  }

  if (
    lower.includes(
      "peoria"
    )
  ) {
    return extractPermitCount(
      await postPublic(
        "/api/peoria-permits",
        {
          address,
          fullAddress:
            address
        }
      )
    );
  }

  if (
    lower.includes(
      "glendale"
    )
  ) {
    return extractPermitCount(
      await postPublic(
        "/api/glendale-permits",
        {
          address,
          fullAddress:
            address
        }
      )
    );
  }

  if (
    lower.includes(
      "goodyear"
    )
  ) {
    const data =
      await fetchJson(
        `${PUBLIC_BASE}/api/goodyear-permits?address=${encodeURIComponent(address)}`
      );

    return extractPermitCount(
      data
    );
  }

  if (
    lower.includes(
      "mesa"
    )
  ) {
    const [
      openData,
      legacy
    ] =
      await Promise.allSettled(
        [
          postPublic(
            "/api/mesa-permits",
            {
              address,
              fullAddress:
                address
            }
          ),

          postPublic(
            "/api/mesa-legacy-permits",
            {
              address,
              fullAddress:
                address
            }
          )
        ]
      );

    if (
      openData.status ===
        "rejected" &&
      legacy.status ===
        "rejected"
    ) {
      throw new Error(
        "Both Mesa permit sources failed."
      );
    }

    const seen =
      new Set();

    let count = 0;

    for (
      const result
      of [
        openData,
        legacy
      ]
    ) {
      if (
        result.status !==
        "fulfilled"
      ) {
        continue;
      }

      const rows =
        extractPermitArray(
          result.value
        );

      if (
        rows.length
      ) {
        for (
          const row
          of rows
        ) {
          const key =
            clean(
              row?.permitNumber ||
              row?.permit_number ||
              row?.PermitNumber ||
              row?.id ||
              JSON.stringify(row)
            );

          if (
            !seen.has(key)
          ) {
            seen.add(key);
            count += 1;
          }
        }
      } else {
        count +=
          extractPermitCount(
            result.value
          );
      }
    }

    return count;
  }

  throw new Error(
    `Permit source not configured for ${city || "this city"}.`
  );
}

async function arcgisPointQuery(
  queryUrl,
  lat,
  lon,
  {
    distanceMeters = null,
    outFields = "*"
  } = {}
) {
  const params =
    new URLSearchParams({
      f:
        "json",

      geometry:
        `${lon},${lat}`,

      geometryType:
        "esriGeometryPoint",

      inSR:
        "4326",

      spatialRel:
        "esriSpatialRelIntersects",

      outFields,

      returnGeometry:
        "false"
    });

  if (
    distanceMeters !==
    null
  ) {
    params.set(
      "distance",
      String(
        distanceMeters
      )
    );

    params.set(
      "units",
      "esriSRUnit_Meter"
    );
  }

  const data =
    await fetchJson(
      `${queryUrl}?${params.toString()}`,
      {},
      18000
    );

  if (
    data?.error
  ) {
    throw new Error(
      clean(
        data.error.message
      ) ||
      "ArcGIS query failed."
    );
  }

  return Array.isArray(
    data?.features
  )
    ? data.features
    : [];
}

async function loadEnvironmental(
  lat,
  lon
) {
  const result = {
    superfund:
      null,

    adeq:
      null
  };

  const [
    superfund,
    adeq
  ] =
    await Promise.allSettled(
      [
        (async () => {
          const inside =
            await arcgisPointQuery(
              SUPERFUND_QUERY,
              lat,
              lon,
              {
                outFields:
                  "CITY,COUNTY,NAME,TYPE,URL"
              }
            );

          if (
            inside.length
          ) {
            return {
              status:
                "Superfund: inside mapped area",

              miles:
                0,

              name:
                clean(
                  inside[0]
                    ?.attributes
                    ?.NAME
                )
            };
          }

          const nearby =
            await arcgisPointQuery(
              SUPERFUND_QUERY,
              lat,
              lon,
              {
                distanceMeters:
                  804.672,

                outFields:
                  "CITY,COUNTY,NAME,TYPE,URL"
              }
            );

          if (
            nearby.length
          ) {
            return {
              status:
                "Superfund: within 0.5 mi",

              miles:
                0.5,

              name:
                clean(
                  nearby[0]
                    ?.attributes
                    ?.NAME
                )
            };
          }

          return {
            status:
              "Superfund: clear (≤0.5 mi)",

            miles:
              null,

            name:
              null
          };
        })(),

        (async () => {
          const inside =
            await arcgisPointQuery(
              ADEQ_PLUME_QUERY,
              lat,
              lon,
              {
                outFields:
                  "*"
              }
            );

          if (
            inside.length
          ) {
            const a =
              inside[0]
                ?.attributes ||
              {};

            return {
              status:
                "ADEQ: inside mapped area",

              miles:
                0,

              name:
                clean(
                  a.NAME ||
                  a.SITE_NAME ||
                  a.SITENAME ||
                  a.PROJECT
                ) ||
                null
            };
          }

          const nearby =
            await arcgisPointQuery(
              ADEQ_PLUME_QUERY,
              lat,
              lon,
              {
                distanceMeters:
                  804.672,

                outFields:
                  "*"
              }
            );

          if (
            nearby.length
          ) {
            const a =
              nearby[0]
                ?.attributes ||
              {};

            return {
              status:
                "ADEQ: within 0.5 mi",

              miles:
                0.5,

              name:
                clean(
                  a.NAME ||
                  a.SITE_NAME ||
                  a.SITENAME ||
                  a.PROJECT
                ) ||
                null
            };
          }

          return {
            status:
              "ADEQ: clear",

            miles:
              null,

            name:
              null
          };
        })()
      ]
    );

  if (
    superfund.status ===
    "fulfilled"
  ) {
    result.superfund =
      superfund.value;

  } else {
    result.superfundError =
      superfund.reason
        ?.message ||
      "Superfund lookup failed.";
  }

  if (
    adeq.status ===
    "fulfilled"
  ) {
    result.adeq =
      adeq.value;

  } else {
    result.adeqError =
      adeq.reason
        ?.message ||
      "ADEQ lookup failed.";
  }

  return result;
}

async function loadFlood(
  lat,
  lon
) {
  const data =
    await fetchJson(
      `${PUBLIC_BASE}/api/maricopa-floodplain?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lon)}`
    );

  const floodplain =
    data?.floodplain ||
    data?.floodPlain ||
    {};

  const floodway =
    data?.floodway ||
    data?.floodWay ||
    {};

  function boolFrom(
    values
  ) {
    for (
      const v
      of values
    ) {
      if (
        v === true
      ) {
        return true;
      }

      if (
        v === false
      ) {
        return false;
      }

      const text =
        clean(v)
          .toLowerCase();

      if (
        text === "true" ||
        text === "yes" ||
        text === "inside" ||
        text === "in"
      ) {
        return true;
      }

      if (
        text === "false" ||
        text === "no" ||
        text === "outside" ||
        text === "out"
      ) {
        return false;
      }
    }

    return null;
  }

  const inFloodplain =
    boolFrom(
      [
        data?.inFloodplain,
        data?.insideFloodplain,
        floodplain?.inside,
        floodplain?.inFloodplain
      ]
    );

  const inFloodway =
    boolFrom(
      [
        data?.inFloodway,
        data?.insideFloodway,
        floodway?.inside,
        floodway?.inFloodway
      ]
    );

  const floodZone =
    clean(
      data?.floodZone ||
      data?.zone ||
      floodplain?.zone ||
      floodplain?.floodZone
    ) ||
    null;

  return {
    floodplainStatus:
      inFloodplain === true

        ? "Floodplain: INSIDE MAPPED AREA"

        : inFloodplain === false

          ? "Floodplain: OUTSIDE MAPPED AREA"

          : clean(
              data?.floodplainStatus ||
              floodplain?.status
            ) ||
            null,

    floodwayStatus:
      inFloodway === true

        ? "Floodway: INSIDE MAPPED AREA"

        : inFloodway === false

          ? "Floodway: OUTSIDE MAPPED AREA"

          : clean(
              data?.floodwayStatus ||
              floodway?.status
            ) ||
            null,

    floodZone
  };
}

async function loadZoning(
  city,
  lat,
  lon,
  parcel
) {
  if (
    parcel?.zoning
  ) {
    return {
      code:
        clean(
          parcel.zoning
        ),

      description:
        null,

      source:
        "County / Assessor parcel",

      jurisdiction:
        city ||
        parcel.jurisdiction ||
        null
    };
  }

  const lower =
    clean(city)
      .toLowerCase();

  if (
    lower.includes(
      "phoenix"
    )
  ) {
    const features =
      await arcgisPointQuery(
        PHX_ZONING_QUERY,
        lat,
        lon,
        {
          outFields:
            "LABEL1,ZONING,GEN_ZONE,ORD_NUM"
        }
      );

    const attrs =
      features[0]
        ?.attributes ||
      {};

    const code =
      clean(
        attrs.LABEL1 ||
        attrs.ZONING ||
        attrs.GEN_ZONE
      );

    if (!code) {
      throw new Error(
        "Phoenix zoning returned no zoning code."
      );
    }

    return {
      code,

      description:
        clean(
          attrs.GEN_ZONE
        ) ||
        null,

      source:
        "City of Phoenix zoning",

      jurisdiction:
        "Phoenix"
    };
  }

  const postPaths = [
    [
      "paradise valley",
      "/api/paradise-valley-zoning"
    ],
    [
      "scottsdale",
      "/api/scottsdale-zoning"
    ],
    [
      "glendale",
      "/api/glendale-zoning"
    ],
    [
      "peoria",
      "/api/peoria-zoning"
    ],
    [
      "gilbert",
      "/api/gilbert-zoning"
    ],
    [
      "chandler",
      "/api/chandler-zoning"
    ]
  ];

  for (
    const [
      cityKey,
      path
    ]
    of postPaths
  ) {
    if (
      !lower.includes(
        cityKey
      )
    ) {
      continue;
    }

    const data =
      await postPublic(
        path,
        {
          lat,
          lon
        }
      );

    const zoning =
      data?.zoning ||
      data?.data?.zoning ||
      data;

    const code =
      clean(
        zoning?.code ||
        zoning?.zoning ||
        zoning?.label ||
        zoning?.district ||
        data?.code
      );

    if (!code) {
      throw new Error(
        `${city} zoning returned no zoning code.`
      );
    }

    return {
      code,

      description:
        clean(
          zoning?.description ||
          zoning?.name
        ) ||
        null,

      source:
        `${city} zoning`,

      jurisdiction:
        city
    };
  }

  if (
    lower.includes(
      "goodyear"
    )
  ) {
    const data =
      await fetchJson(
        `${PUBLIC_BASE}/api/goodyear-zoning?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lon)}`
      );

    const code =
      clean(
        data?.zoning?.code ||
        data?.zoning ||
        data?.code
      );

    if (!code) {
      throw new Error(
        "Goodyear zoning returned no zoning code."
      );
    }

    return {
      code,

      description:
        clean(
          data?.zoning?.description ||
          data?.description
        ) ||
        null,

      source:
        "Goodyear zoning",

      jurisdiction:
        "Goodyear"
    };
  }

  throw new Error(
    `Zoning source not configured for ${city || "this city"}.`
  );
}

function overpassElementsPoint(
  elements
) {
  const points = [];

  for (
    const element
    of elements ||
    []
  ) {
    const lat =
      finiteNumber(
        element?.lat
      ) ??
      finiteNumber(
        element?.center?.lat
      );

    const lon =
      finiteNumber(
        element?.lon
      ) ??
      finiteNumber(
        element?.center?.lon
      );

    if (
      Number.isFinite(lat) &&
      Number.isFinite(lon)
    ) {
      points.push({
        lat,
        lon,

        tags:
          element?.tags ||
          {}
      });
    }
  }

  return points;
}

async function overpassNearest(
  lat,
  lon,
  kind
) {
  const radiusM =
    12875;

  let selectors = "";

  if (
    kind ===
    "railroad"
  ) {
    selectors = `
      node(around:${radiusM},${lat},${lon})["railway"="rail"];
      way(around:${radiusM},${lat},${lon})["railway"="rail"];
    `;

  } else {
    selectors = `
      node(around:${radiusM},${lat},${lon})["railway"="station"];
      node(around:${radiusM},${lat},${lon})["railway"="tram_stop"];
      node(around:${radiusM},${lat},${lon})["public_transport"="station"];
      way(around:${radiusM},${lat},${lon})["railway"="light_rail"];
      way(around:${radiusM},${lat},${lon})["railway"="subway"];
      way(around:${radiusM},${lat},${lon})["railway"="tram"];
    `;
  }

  const query = `
    [out:json][timeout:12];
    (
      ${selectors}
    );
    out center tags;
  `.trim();

  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () =>
        controller.abort(),

      14000
    );

  try {
    const response =
      await fetch(
        "https://overpass-api.de/api/interpreter",
        {
          method:
            "POST",

          headers: {
            "Content-Type":
              "application/x-www-form-urlencoded; charset=UTF-8",

            Accept:
              "application/json"
          },

          body:
            "data=" +
            encodeURIComponent(
              query
            ),

          signal:
            controller.signal
        }
      );

    const data =
      await response
        .json()
        .catch(
          () => null
        );

    if (
      !response.ok ||
      !data
    ) {
      throw new Error(
        `Overpass ${kind} HTTP ${response.status}`
      );
    }

    const points =
      overpassElementsPoint(
        data.elements
      );

    let best = null;

    for (
      const point
      of points
    ) {
      const miles =
        haversineMiles(
          lat,
          lon,
          point.lat,
          point.lon
        );

      if (
        !best ||
        miles <
          best.miles
      ) {
        best = {
          miles,

          name:
            clean(
              point.tags?.name ||
              point.tags?.operator ||
              point.tags?.network
            ) ||
            (
              kind ===
                "railroad"

                ? "Railroad"

                : "Transit"
            )
        };
      }
    }

    return best

      ? {
          name:
            best.name,

          miles:
            Number(
              best.miles
                .toFixed(2)
            )
        }

      : {
          name:
            kind ===
              "railroad"

              ? "Railroad"

              : "Transit",

          miles:
            null
        };

  } finally {
    clearTimeout(timer);
  }
}

function sqftStatus(
  countySqft,
  listingSqft
) {
  if (
    !Number.isFinite(
      countySqft
    ) ||
    countySqft <= 0
  ) {
    return null;
  }

  if (
    !Number.isFinite(
      listingSqft
    ) ||
    listingSqft <= 0
  ) {
    return (
      "SqFt: listing unavailable"
    );
  }

  const pct =
    Math.abs(
      listingSqft -
      countySqft
    ) /
    countySqft *
    100;

  return (
    pct > 10

      ? "SqFt: mismatch"

      : "SqFt: match"
  );
}

function additionsStatus(
  found
) {
  if (
    found === true
  ) {
    return (
      "Additions & Improvements Found"
    );
  }

  if (
    found === false
  ) {
    return (
      "Additions & Improvements: none found"
    );
  }

  return null;
}

function permitStatus(
  count
) {
  return (
    Number.isInteger(
      count
    )

      ? `Permits: ${count} found`

      : null
  );
}

/*
  Save into bluevera.org using the
  secure server-to-server key.

  The key never goes to the browser.
  It exists only in the server
  environment on bluevera.app and
  bluevera.org.
*/

async function saveIntelligence(
  payload
) {
  if (
    !BATCH_API_KEY
  ) {
    throw new Error(
      "BLUEVERA_BATCH_API_KEY is not configured on bluevera.app."
    );
  }

  return fetchJson(
    `${PUBLIC_BASE}/api/property-intelligence-save`,
    {
      method:
        "POST",

      headers: {
        "Content-Type":
          "application/json",

        "x-bluevera-batch-key":
          BATCH_API_KEY
      },

      body:
        JSON.stringify(
          payload
        )
    },

    20000
  );
}

async function processListing(
  listing
) {
  const started =
    Date.now();

  const tracker =
    makeSourceTracker();

  const result = {
    mlsNumber:
      listing.mlsNumber,

    address:
      listing.address,

    permits:
      "—",

    additions:
      "—",

    sqft:
      "—",

    zoning:
      "—",

    riskTransit:
      "—",

    status:
      "partial",

    durationMs:
      0,

    sourceStatuses:
      tracker.rows
  };

  if (
    !listing.address
  ) {
    result.status =
      "failed";

    result.error =
      "Listing address is missing.";

    result.durationMs =
      Date.now() -
      started;

    return result;
  }

  let parcel;

  try {
    parcel =
      await loadParcel(
        listing.address
      );

    tracker.success(
      "county_assessor"
    );

  } catch (error) {
    tracker.fail(
      "county_assessor",
      error?.message
    );

    result.status =
      "failed";

    result.error =
      "Unable to resolve county parcel/APN.";

    result.durationMs =
      Date.now() -
      started;

    return result;
  }

  const apn =
    cleanApn(
      parcel.apn
    );

  const city =
    detectCity(
      listing.address,
      parcel
    );

  const zip =
    detectZip(
      listing.address
    );

  const lat =
    finiteNumber(
      parcel.latitude
    );

  const lon =
    finiteNumber(
      parcel.longitude
    );

  const property = {
    mlsNumber:
      listing.mlsNumber ||
      null,

    address:
      listing.address,

    city:
      city ||
      null,

    county:
      "Maricopa County",

    state:
      "AZ",

    zip:
      zip ||
      null,

    apn:
      apn ||
      null,

    latitude:
      lat,

    longitude:
      lon
  };

  const intelligence = {};

  /*
    County / Assessor square footage
  */

  if (
    Number.isFinite(
      parcel.livingSqft
    ) &&
    parcel.livingSqft > 0
  ) {
    intelligence.countySqft =
      Math.round(
        parcel.livingSqft
      );

    intelligence.countySqftSource =
      "Maricopa County Assessor";
  }

  /*
    Run the independent sources
    after parcel identity is known.
  */

  const jobs = {
    sketch:
      apn

        ? loadCountySketch(
            apn
          )

        : Promise.reject(
            new Error(
              "APN unavailable."
            )
          ),

    listingSqft:
      loadListingSqft(
        listing.address
      ),

    permits:
      loadPermits(
        city,
        listing.address
      ),

    zoning:
      Number.isFinite(lat) &&
      Number.isFinite(lon)

        ? loadZoning(
            city,
            lat,
            lon,
            parcel
          )

        : Promise.reject(
            new Error(
              "Coordinates unavailable."
            )
          ),

    environment:
      Number.isFinite(lat) &&
      Number.isFinite(lon)

        ? loadEnvironmental(
            lat,
            lon
          )

        : Promise.reject(
            new Error(
              "Coordinates unavailable."
            )
          ),

    flood:
      Number.isFinite(lat) &&
      Number.isFinite(lon)

        ? loadFlood(
            lat,
            lon
          )

        : Promise.reject(
            new Error(
              "Coordinates unavailable."
            )
          ),

    railroad:
      Number.isFinite(lat) &&
      Number.isFinite(lon)

        ? overpassNearest(
            lat,
            lon,
            "railroad"
          )

        : Promise.reject(
            new Error(
              "Coordinates unavailable."
            )
          ),

    transit:
      Number.isFinite(lat) &&
      Number.isFinite(lon)

        ? overpassNearest(
            lat,
            lon,
            "transit"
          )

        : Promise.reject(
            new Error(
              "Coordinates unavailable."
            )
          )
  };

  const names =
    Object.keys(
      jobs
    );

  const settled =
    await Promise.allSettled(
      names.map(
        name =>
          jobs[name]
      )
    );

  const values = {};

  names.forEach(
    (
      name,
      index
    ) => {
      values[name] =
        settled[index];
    }
  );

  /*
    ADDITIONS & IMPROVEMENTS
  */

  if (
    values.sketch.status ===
    "fulfilled"
  ) {
    const found =
      additionsFromSketch(
        values.sketch.value
      );

    if (
      found !== null
    ) {
      intelligence.additionsImprovementsStatus =
        additionsStatus(
          found
        );

      const structures =
        values.sketch
          .value
          ?.structures;

      if (
        Array.isArray(
          structures
        )
      ) {
        intelligence.additionsImprovementsCount =
          found

            ? Math.max(
                1,
                structures.length -
                1
              )

            : 0;
      }

      tracker.success(
        "county_additions"
      );

      result.additions =
        found
          ? "Found"
          : "None found";

    } else {
      tracker.fail(
        "county_additions",
        "County sketch returned no definitive additions result."
      );
    }

  } else {
    tracker.fail(
      "county_additions",
      values.sketch
        .reason
        ?.message
    );
  }

  /*
    LISTING SQUARE FOOTAGE
  */

  if (
    values.listingSqft.status ===
    "fulfilled"
  ) {
    const listingSqft =
      values.listingSqft
        .value
        ?.sqft;

    if (
      Number.isFinite(
        listingSqft
      ) &&
      listingSqft > 0
    ) {
      intelligence.listingSqft =
        listingSqft;

      intelligence.listingSqftSource =
        "RentCast active listing";

      tracker.success(
        "rentcast_listing_sqft"
      );

    } else if (
      values.listingSqft
        .value
        ?.foundListing ===
      false
    ) {
      /*
        This is a successful lookup
        that simply found no listing sqft.
        We do NOT overwrite old good sqft.
      */

      tracker.success(
        "rentcast_listing_sqft"
      );
    }

    const countySqft =
      finiteNumber(
        intelligence.countySqft
      );

    const listing =
      finiteNumber(
        intelligence.listingSqft
      );

    intelligence.sqftStatus =
      sqftStatus(
        countySqft,
        listing
      );

    if (
      Number.isFinite(
        countySqft
      ) &&
      countySqft > 0 &&
      Number.isFinite(
        listing
      ) &&
      listing > 0
    ) {
      intelligence.sqftDifference =
        Math.round(
          listing -
          countySqft
        );

      intelligence.sqftDifferencePercent =
        Number(
          (
            (
              (
                listing -
                countySqft
              ) /
              countySqft
            ) *
            100
          ).toFixed(2)
        );

      result.sqft =
        intelligence.sqftStatus
          ?.replace(
            /^SqFt:\s*/i,
            ""
          ) ||
        `${countySqft}/${listing}`;

    } else {
      result.sqft =
        countySqft

          ? `County ${countySqft}`

          : "—";
    }

  } else {
    tracker.fail(
      "rentcast_listing_sqft",
      values.listingSqft
        .reason
        ?.message
    );

    result.sqft =
      intelligence.countySqft

        ? `County ${intelligence.countySqft}`

        : "—";
  }

  /*
    PERMITS
  */

  if (
    values.permits.status ===
    "fulfilled"
  ) {
    const count =
      integerValue(
        values.permits.value
      );

    if (
      count !== null &&
      count >= 0
    ) {
      intelligence.permitCount =
        count;

      intelligence.permitStatus =
        permitStatus(
          count
        );

      tracker.success(
        "permits"
      );

      result.permits =
        `${count} found`;

    } else {
      tracker.fail(
        "permits",
        "Permit source returned no count."
      );
    }

  } else {
    tracker.fail(
      "permits",
      values.permits
        .reason
        ?.message
    );
  }

  /*
    ZONING
  */

  if (
    values.zoning.status ===
    "fulfilled"
  ) {
    const zoning =
      values.zoning.value;

    if (
      clean(
        zoning?.code
      )
    ) {
      intelligence.zoningCode =
        clean(
          zoning.code
        );

      intelligence.zoningDescription =
        clean(
          zoning.description
        ) ||
        null;

      intelligence.zoningJurisdiction =
        clean(
          zoning.jurisdiction
        ) ||
        city ||
        null;

      intelligence.zoningSource =
        clean(
          zoning.source
        ) ||
        `${city || "Local"} zoning`;

      tracker.success(
        "zoning"
      );

      result.zoning =
        intelligence.zoningCode;

    } else {
      tracker.fail(
        "zoning",
        "Zoning source returned no code."
      );
    }

  } else {
    tracker.fail(
      "zoning",
      values.zoning
        .reason
        ?.message
    );
  }

  /*
    SUPERFUND / ADEQ
  */

  if (
    values.environment.status ===
    "fulfilled"
  ) {
    const env =
      values.environment.value;

    if (
      env.superfund
    ) {
      intelligence.superfundStatus =
        env.superfund.status;

      intelligence.superfundDistanceMiles =
        env.superfund.miles;

      intelligence.superfundSiteName =
        env.superfund.name;

      tracker.success(
        "superfund"
      );

    } else {
      tracker.fail(
        "superfund",
        env.superfundError
      );
    }

    if (
      env.adeq
    ) {
      intelligence.adeqStatus =
        env.adeq.status;

      intelligence.adeqDistanceMiles =
        env.adeq.miles;

      intelligence.adeqSiteName =
        env.adeq.name;

      tracker.success(
        "adeq"
      );

    } else {
      tracker.fail(
        "adeq",
        env.adeqError
      );
    }

  } else {
    tracker.fail(
      "superfund",
      values.environment
        .reason
        ?.message
    );

    tracker.fail(
      "adeq",
      values.environment
        .reason
        ?.message
    );
  }

  /*
    FLOODPLAIN / FLOODWAY
  */

  if (
    values.flood.status ===
    "fulfilled"
  ) {
    const flood =
      values.flood.value;

    if (
      clean(
        flood.floodplainStatus
      )
    ) {
      intelligence.floodplainStatus =
        flood.floodplainStatus;

      intelligence.floodplainZone =
        flood.floodZone ||
        null;

      tracker.success(
        "fema_floodplain"
      );

    } else {
      tracker.fail(
        "fema_floodplain",
        "Floodplain result unavailable."
      );
    }

    if (
      clean(
        flood.floodwayStatus
      )
    ) {
      intelligence.floodwayStatus =
        flood.floodwayStatus;

      tracker.success(
        "fema_floodway"
      );

    } else {
      tracker.fail(
        "fema_floodway",
        "Floodway result unavailable."
      );
    }

  } else {
    tracker.fail(
      "fema_floodplain",
      values.flood
        .reason
        ?.message
    );

    tracker.fail(
      "fema_floodway",
      values.flood
        .reason
        ?.message
    );
  }

  /*
    AIRPORT
  */

  if (
    Number.isFinite(lat) &&
    Number.isFinite(lon)
  ) {
    const airport =
      nearestAirport(
        lat,
        lon
      );

    if (
      airport
    ) {
      intelligence.airportStatus =
        airportStatusFromMiles(
          airport.miles
        );

      intelligence.airportDistanceMiles =
        airport.miles;

      intelligence.airportName =
        airport.name;

      tracker.success(
        "airport"
      );
    }

  } else {
    tracker.fail(
      "airport",
      "Coordinates unavailable."
    );
  }

  /*
    RAILROAD
  */

  if (
    values.railroad.status ===
    "fulfilled"
  ) {
    const rail =
      values.railroad.value;

    if (
      Number.isFinite(
        rail?.miles
      )
    ) {
      intelligence.railroadStatus =
        distanceStatus(
          "Railroad",
          rail.miles,
          {
            high:
              1,

            nearby:
              2
          }
        );

      intelligence.railroadDistanceMiles =
        rail.miles;

      intelligence.railroadName =
        rail.name;

      tracker.success(
        "railroad"
      );

    } else {
      intelligence.railroadStatus =
        "Railroad: clear";

      tracker.success(
        "railroad"
      );
    }

  } else {
    tracker.fail(
      "railroad",
      values.railroad
        .reason
        ?.message
    );
  }

  /*
    TRANSIT
  */

  if (
    values.transit.status ===
    "fulfilled"
  ) {
    const transit =
      values.transit.value;

    if (
      Number.isFinite(
        transit?.miles
      )
    ) {
      intelligence.transitStatus =
        distanceStatus(
          "Transit",
          transit.miles,
          {
            high:
              0.5,

            nearby:
              2
          }
        );

      intelligence.transitDistanceMiles =
        transit.miles;

      intelligence.transitName =
        transit.name;

      tracker.success(
        "transit"
      );

    } else {
      intelligence.transitStatus =
        "Transit: clear";

      tracker.success(
        "transit"
      );
    }

  } else {
    tracker.fail(
      "transit",
      values.transit
        .reason
        ?.message
    );
  }

  /*
    Display summary for the batch page.
  */

  const riskParts = [];

  if (
    intelligence.railroadStatus
  ) {
    riskParts.push(
      intelligence
        .railroadStatus
        .replace(
          /^Railroad:\s*/i,
          ""
        )
    );
  }

  if (
    intelligence.transitStatus
  ) {
    riskParts.push(
      intelligence
        .transitStatus
        .replace(
          /^Transit:\s*/i,
          ""
        )
    );
  }

  if (
    intelligence.superfundStatus
  ) {
    riskParts.push(
      intelligence
        .superfundStatus
        .replace(
          /^Superfund:\s*/i,
          ""
        )
    );
  }

  result.riskTransit =
    riskParts
      .slice(
        0,
        2
      )
      .join(
        " · "
      ) ||
    "—";

  /*
    Save through the protected
    bluevera.org endpoint.
  */

  try {
    const save =
      await saveIntelligence({
        property,

        intelligence,

        sourceStatuses:
          tracker.rows,

        source:
          "armls_property_intelligence_batch"
      });

    result.saved =
      save?.success !==
      false;

    result.propertyKey =
      save?.propertyKey ||
      null;

    result.changedFields =
      Array.isArray(
        save?.changedFields
      )

        ? save.changedFields

        : [];

  } catch (
    error
  ) {
    result.status =
      "failed";

    result.error =
      `Intelligence save failed: ${
        error?.message ||
        "Unknown error"
      }`;

    result.durationMs =
      Date.now() -
      started;

    return result;
  }

  const successfulSources =
    tracker.rows
      .filter(
        row =>
          row.status ===
          "success"
      )
      .length;

  const failedSources =
    tracker.rows
      .filter(
        row =>
          row.status ===
          "failed"
      )
      .length;

  result.status =
    successfulSources > 0 &&
    failedSources === 0

      ? "complete"

      : successfulSources > 0

        ? "partial"

        : "failed";

  result.durationMs =
    Date.now() -
    started;

  return result;
}

async function mapLimit(
  items,
  limit,
  worker
) {
  const results =
    new Array(
      items.length
    );

  let cursor = 0;

  async function runWorker() {
    while (true) {
      const index =
        cursor++;

      if (
        index >=
        items.length
      ) {
        return;
      }

      try {
        results[index] =
          await worker(
            items[index],
            index
          );

      } catch (
        error
      ) {
        results[index] = {
          mlsNumber:
            items[index]
              ?.mlsNumber ||
            "",

          address:
            items[index]
              ?.address ||
            "",

          permits:
            "—",

          additions:
            "—",

          sqft:
            "—",

          zoning:
            "—",

          riskTransit:
            "—",

          status:
            "failed",

          error:
            error?.message ||
            "Unexpected property processing error."
        };
      }
    }
  }

  const workers =
    Array.from(
      {
        length:
          Math.min(
            Math.max(
              1,
              limit
            ),
            items.length
          )
      },

      () =>
        runWorker()
    );

  await Promise.all(
    workers
  );

  return results;
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

  if (
    req.method !==
    "POST"
  ) {
    res.setHeader(
      "Allow",
      "POST"
    );

    return res
      .status(405)
      .json({
        success:
          false,

        error:
          "Method not allowed. Use POST."
      });
  }

  /*
    Do not let the batch silently run
    without the server authorization key.
  */

  if (
    !BATCH_API_KEY
  ) {
    return res
      .status(500)
      .json({
        success:
          false,

        error:
          "BLUEVERA_BATCH_API_KEY is not configured on bluevera.app."
      });
  }

  try {
    const body =
      req.body &&
      typeof req.body ===
        "object"

        ? req.body

        : {};

    const rawListings =
      Array.isArray(
        body.listings
      )

        ? body.listings

        : [];

    const listings =
      rawListings
        .map(
          normalizeListing
        )
        .filter(
          item =>
            item.address
        )
        .slice(
          0,
          MAX_BATCH
        );

    if (
      !listings.length
    ) {
      return res
        .status(400)
        .json({
          success:
            false,

          error:
            "No valid listings were supplied."
        });
    }

    const requestedBatchSize =
      integerValue(
        body.batchSize
      ) ||
      1;

    /*
      The page can request 5, 10 or 25,
      but the server intentionally limits
      true simultaneous property processing
      to three properties.
    */

    const concurrency =
      Math.max(
        1,
        Math.min(
          PROPERTY_CONCURRENCY,
          requestedBatchSize
        )
      );

    const pauseMs =
      Math.max(
        0,
        Math.min(
          integerValue(
            body.pauseMs
          ) ||
          0,

          5000
        )
      );

    const startedAt =
      new Date()
        .toISOString();

    const results =
      await mapLimit(
        listings,
        concurrency,

        async listing => {
          const value =
            await processListing(
              listing
            );

          if (
            pauseMs > 0
          ) {
            await sleep(
              pauseMs
            );
          }

          return value;
        }
      );

    const complete =
      results
        .filter(
          item =>
            item.status ===
            "complete"
        )
        .length;

    const partial =
      results
        .filter(
          item =>
            item.status ===
            "partial"
        )
        .length;

    const failed =
      results
        .filter(
          item =>
            item.status ===
            "failed"
        )
        .length;

    return res
      .status(200)
      .json({
        success:
          true,

        requested:
          rawListings.length,

        accepted:
          listings.length,

        capped:
          rawListings.length >
          MAX_BATCH,

        maxBatch:
          MAX_BATCH,

        concurrency,

        startedAt,

        finishedAt:
          new Date()
            .toISOString(),

        summary: {
          complete,
          partial,
          failed
        },

        results
      });

  } catch (
    error
  ) {
    console.error(
      "property-intelligence-batch-run error:",
      error
    );

    return res
      .status(500)
      .json({
        success:
          false,

        error:
          error?.message ||
          "Property intelligence batch failed."
      });
  }
}

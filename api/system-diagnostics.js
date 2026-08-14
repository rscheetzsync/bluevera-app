// api/system-diagnostics.js
// BlueVera restricted admin diagnostics API.
//
// Actions:
//   GET ?action=health
//   GET ?action=property&address=<property address>
//
// This endpoint does not expose environment values or secret keys.
// It reuses the same admin-authentication pattern as admin-property-errors.js.

const SUPABASE_URL = String(
  process.env.SUPABASE_URL || ""
).replace(/\/+$/, "");

const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  "";

const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  "";

const PUBLIC_SITE_URL = String(
  process.env.BLUEVERA_PUBLIC_SITE_URL ||
  "https://bluevera.org"
).replace(/\/+$/, "");

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function send(res, status, body) {
  return res.status(status).json(body);
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
    .replace(/\btrail\b/g, "trl")
    .replace(/\bhighway\b/g, "hwy")
    .replace(/\b(arizona|az|united states|usa)\b/g, " ")
    .replace(/\b\d{5}(?:-\d{4})?\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function streetParts(value) {
  const normalized = normalizeAddress(value);

  const parts = normalized
    .split(" ")
    .filter(Boolean);

  const number =
    parts.find(part =>
      /^\d+[a-z]?$/.test(part)
    ) || "";

  const words = parts.filter(part =>
    !/^\d+[a-z]?$/.test(part) &&
    ![
      "phoenix",
      "scottsdale",
      "tempe",
      "mesa",
      "glendale",
      "chandler",
      "gilbert",
      "peoria",
      "paradise",
      "valley",
      "maricopa",
      "county"
    ].includes(part)
  );

  return {
    normalized,
    number,
    words
  };
}

function addressesMatch(
  searchAddress,
  storedAddress
) {
  const a = streetParts(searchAddress);
  const b = streetParts(storedAddress);

  if (
    !a.number ||
    !b.number ||
    a.number !== b.number
  ) {
    return false;
  }

  if (
    a.normalized ===
    b.normalized
  ) {
    return true;
  }

  if (
    a.normalized.includes(
      b.normalized
    ) ||
    b.normalized.includes(
      a.normalized
    )
  ) {
    return true;
  }

  const shared =
    b.words.filter(
      word =>
        word.length >= 3 &&
        a.words.includes(word)
    );

  return shared.length >= 1;
}

async function rest(
  path,
  options = {}
) {
  const response = await fetch(
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
      data?.hint ||
      text ||
      `Supabase request failed (${response.status}).`
    );
  }

  return data;
}

async function verifyAdmin(req) {
  const token = clean(
    req.headers.authorization
  ).replace(
    /^Bearer\s+/i,
    ""
  );

  if (!token) {
    throw new Error(
      "Admin authentication token is missing."
    );
  }

  const response = await fetch(
    `${SUPABASE_URL}/auth/v1/user`,
    {
      headers: {
        apikey:
          ANON_KEY,

        Authorization:
          `Bearer ${token}`
      }
    }
  );

  const user =
    await response
      .json()
      .catch(() => null);

  if (
    !response.ok ||
    !user?.id
  ) {
    throw new Error(
      "The admin login session is invalid or expired."
    );
  }

  const admins = await rest(
    "admin_users?select=*",
    {
      method: "GET"
    }
  );

  const email =
    clean(user.email)
      .toLowerCase();

  const admin = (
    Array.isArray(admins)
      ? admins
      : []
  ).find(row => {
    const ids = [
      row.id,
      row.auth_user_id,
      row.user_id
    ].map(clean);

    const emails = [
      row.email,
      row.admin_email,
      row.username
    ].map(
      value =>
        clean(value)
          .toLowerCase()
    );

    return (
      ids.includes(user.id) ||
      (
        email &&
        emails.includes(email)
      )
    );
  });

  if (!admin) {
    throw new Error(
      "This authenticated account is not authorized as a BlueVera admin."
    );
  }

  const status = clean(
    admin.status ||
    admin.account_status ||
    "active"
  ).toLowerCase();

  if (
    [
      "disabled",
      "inactive",
      "suspended",
      "denied"
    ].includes(status)
  ) {
    throw new Error(
      "This BlueVera admin account is not active."
    );
  }

  return {
    user,
    admin
  };
}

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = 12000
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () =>
        controller.abort(),
      timeoutMs
    );

  try {
    return await fetch(
      url,
      {
        ...options,

        signal:
          controller.signal,

        headers: {
          "Accept":
            "application/json,text/plain,*/*",

          ...(options.headers || {})
        }
      }
    );
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonDiagnostic(
  url,
  options = {},
  timeoutMs = 12000
) {
  const started =
    Date.now();

  try {
    const response =
      await fetchWithTimeout(
        url,
        options,
        timeoutMs
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

    return {
      reachable: true,
      ok:
        response.ok,
      status:
        response.status,
      ms:
        Date.now() -
        started,
      data
    };
  } catch (error) {
    return {
      reachable: false,
      ok: false,
      status: 0,
      ms:
        Date.now() -
        started,

      error:
        error?.name ===
        "AbortError"
          ? "Request timed out."
          : clean(
              error?.message ||
              error
            )
    };
  }
}

function check(
  status,
  message,
  extra = {}
) {
  return {
    status,
    message,
    ...extra
  };
}

async function probeRoute(
  url,
  expectedStatuses = [
    200,
    400,
    405
  ]
) {
  const result =
    await fetchJsonDiagnostic(
      url,
      {},
      10000
    );

  if (!result.reachable) {
    return check(
      "fail",
      result.error ||
        "Endpoint could not be reached.",
      {
        httpStatus:
          result.status,
        responseMs:
          result.ms
      }
    );
  }

  if (
    expectedStatuses.includes(
      result.status
    )
  ) {
    return check(
      "pass",

      `Endpoint reachable (${result.status}) in ${result.ms} ms. Run a property test for live property-data validation.`,

      {
        httpStatus:
          result.status,
        responseMs:
          result.ms
      }
    );
  }

  if (
    result.status >= 500
  ) {
    return check(
      "fail",
      `Endpoint returned HTTP ${result.status}.`,
      {
        httpStatus:
          result.status,
        responseMs:
          result.ms
      }
    );
  }

  return check(
    "warn",
    `Endpoint returned HTTP ${result.status}.`,
    {
      httpStatus:
        result.status,
      responseMs:
        result.ms
    }
  );
}

function ownBaseUrl(req) {
  const proto =
    clean(
      req.headers[
        "x-forwarded-proto"
      ]
    ) ||
    "https";

  const host =
    clean(
      req.headers[
        "x-forwarded-host"
      ]
    ) ||
    clean(
      req.headers.host
    );

  return host
    ? `${proto}://${host}`
    : "https://bluevera.app";
}

async function healthChecks(req) {
  const checks = {};

  try {
    await rest(
      "properties?select=id&limit=1",
      {
        method: "GET"
      }
    );

    checks.supabase = check(
      "pass",

      "Supabase is reachable and the central properties table can be read."
    );
  } catch (error) {
    checks.supabase = check(
      "fail",

      `Supabase/property table check failed: ${clean(error.message)}`
    );
  }

  try {
    await rest(
      "property_current_ratings?select=property_id&limit=1",
      {
        method: "GET"
      }
    );

    checks.centralProperty =
      check(
        "pass",

        "Central property/rating data layer is reachable."
      );
  } catch (error) {
    checks.centralProperty =
      check(
        "fail",

        `Central property hub data check failed: ${clean(error.message)}`
      );
  }

  const ownBase =
    ownBaseUrl(req);

  checks.ratings =
    await probeRoute(
      `${ownBase}/api/recalculate-property-rating`,
      [
        400,
        405
      ]
    );

  checks.maricopaParcel =
    await probeRoute(
      `${PUBLIC_SITE_URL}/api/maricopa-parcel`,
      [
        400,
        405
      ]
    );

  checks.countySketch =
    await probeRoute(
      `${PUBLIC_SITE_URL}/api/county-sketch`,
      [
        400,
        405
      ]
    );

  checks.rentcast =
    await probeRoute(
      `${PUBLIC_SITE_URL}/api/rentcast`,
      [
        400,
        405
      ]
    );

  checks.permits =
    await probeRoute(
      `${PUBLIC_SITE_URL}/api/phx-permits`,
      [
        400,
        405
      ]
    );

  /*
    Capital Exposure intentionally stays WARNING
    until BlueVera returns one authoritative
    exposure value directly from the central API.
  */
  checks.capital =
    check(
      "warn",

      "Capital exposure is not yet exposed by one authoritative central API. Cross-page consistency cannot be guaranteed until that is centralized."
    );

  return checks;
}

async function loadMatchingProperties(
  address
) {
  const rows = await rest(
    "properties?select=*&order=created_at.desc&limit=1000",
    {
      method: "GET"
    }
  );

  const matches = (
    Array.isArray(rows)
      ? rows
      : []
  ).filter(row =>
    addressesMatch(
      address,

      row.full_address ||
      row.address ||
      row.street ||
      ""
    )
  );

  const normalizedTarget =
    normalizeAddress(
      address
    );

  matches.sort(
    (a, b) => {
      const aExact =
        normalizeAddress(
          a.full_address ||
          a.address ||
          a.street ||
          ""
        ) ===
        normalizedTarget
          ? 1
          : 0;

      const bExact =
        normalizeAddress(
          b.full_address ||
          b.address ||
          b.street ||
          ""
        ) ===
        normalizedTarget
          ? 1
          : 0;

      if (
        bExact !==
        aExact
      ) {
        return (
          bExact -
          aExact
        );
      }

      const aRated =
        a.rating_updated_at &&
        a.current_rating !==
          null &&
        a.current_rating !==
          undefined
          ? 1
          : 0;

      const bRated =
        b.rating_updated_at &&
        b.current_rating !==
          null &&
        b.current_rating !==
          undefined
          ? 1
          : 0;

      if (
        bRated !==
        aRated
      ) {
        return (
          bRated -
          aRated
        );
      }

      const aUpdated =
        Date.parse(
          a.rating_updated_at ||
          a.updated_at ||
          a.created_at ||
          0
        ) || 0;

      const bUpdated =
        Date.parse(
          b.rating_updated_at ||
          b.updated_at ||
          b.created_at ||
          0
        ) || 0;

      return (
        bUpdated -
        aUpdated
      );
    }
  );

  return matches;
}

async function runPropertyDiagnostics(
  address
) {
  const failures = [];
  const checks = {};

  const matches =
    await loadMatchingProperties(
      address
    );

  const property =
    matches[0] ||
    null;

  if (!property?.id) {
    return {
      property: {
        requestedAddress:
          address,

        propertyId: "",

        apn: "",

        duplicateCount:
          0,

        rating:
          null,

        capitalExposure:
          "Not centralized",

        additionsStatus:
          "Not tested"
      },

      checks: {
        centralProperty:
          check(
            "fail",

            "No matching central property record was found."
          )
      },

      failures: [
        {
          module:
            "Central Property",

          problem:
            "No matching central property record was found.",

          status:
            "fail"
        }
      ]
    };
  }

  checks.centralProperty =
    check(
      "pass",

      `Central property found: ${property.id}.`
    );

  if (
    matches.length > 1
  ) {
    checks.duplicates =
      check(
        "warn",

        `${matches.length} central property rows matched this physical address.`
      );

    failures.push({
      module:
        "Property Identity",

      problem:
        `${matches.length} central property rows matched this address.`,

      status:
        "warn"
    });
  } else {
    checks.duplicates =
      check(
        "pass",

        "One central property record matched this address."
      );
  }

  const apn =
    clean(
      property.apn
    );

  if (apn) {
    checks.apn =
      check(
        "pass",

        `Central APN: ${apn}.`
      );
  } else {
    checks.apn =
      check(
        "warn",

        "The central property record does not contain an APN."
      );

    failures.push({
      module:
        "Property Identity",

      problem:
        "Central property APN is missing.",

      status:
        "warn"
    });
  }

  let rating =
    null;

  try {
    const ratingRows =
      await rest(
        `property_current_ratings?property_id=eq.${encodeURIComponent(
          property.id
        )}&select=*&limit=1`,
        {
          method:
            "GET"
        }
      );

    const ratingRow =
      Array.isArray(
        ratingRows
      )
        ? ratingRows[0] ||
          null
        : null;

    if (ratingRow) {
      rating =
        Number(
          ratingRow
            .disclosure_rating
        );

      checks.rating =
        check(
          Number.isFinite(
            rating
          )
            ? "pass"
            : "warn",

          Number.isFinite(
            rating
          )
            ? `Authoritative rating: ${rating}/100. Formula: ${
                clean(
                  ratingRow
                    .formula_version
                ) ||
                "version not recorded"
              }.`
            : "A rating row exists but disclosure_rating is not numeric."
        );
    } else {
      checks.rating =
        check(
          "warn",

          "No authoritative property_current_ratings row was found."
        );

      failures.push({
        module:
          "Rating",

        problem:
          "No authoritative rating row was found.",

        status:
          "warn"
      });
    }
  } catch (error) {
    checks.rating =
      check(
        "fail",

        `Rating lookup failed: ${clean(
          error.message
        )}`
      );

    failures.push({
      module:
        "Rating",

      problem:
        clean(
          error.message
        ),

      status:
        "fail"
    });
  }

  /*
    Verify that BlueVera.org central-property-report
    resolves this same canonical property.
  */
  const bridgeUrl =
    `${PUBLIC_SITE_URL}/api/central-property-report` +
    `?propertyId=${encodeURIComponent(
      property.id
    )}` +
    `&address=${encodeURIComponent(
      address
    )}`;

  const bridge =
    await fetchJsonDiagnostic(
      bridgeUrl,
      {},
      15000
    );

  if (
    bridge.reachable &&
    bridge.ok &&
    bridge.data?.success !==
      false
  ) {
    const bridgePropertyId =
      clean(
        bridge.data
          ?.property
          ?.id ||
        bridge.data
          ?.propertyId ||
        bridge.data
          ?.data
          ?.property
          ?.id
      );

    if (
      !bridgePropertyId ||
      bridgePropertyId ===
        clean(
          property.id
        )
    ) {
      checks.publicBridge =
        check(
          "pass",

          "BlueVera.org central-property bridge responded successfully for the canonical property."
        );
    } else {
      checks.publicBridge =
        check(
          "fail",

          `Public bridge returned property ${bridgePropertyId}, but central property is ${property.id}.`
        );

      failures.push({
        module:
          "Central Property Bridge",

        problem:
          "Public property bridge returned a different property ID.",

        status:
          "fail"
      });
    }
  } else {
    checks.publicBridge =
      check(
        "fail",

        `Central-property bridge failed${
          bridge.status
            ? ` (HTTP ${bridge.status})`
            : ""
        }.`
      );

    failures.push({
      module:
        "Central Property Bridge",

      problem:
        checks.publicBridge
          .message,

      status:
        "fail"
    });
  }

  /*
    Live Maricopa parcel lookup.
  */
  const parcel =
    await fetchJsonDiagnostic(
      `${PUBLIC_SITE_URL}/api/maricopa-parcel?address=${encodeURIComponent(
        address
      )}`,
      {},
      18000
    );

  let parcelApn = "";

  if (
    parcel.reachable &&
    parcel.ok &&
    parcel.data?.ok !==
      false
  ) {
    parcelApn =
      clean(
        parcel.data
          ?.parcel
          ?.apn ||
        parcel.data
          ?.apn ||
        parcel.data
          ?.data
          ?.apn
      );

    if (
      apn &&
      parcelApn &&
      parcelApn.replace(
        /\D/g,
        ""
      ) !==
        apn.replace(
          /\D/g,
          ""
        )
    ) {
      checks.maricopaParcel =
        check(
          "fail",

          `Parcel APN mismatch. Central: ${apn}; live county: ${parcelApn}.`
        );

      failures.push({
        module:
          "Maricopa Parcel",

        problem:
          checks.maricopaParcel
            .message,

        status:
          "fail"
      });
    } else {
      checks.maricopaParcel =
        check(
          "pass",

          parcelApn
            ? `Live Maricopa parcel lookup succeeded. APN: ${parcelApn}.`
            : "Live Maricopa parcel lookup succeeded."
        );
    }
  } else {
    checks.maricopaParcel =
      check(
        "fail",

        `Live parcel lookup failed${
          parcel.status
            ? ` (HTTP ${parcel.status})`
            : ""
        }.`
      );

    failures.push({
      module:
        "Maricopa Parcel",

      problem:
        checks.maricopaParcel
          .message,

      status:
        "fail"
    });
  }

  /*
    County Sketch / Additions deep test.
  */
  let additionsStatus =
    "Not tested";

  const sketchApn =
    apn ||
    parcelApn;

  if (sketchApn) {
    const sketch =
      await fetchJsonDiagnostic(
        `${PUBLIC_SITE_URL}/api/county-sketch?apn=${encodeURIComponent(
          sketchApn
        )}`,
        {},
        30000
      );

    if (
      sketch.reachable &&
      sketch.ok &&
      sketch.data?.success ===
        true
    ) {
      if (
        sketch.data
          .sketchAvailable ===
        false
      ) {
        additionsStatus =
          "No county sketch available";

        checks.countySketch =
          check(
            "warn",

            "County service responded successfully, but no sketch exists for this APN."
          );
      } else {
        const hasAddition =
          sketch.data
            .hasAddition ===
            true ||
          sketch.data
            .hasImprovementSignal ===
            true;

        additionsStatus =
          hasAddition
            ? "FOUND"
            : "NOT FOUND";

        checks.countySketch =
          check(
            "pass",

            hasAddition
              ? "County sketch loaded and addition/improvement signals were found."
              : "County sketch loaded and no addition/improvement signal was found."
          );
      }
    } else {
      const message =
        clean(
          sketch.data
            ?.error
        ) ||
        clean(
          sketch.error
        ) ||
        `County sketch failed${
          sketch.status
            ? ` (HTTP ${sketch.status})`
            : ""
        }.`;

      additionsStatus =
        sketch.status ===
        503
          ? "Service dependency unavailable"
          : "County sketch failed";

      checks.countySketch =
        check(
          sketch.status ===
            503
            ? "warn"
            : "fail",

          message
        );

      failures.push({
        module:
          "County Sketch / Additions",

        problem:
          message,

        status:
          sketch.status ===
            503
            ? "warn"
            : "fail"
      });
    }
  } else {
    checks.countySketch =
      check(
        "warn",

        "County sketch was not tested because no APN is available."
      );
  }

  /*
    RentCast listing data check.
  */
  const rentcast =
    await fetchJsonDiagnostic(
      `${PUBLIC_SITE_URL}/api/rentcast?address=${encodeURIComponent(
        address
      )}&mode=sale`,
      {},
      15000
    );

  if (
    rentcast.reachable &&
    rentcast.ok
  ) {
    checks.rentcast =
      check(
        "pass",

        `RentCast responded successfully in ${rentcast.ms} ms.`
      );
  } else {
    checks.rentcast =
      check(
        rentcast.status ===
          404
          ? "warn"
          : "fail",

        `RentCast request failed${
          rentcast.status
            ? ` (HTTP ${rentcast.status})`
            : ""
        }.`
      );

    failures.push({
      module:
        "RentCast",

      problem:
        checks.rentcast
          .message,

      status:
        checks.rentcast
          .status
    });
  }

  /*
    Phoenix permits.
  */
  if (
    /\bphoenix\b/i.test(
      address
    )
  ) {
    const permits =
      await fetchJsonDiagnostic(
        `${PUBLIC_SITE_URL}/api/phx-permits?address=${encodeURIComponent(
          address
        )}`,
        {},
        18000
      );

    if (
      permits.reachable &&
      permits.ok
    ) {
      checks.permits =
        check(
          "pass",

          `Phoenix permit endpoint responded successfully in ${permits.ms} ms.`
        );
    } else {
      checks.permits =
        check(
          "fail",

          `Phoenix permit lookup failed${
            permits.status
              ? ` (HTTP ${permits.status})`
              : ""
          }.`
        );

      failures.push({
        module:
          "Permits",

        problem:
          checks.permits
            .message,

        status:
          "fail"
      });
    }
  } else {
    checks.permits =
      check(
        "warn",

        "Phoenix permit deep test skipped because the address does not identify Phoenix."
      );
  }

  /*
    Current architecture warning.
    We are NOT fabricating a capital exposure result.
  */
  checks.capital =
    check(
      "warn",

      "Capital exposure is still page-owned rather than returned by the central property API. This diagnostic will remain a warning until one authoritative capital-exposure result is centralized."
    );

  failures.push({
    module:
      "Capital Exposure",

    problem:
      checks.capital
        .message,

    status:
      "warn"
  });

  return {
    property: {
      requestedAddress:
        address,

      matchedAddress:
        property.full_address ||
        property.address ||
        property.street ||
        "",

      propertyId:
        property.id,

      apn:
        apn ||
        parcelApn,

      duplicateCount:
        Math.max(
          0,
          matches.length - 1
        ),

      matchingPropertyCount:
        matches.length,

      matchingPropertyIds:
        matches
          .map(
            item =>
              item.id
          )
          .filter(Boolean),

      rating:
        Number.isFinite(
          rating
        )
          ? rating
          : null,

      capitalExposure:
        "Not centralized",

      additionsStatus
    },

    checks,

    failures
  };
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
    !SUPABASE_URL ||
    !SERVICE_KEY ||
    !ANON_KEY
  ) {
    return send(
      res,
      500,
      {
        success: false,

        error:
          "Supabase server environment variables are not configured."
      }
    );
  }

  if (
    req.method !==
    "GET"
  ) {
    res.setHeader(
      "Allow",
      "GET"
    );

    return send(
      res,
      405,
      {
        success: false,
        error:
          "Method not allowed."
      }
    );
  }

  try {
    await verifyAdmin(req);

    const action =
      clean(
        req.query.action ||
        "health"
      ).toLowerCase();

    if (
      action ===
      "health"
    ) {
      const checks =
        await healthChecks(
          req
        );

      return send(
        res,
        200,
        {
          success: true,

          checkedAt:
            new Date()
              .toISOString(),

          checks
        }
      );
    }

    if (
      action ===
      "property"
    ) {
      const address =
        clean(
          req.query.address
        );

      if (!address) {
        return send(
          res,
          400,
          {
            success: false,

            error:
              "A property address is required."
          }
        );
      }

      const result =
        await runPropertyDiagnostics(
          address
        );

      return send(
        res,
        200,
        {
          success: true,

          checkedAt:
            new Date()
              .toISOString(),

          ...result
        }
      );
    }

    return send(
      res,
      400,
      {
        success: false,

        error:
          "Unknown diagnostics action."
      }
    );

  } catch (error) {
    console.error(
      "system-diagnostics API error:",
      error
    );

    const message =
      clean(
        error?.message
      ) ||
      "The diagnostics request failed.";

    const status =
      /authentication|session|authorized|admin account/i
        .test(message)
        ? 401
        : 500;

    return send(
      res,
      status,
      {
        success: false,
        error:
          message
      }
    );
  }
}

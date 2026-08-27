import {
  loadPropertyEvidence
} from "../lib/property-evidence.js";

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

function clean(value) {
  return String(value ?? "").trim();
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
      () => controller.abort(),
      timeoutMs
    );

  try {
    return await fetch(
      url,
      {
        ...options,
        signal:
          options.signal ||
          controller.signal
      }
    );
  } catch (error) {
    if (
      error?.name ===
      "AbortError"
    ) {
      throw new Error(
        "The database request timed out. Please try again."
      );
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}


/* =========================================================
   SUPABASE REQUEST
   ========================================================= */

async function rest(
  path,
  options = {}
) {
  const response = await fetchWithTimeout(
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



/* =========================================================
   SAFE CENTRAL PROPERTY SEARCH
   ========================================================= */

function uniqueProperties(rows) {
  const seen =
    new Set();

  return (
    Array.isArray(rows)
      ? rows
      : []
  ).filter(row => {
    const id =
      clean(row?.id);

    if (
      !id ||
      seen.has(id)
    ) {
      return false;
    }

    seen.add(id);
    return true;
  });
}

async function searchCentralProperties(query) {
  const q =
    clean(query)
      .replace(/[%*]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  if (!q) {
    return [];
  }

  const uuidLike =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(q);

  if (uuidLike) {
    const exactRows =
      await rest(
        `properties?id=eq.${encodeURIComponent(q)}&select=*&limit=1`,
        {
          method: "GET"
        }
      );

    if (
      Array.isArray(exactRows) &&
      exactRows.length
    ) {
      return exactRows;
    }
  }

  const pattern =
    encodeURIComponent(
      `*${q}*`
    );

  /*
    Keep the admin search independent from the shared evidence
    loader. This prevents a property-search problem from blocking
    the entire Rating Manager and keeps the search request small.
  */
  const attempts = [
    `properties?full_address=ilike.${pattern}&select=*&limit=25`,
    `properties?address=ilike.${pattern}&select=*&limit=25`,
    `properties?street=ilike.${pattern}&select=*&limit=25`,
    `properties?apn=ilike.${pattern}&select=*&limit=25`
  ];

  const collected = [];
  let lastError = null;

  for (
    const path of attempts
  ) {
    try {
      const rows =
        await rest(
          path,
          {
            method: "GET"
          }
        );

      if (
        Array.isArray(rows) &&
        rows.length
      ) {
        collected.push(
          ...rows
        );
      }
    } catch (error) {
      /*
        One optional property column may not exist in every
        historical schema. Continue to the next safe lookup.
      */
      lastError = error;
    }
  }

  const unique =
    uniqueProperties(
      collected
    );

  if (unique.length) {
    return unique.slice(
      0,
      25
    );
  }

  if (
    lastError &&
    /timed out/i.test(
      clean(
        lastError.message
      )
    )
  ) {
    throw lastError;
  }

  return [];
}


/* =========================================================
   VERIFY ADMIN
   ========================================================= */

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

  const response = await fetchWithTimeout(
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
    clean(
      user.email
    ).toLowerCase();

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
    ].map(value =>
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


/* =========================================================
   CENTRAL RATING RECALCULATION
   ========================================================= */

async function callCentralRecalculation(
  req,
  propertyId
) {
  const origin = new URL(
    req.url,
    `https://${req.headers.host}`
  ).origin;

  const response = await fetchWithTimeout(
    `${origin}/api/recalculate-property-rating`,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",

        Authorization:
          req.headers.authorization
      },

      body:
        JSON.stringify({
          propertyId
        })
    },
    20000
  );

  const result =
    await response
      .json()
      .catch(() => ({}));

  if (
    !response.ok ||
    !result.success
  ) {
    throw new Error(
      result.error ||
      "The central property rating could not be recalculated."
    );
  }

  return result;
}


/* =========================================================
   SAVE ADMIN ADJUSTMENT
   ========================================================= */

async function saveAdjustment(
  propertyId,
  points,
  reason,
  adminContext
) {
  const value =
    Number(points);

  if (
    !Number.isInteger(value) ||
    value < -25 ||
    value > 25
  ) {
    throw new Error(
      "Adjustment must be a whole number from -25 to 25."
    );
  }

  if (
    clean(reason).length < 12
  ) {
    throw new Error(
      "A specific adjustment reason is required."
    );
  }

  const payload = {
    property_id:
      clean(propertyId),

    adjustment_points:
      value,

    reason:
      clean(reason),

    created_by:
      adminContext.user.id,

    admin_email:
      adminContext.user.email ||
      null,

    created_at:
      new Date()
        .toISOString()
  };

  const rows = await rest(
    "property_rating_adjustments",
    {
      method: "POST",

      headers: {
        Prefer:
          "return=representation"
      },

      body:
        JSON.stringify(payload)
    }
  );

  return Array.isArray(rows)
    ? rows[0]
    : rows;
}


/* =========================================================
   API HANDLER
   ========================================================= */

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
    return res
      .status(500)
      .json({
        success: false,

        error:
          "Supabase server environment variables are not configured."
      });
  }

  try {
    const adminContext =
      await verifyAdmin(req);

    /* =========================
       GET REQUESTS
       ========================= */

    if (
      req.method ===
      "GET"
    ) {
      const action =
        clean(
          req.query.action
        );

      /* Search central properties */

      if (
        action ===
        "search"
      ) {
        const properties =
          await searchCentralProperties(
            req.query.q
          );

        return res
          .status(200)
          .json({
            success: true,
            properties
          });
      }

      /* Load central evidence ledger */

      if (
        action ===
        "load"
      ) {
        const propertyId =
          clean(
            req.query.id
          );

        if (!propertyId) {
          return res
            .status(400)
            .json({
              success: false,

              error:
                "A property ID is required."
            });
        }

        const result =
          await loadPropertyEvidence(
            {
              propertyId,

              includePrivateFields:
                true,

              includeAdjustments:
                true,

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

        return res
          .status(200)
          .json({
            success: true,
            ...result
          });
      }

      return res
        .status(400)
        .json({
          success: false,

          error:
            "Unknown admin property action."
        });
    }

    /* =========================
       POST REQUESTS
       ========================= */

    if (
      req.method ===
      "POST"
    ) {
      const body =
        typeof req.body ===
        "string"
          ? JSON.parse(
              req.body
            )
          : req.body || {};

      const action =
        clean(
          body.action
        );

      const propertyId =
        clean(
          body.propertyId ||
          body.property_id
        );

      if (!propertyId) {
        return res
          .status(400)
          .json({
            success: false,

            error:
              "A property ID is required."
          });
      }

      /* Recalculate rating */

      if (
        action ===
        "recalculate"
      ) {
        const rating =
          await callCentralRecalculation(
            req,
            propertyId
          );

        return res
          .status(200)
          .json({
            success: true,
            ...rating
          });
      }

      /* Save audited adjustment */

      if (
        action ===
        "adjust"
      ) {
        const adjustment =
          await saveAdjustment(
            propertyId,
            body.adjustmentPoints,
            body.reason,
            adminContext
          );

        const rating =
          await callCentralRecalculation(
            req,
            propertyId
          );

        return res
          .status(200)
          .json({
            success: true,

            adjustment,

            rating:
              rating.rating,

            band:
              rating.band
          });
      }

      return res
        .status(400)
        .json({
          success: false,

          error:
            "Unknown admin property action."
        });
    }

    res.setHeader(
      "Allow",
      "GET, POST"
    );

    return res
      .status(405)
      .json({
        success: false,

        error:
          "Method not allowed."
      });
  } catch (error) {
    const message =
      error?.message ||
      "The admin property request failed.";

    const status =
      /authentication|session|authorized|admin account/i
        .test(message)
        ? 401
        : 500;

    return res
      .status(status)
      .json({
        success: false,
        error: message
      });
  }
}

const SUPABASE_URL = String(
  process.env.SUPABASE_URL || ""
).replace(/\/+$/, "");

const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  "";

const ANON_KEY =
  process.env.SUPABASE_ANON_KEY || "";

function clean(value) {
  return String(value ?? "").trim();
}

async function rest(path, options = {}) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      ...options,
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    }
  );

  const text = await response.text();

  let data = null;

  try {
    data = text
      ? JSON.parse(text)
      : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(
      data?.message ||
      data?.error ||
      text ||
      `Supabase request failed (${response.status}).`
    );
  }

  return data;
}

async function verifyAdmin(req) {
  const token = clean(
    req.headers.authorization
  ).replace(/^Bearer\s+/i, "");

  if (!token) {
    throw new Error(
      "Admin authentication token is missing."
    );
  }

  const response = await fetch(
    `${SUPABASE_URL}/auth/v1/user`,
    {
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${token}`
      }
    }
  );

  const user = await response
    .json()
    .catch(() => null);

  if (!response.ok || !user?.id) {
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

  const email = clean(
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
      clean(value).toLowerCase()
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

async function searchProperties(query) {
  const q = clean(query);

  if (!q) {
    return [];
  }

  const encoded = encodeURIComponent(
    `*${q}*`
  );

  const uuidLike =
    /^[0-9a-f-]{30,}$/i.test(q);

  let path;

  if (uuidLike) {
    path =
      `properties?or=(` +
      `id.eq.${encodeURIComponent(q)},` +
      `full_address.ilike.${encoded},` +
      `normalized_address.ilike.${encoded},` +
      `apn.ilike.${encoded}` +
      `)&select=*&limit=25`;
  } else {
    path =
      `properties?or=(` +
      `full_address.ilike.${encoded},` +
      `address.ilike.${encoded},` +
      `street.ilike.${encoded},` +
      `normalized_address.ilike.${encoded},` +
      `apn.ilike.${encoded}` +
      `)&select=*&limit=25`;
  }

  const rows = await rest(
    path,
    {
      method: "GET"
    }
  );

  return Array.isArray(rows)
    ? rows
    : [];
}

async function loadProperty(
  propertyId
) {
  const id = encodeURIComponent(
    clean(propertyId)
  );

  const [
    properties,
    entries,
    adjustments
  ] = await Promise.all([
    rest(
      `properties?id=eq.${id}&select=*&limit=1`,
      {
        method: "GET"
      }
    ),

    rest(
      `property_report_entries?property_id=eq.${id}&select=*&order=updated_at.desc`,
      {
        method: "GET"
      }
    ),

    rest(
      `property_rating_adjustments?property_id=eq.${id}&select=*&order=created_at.desc`,
      {
        method: "GET"
      }
    )
  ]);

  const property = Array.isArray(
    properties
  )
    ? properties[0]
    : null;

  if (!property) {
    throw new Error(
      "The central property record was not found."
    );
  }

  const adjustmentRows =
    Array.isArray(adjustments)
      ? adjustments
      : [];

  const adjustmentTotal =
    adjustmentRows.reduce(
      (sum, row) =>
        sum +
        Number(
          row.adjustment_points || 0
        ),
      0
    );

  return {
    property,

    entries:
      Array.isArray(entries)
        ? entries
        : [],

    adjustments:
      adjustmentRows,

    adjustmentTotal
  };
}

async function callCentralRecalculation(
  req,
  propertyId
) {
  const origin =
    new URL(
      req.url,
      `https://${req.headers.host}`
    ).origin;

  const response = await fetch(
    `${origin}/api/recalculate-property-rating`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        Authorization:
          req.headers.authorization
      },

      body: JSON.stringify({
        propertyId
      })
    }
  );

  const result = await response
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
      adminContext.user.email || null,

    created_at:
      new Date().toISOString()
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
    return res.status(500).json({
      success: false,

      error:
        "Supabase server environment variables are not configured."
    });
  }

  try {
    const adminContext =
      await verifyAdmin(req);

    if (
      req.method === "GET"
    ) {
      const action =
        clean(req.query.action);

      if (
        action === "search"
      ) {
        const properties =
          await searchProperties(
            req.query.q
          );

        return res.status(200).json({
          success: true,
          properties
        });
      }

      if (
        action === "load"
      ) {
        const result =
          await loadProperty(
            req.query.id
          );

        return res.status(200).json({
          success: true,
          ...result
        });
      }

      return res.status(400).json({
        success: false,

        error:
          "Unknown admin property action."
      });
    }

    if (
      req.method === "POST"
    ) {
      const body =
        typeof req.body === "string"
          ? JSON.parse(req.body)
          : req.body || {};

      const action =
        clean(body.action);

      const propertyId =
        clean(
          body.propertyId ||
          body.property_id
        );

      if (!propertyId) {
        return res.status(400).json({
          success: false,

          error:
            "A property ID is required."
        });
      }

      if (
        action === "recalculate"
      ) {
        const rating =
          await callCentralRecalculation(
            req,
            propertyId
          );

        return res.status(200).json({
          success: true,
          ...rating
        });
      }

      if (
        action === "adjust"
      ) {
        const adjustment =
          await saveAdjustment(
            propertyId,
            body.adjustmentPoints,
            body.reason,
            adminContext
          );

        return res.status(200).json({
          success: true,
          adjustment
        });
      }

      return res.status(400).json({
        success: false,

        error:
          "Unknown admin property action."
      });
    }

    return res.status(405).json({
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

    return res.status(status).json({
      success: false,
      error: message
    });
  }
}

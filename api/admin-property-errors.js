// api/admin-property-errors.js
// BlueVera Current Errors Admin API

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


/* =========================================================
   HELPERS
   ========================================================= */

function clean(value) {
  return String(value ?? "").trim();
}

function send(res, status, body) {
  return res
    .status(status)
    .json(body);
}


/* =========================================================
   SUPABASE REST REQUEST
   ========================================================= */

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


/* =========================================================
   VERIFY ADMIN
   Matches BlueVera's existing admin-property-rating API
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
   LIST ERROR REPORTS
   ========================================================= */

async function listErrors() {
  const rows = await rest(
    "property_error_reports" +
    "?select=*" +
    "&order=created_at.desc",
    {
      method: "GET"
    }
  );

  return Array.isArray(rows)
    ? rows
    : [];
}


/* =========================================================
   LOAD ONE ERROR
   ========================================================= */

async function loadError(
  errorId
) {
  const id =
    clean(errorId);

  if (!id) {
    throw new Error(
      "An error report ID is required."
    );
  }

  const rows = await rest(
    "property_error_reports" +
    `?id=eq.${encodeURIComponent(id)}` +
    "&select=*",
    {
      method: "GET"
    }
  );

  const report =
    Array.isArray(rows)
      ? rows[0]
      : null;

  if (!report) {
    throw new Error(
      "Property error report not found."
    );
  }

  return report;
}


/* =========================================================
   UPDATE ERROR
   ========================================================= */

async function updateError(
  errorId,
  nextStatus,
  adminNotes
) {
  const id =
    clean(errorId);

  if (!id) {
    throw new Error(
      "An error report ID is required."
    );
  }

  const status =
    clean(nextStatus)
      .toLowerCase();

  if (
    ![
      "open",
      "reviewing",
      "resolved"
    ].includes(status)
  ) {
    throw new Error(
      "Status must be open, reviewing, or resolved."
    );
  }

  const notes =
    clean(adminNotes);

  if (
    notes.length > 5000
  ) {
    throw new Error(
      "Admin notes must be 5,000 characters or fewer."
    );
  }

  const now =
    new Date()
      .toISOString();

  const payload = {
    status,
    admin_notes:
      notes || null,

    updated_at:
      now
  };

  if (
    status ===
    "reviewing"
  ) {
    payload.reviewed_at =
      now;

    payload.resolved_at =
      null;
  }

  if (
    status ===
    "resolved"
  ) {
    payload.reviewed_at =
      now;

    payload.resolved_at =
      now;
  }

  if (
    status ===
    "open"
  ) {
    payload.resolved_at =
      null;
  }

  const rows = await rest(
    "property_error_reports" +
    `?id=eq.${encodeURIComponent(id)}`,
    {
      method: "PATCH",

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

  const report =
    Array.isArray(rows)
      ? rows[0]
      : rows;

  if (!report) {
    throw new Error(
      "Property error report not found."
    );
  }

  return report;
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

  try {
    const adminContext =
      await verifyAdmin(req);


    /* =====================================================
       GET
       ===================================================== */

    if (
      req.method ===
      "GET"
    ) {
      const action =
        clean(
          req.query.action ||
          "list"
        ).toLowerCase();


      /* List errors */

      if (
        action ===
        "list"
      ) {
        const errors =
          await listErrors();

        return send(
          res,
          200,
          {
            success: true,
            errors
          }
        );
      }


      /* Load one error */

      if (
        action ===
        "load"
      ) {
        const errorReport =
          await loadError(
            req.query.id
          );

        return send(
          res,
          200,
          {
            success: true,

            error_report:
              errorReport
          }
        );
      }


      return send(
        res,
        400,
        {
          success: false,

          error:
            "Unknown property error action."
        }
      );
    }


    /* =====================================================
       POST
       ===================================================== */

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
        ).toLowerCase();


      /* Update error */

      if (
        action ===
        "update"
      ) {
        const errorReport =
          await updateError(
            body.errorId ||
            body.error_id,

            body.status,

            body.adminNotes ||
            body.admin_notes
          );

        console.log(
          "Property error updated",
          errorReport?.id,
          "by",
          adminContext.user.email ||
          adminContext.user.id,
          "to",
          errorReport?.status
        );

        return send(
          res,
          200,
          {
            success: true,

            error_report:
              errorReport
          }
        );
      }


      return send(
        res,
        400,
        {
          success: false,

          error:
            "Unknown property error action."
        }
      );
    }


    /* =====================================================
       UNSUPPORTED METHOD
       ===================================================== */

    res.setHeader(
      "Allow",
      "GET, POST"
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

  } catch (error) {
    console.error(
      "admin-property-errors API error:",
      error
    );

    const message =
      error?.message ||
      "The property error request failed.";

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

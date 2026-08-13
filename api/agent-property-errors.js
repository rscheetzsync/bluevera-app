// api/agent-property-errors.js
// BlueVera Agent Property Error Submission API

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
   CORS
   Allows bluevera.org to call bluevera.app API
   ========================================================= */

function setCors(req, res) {
  const origin = String(req.headers.origin || "");

  const allowedOrigins = [
    "https://bluevera.org",
    "https://www.bluevera.org",
    "https://bluevera.app",
    "https://www.bluevera.app"
  ];

  if (allowedOrigins.includes(origin)) {
    res.setHeader(
      "Access-Control-Allow-Origin",
      origin
    );
  }

  res.setHeader(
    "Vary",
    "Origin"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  res.setHeader(
    "Access-Control-Max-Age",
    "86400"
  );
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
   VERIFY AUTHENTICATED AGENT
   ========================================================= */

async function verifyAgent(req) {
  const token = clean(
    req.headers.authorization
  ).replace(
    /^Bearer\s+/i,
    ""
  );

  if (!token) {
    throw new Error(
      "Agent authentication token is missing."
    );
  }


  /* Verify Supabase session */

  const authResponse = await fetch(
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
    await authResponse
      .json()
      .catch(() => null);

  if (
    !authResponse.ok ||
    !user?.id
  ) {
    throw new Error(
      "The agent login session is invalid or expired."
    );
  }


  /* Load matching agent profile */

  const rows = await rest(
    "agents" +
    `?auth_user_id=eq.${encodeURIComponent(user.id)}` +
    "&select=*" +
    "&limit=1",
    {
      method: "GET"
    }
  );

  const agent =
    Array.isArray(rows)
      ? rows[0]
      : null;

  if (!agent) {
    throw new Error(
      "No BlueVera agent profile was found for this login."
    );
  }


  /* Check account status */

  const status = clean(
    agent.profile_status ||
    agent.account_status ||
    agent.status ||
    "approved"
  ).toLowerCase();

  if (
    [
      "pending",
      "disabled",
      "inactive",
      "suspended",
      "denied"
    ].includes(status)
  ) {
    throw new Error(
      "This BlueVera agent account is not approved for access."
    );
  }

  return {
    user,
    agent
  };
}


/* =========================================================
   CREATE ERROR REPORT
   ========================================================= */

async function createErrorReport(
  body,
  agentContext
) {
  const propertyId =
    clean(
      body.propertyId ||
      body.property_id
    );

  const propertyAddress =
    clean(
      body.propertyAddress ||
      body.property_address
    );

  const errorCategory =
    clean(
      body.errorCategory ||
      body.error_category
    );

  const errorDescription =
    clean(
      body.errorDescription ||
      body.error_description
    );


  if (!propertyAddress) {
    throw new Error(
      "A property address is required."
    );
  }

  if (!errorCategory) {
    throw new Error(
      "Select the item that appears incorrect."
    );
  }

  if (
    errorDescription.length < 10
  ) {
    throw new Error(
      "Describe the problem in at least 10 characters."
    );
  }

  if (
    errorDescription.length > 3000
  ) {
    throw new Error(
      "The error description must be 3,000 characters or fewer."
    );
  }


  const agent =
    agentContext.agent || {};

  const user =
    agentContext.user || {};


  /*
    Agent identity comes from authenticated Supabase account,
    not just from browser-provided text.
  */

  const reportedByName =
    clean(
      agent.agent_name ||
      agent.name ||
      agent.username ||
      body.reportedByName ||
      body.reported_by_name ||
      user.email ||
      "BlueVera Agent"
    );

  const reportedByEmail =
    clean(
      agent.email ||
      body.reportedByEmail ||
      body.reported_by_email ||
      user.email
    );


  const now =
    new Date()
      .toISOString();


  const payload = {
    property_id:
      propertyId || null,

    property_address:
      propertyAddress,

    reported_by_user_id:
      user.id,

    reported_by_name:
      reportedByName || null,

    reported_by_email:
      reportedByEmail || null,

    error_category:
      errorCategory,

    error_description:
      errorDescription,

    status:
      "open",

    admin_notes:
      null,

    created_at:
      now,

    updated_at:
      now
  };


  const rows = await rest(
    "property_error_reports",
    {
      method: "POST",

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
      "The property error report could not be saved."
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

  /* CORS MUST happen first */

  setCors(req, res);


  /* Browser preflight request */

  if (
    req.method ===
    "OPTIONS"
  ) {
    return res
      .status(204)
      .end();
  }


  res.setHeader(
    "Content-Type",
    "application/json"
  );

  res.setHeader(
    "Cache-Control",
    "no-store, max-age=0"
  );


  /* Environment check */

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


  /* Only POST after OPTIONS */

  if (
    req.method !==
    "POST"
  ) {
    res.setHeader(
      "Allow",
      "POST, OPTIONS"
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

    const agentContext =
      await verifyAgent(req);


    const body =
      typeof req.body ===
      "string"
        ? JSON.parse(
            req.body
          )
        : req.body || {};


    const action =
      clean(
        body.action ||
        "create"
      ).toLowerCase();


    if (
      action ===
      "create"
    ) {
      const errorReport =
        await createErrorReport(
          body,
          agentContext
        );

      return send(
        res,
        200,
        {
          success: true,

          message:
            "Property error submitted for BlueVera review.",

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
          "Unknown agent property error action."
      }
    );

  } catch (error) {

    console.error(
      "agent-property-errors API error:",
      error
    );

    const message =
      error?.message ||
      "The property error could not be submitted.";

    const status =
      /authentication|session|agent profile|approved|access/i
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

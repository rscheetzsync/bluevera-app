// api/agent-property-errors.js
// BlueVera Agent Property Error Submission API
//
// POST:
// {
//   action: "create",
//   propertyId,
//   propertyAddress,
//   errorCategory,
//   errorDescription,
//   reportedByName,
//   reportedByEmail
// }

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


  /* Verify the Supabase session */

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


  /* Load the agent profile tied to this auth user */

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


  /* Verify agent account status */

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


  /* Required fields */

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


  /*
    Use the authenticated agent profile as the authoritative
    source for the agent identity.

    We do not trust the name/email sent by the browser when a
    verified value exists in Supabase.
  */

  const agent =
    agentContext.agent || {};

  const user =
    agentContext.user || {};

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


  /*
    The property_error_reports table currently allows
    property_id to be nullable from the application side.

    If BlueVera has a central property UUID, save it.
    Otherwise the address still allows the admin to identify
    and review the reported property.
  */

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
      new Date()
        .toISOString(),

    updated_at:
      new Date()
        .toISOString()
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
  res.setHeader(
    "Content-Type",
    "application/json"
  );

  res.setHeader(
    "Cache-Control",
    "no-store, max-age=0"
  );


  /* Verify environment */

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


  /* Only POST is required */

  if (
    req.method !==
    "POST"
  ) {
    res.setHeader(
      "Allow",
      "POST"
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

    /* Verify the logged-in agent */

    const agentContext =
      await verifyAgent(req);


    /* Read body */

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


    /* Create property error */

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

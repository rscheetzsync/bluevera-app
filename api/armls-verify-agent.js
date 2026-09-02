const SPARK_BASE = "https://replication.sparkapi.com/v1";

const SPARK_TOKEN =
  process.env.SPARK_ACCESS_TOKEN || "";

const SUPABASE_URL =
  process.env.SUPABASE_URL || "";

const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "";


/* ---------------------------------------------------------
   Helpers
--------------------------------------------------------- */

function clean(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}


function escapeSparkString(value) {
  return clean(value).replace(/'/g, "''");
}


function isMasked(value) {
  const text = clean(value);

  if (!text) {
    return false;
  }

  return /^\*+$/.test(text);
}


/* ---------------------------------------------------------
   Supabase REST helper
--------------------------------------------------------- */

async function supabaseRequest(
  path,
  options = {}
) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      ...options,

      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,

        Authorization:
          `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,

        "Content-Type":
          "application/json",

        Prefer:
          options.prefer ||
          "return=representation",

        ...(options.headers || {})
      }
    }
  );

  const text = await response.text();

  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const error = new Error(
      data?.message ||
      data?.error ||
      `Supabase request failed with ${response.status}`
    );

    error.status = response.status;
    error.details = data;

    throw error;
  }

  return data;
}


/* ---------------------------------------------------------
   Read BlueVera agent
--------------------------------------------------------- */

async function getAgent(agentId) {
  const encodedId =
    encodeURIComponent(agentId);

  const path =
    `agents` +
    `?id=eq.${encodedId}` +
    `&select=` +
    [
      "id",
      "agent_name",
      "email",
      "auth_user_id",
      "account_type",
      "armls_agent_short_id",
      "armls_office_short_id",
      "armls_active",
      "armls_access_enabled",
      "armls_access_status",
      "armls_verified_at",
      "armls_last_checked_at",
      "armls_login_name"
    ].join(",");

  const rows =
    await supabaseRequest(
      path,
      {
        method: "GET",
        prefer: "return=representation"
      }
    );

  if (!Array.isArray(rows)) {
    return null;
  }

  return rows[0] || null;
}


/* ---------------------------------------------------------
   Update BlueVera agent
--------------------------------------------------------- */

async function updateAgent(
  agentId,
  updates
) {
  const encodedId =
    encodeURIComponent(agentId);

  return await supabaseRequest(
    `agents?id=eq.${encodedId}`,
    {
      method: "PATCH",

      prefer:
        "return=representation",

      body:
        JSON.stringify(updates)
    }
  );
}


/* ---------------------------------------------------------
   Spark ARMLS Active Subscriber check
--------------------------------------------------------- */

async function checkArmlsSubscriber(
  shortId
) {
  const safeShortId =
    escapeSparkString(shortId);

  /*
    ARMLS ActiveAgent requirement:

    UserType must be included in the
    Accounts API filter.

    ShortId is used to find the member.

    Access is allowed ONLY when:
    Active === true
  */

  const filter =
    `UserType Eq 'Member' And ShortId Eq '${safeShortId}'`;

  const sparkUrl =
    `${SPARK_BASE}/accounts` +
    `?_filter=${encodeURIComponent(filter)}` +
    `&_limit=5`;

  const response =
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

  const text =
    await response.text();

  let data;

  try {
    data =
      JSON.parse(text);
  } catch {
    throw new Error(
      "Spark returned invalid JSON."
    );
  }

  if (!response.ok) {
    const message =
      data?.D?.Message ||
      data?.message ||
      "Spark account request failed.";

    const error =
      new Error(message);

    error.status =
      response.status;

    error.sparkResponse =
      data;

    throw error;
  }

  const results =
    Array.isArray(
      data?.D?.Results
    )
      ? data.D.Results
      : [];

  const exactMatch =
    results.find(
      (account) =>
        clean(
          account?.ShortId
        ).toLowerCase() ===
        clean(
          shortId
        ).toLowerCase()
    ) ||
    (
      results.length === 1
        ? results[0]
        : null
    );

  if (!exactMatch) {
    return {
      found: false,
      active: false,
      allowed: false,
      account: null
    };
  }

  const active =
    exactMatch.Active === true;

  return {
    found: true,

    active,

    allowed:
      active === true,

    account:
      exactMatch
  };
}


/* ---------------------------------------------------------
   Main API handler
--------------------------------------------------------- */

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


  /* -------------------------------------------------------
     POST ONLY
  ------------------------------------------------------- */

  if (req.method !== "POST") {
    res.setHeader(
      "Allow",
      "POST"
    );

    return res.status(405).json({
      success: false,
      error:
        "Method not allowed. Use POST."
    });
  }


  try {

    /* -----------------------------------------------------
       Environment checks
    ----------------------------------------------------- */

    if (!SPARK_TOKEN) {
      return res.status(500).json({
        success: false,
        error:
          "SPARK_ACCESS_TOKEN is missing."
      });
    }


    if (
      !SUPABASE_URL ||
      !SUPABASE_SERVICE_ROLE_KEY
    ) {
      return res.status(500).json({
        success: false,
        error:
          "Supabase server credentials are missing."
      });
    }


    /* -----------------------------------------------------
       Request body
    ----------------------------------------------------- */

    const agentId =
      clean(
        req.body?.agentId ||
        req.body?.agent_id ||
        ""
      );


    const suppliedShortId =
      clean(
        req.body?.armlsShortId ||
        req.body?.shortId ||
        req.body?.armls_agent_short_id ||
        ""
      );


    if (!agentId) {
      return res.status(400).json({
        success: false,
        error:
          "agentId is required."
      });
    }


    /* -----------------------------------------------------
       Load BlueVera agent
    ----------------------------------------------------- */

    const agent =
      await getAgent(agentId);


    if (!agent) {
      return res.status(404).json({
        success: false,
        error:
          "BlueVera agent was not found."
      });
    }


    /* -----------------------------------------------------
       Determine ARMLS ShortID

       Admin can supply it during initial verification.

       After that we can reuse what is stored
       on the agents table.
    ----------------------------------------------------- */

    const shortId =
      clean(
        suppliedShortId ||
        agent.armls_agent_short_id
      );


    if (!shortId) {
      return res.status(400).json({
        success: false,

        agentId:
          agent.id,

        agentName:
          agent.agent_name,

        error:
          "This agent does not have an ARMLS ShortID."
      });
    }


    if (
      !/^[A-Za-z0-9._@-]{2,80}$/.test(
        shortId
      )
    ) {
      return res.status(400).json({
        success: false,
        error:
          "The ARMLS ShortID format is invalid."
      });
    }


    /* -----------------------------------------------------
       Check Spark
    ----------------------------------------------------- */

    const verification =
      await checkArmlsSubscriber(
        shortId
      );


    const now =
      new Date().toISOString();


    /* -----------------------------------------------------
       No ARMLS account found
    ----------------------------------------------------- */

    if (!verification.found) {

      const updates = {
        armls_agent_short_id:
          shortId,

        armls_active:
          false,

        armls_access_enabled:
          false,

        armls_access_status:
          "not_found",

        armls_last_checked_at:
          now
      };


      const updatedRows =
        await updateAgent(
          agent.id,
          updates
        );


      return res.status(200).json({
        success: true,

        verified: true,

        agentId:
          agent.id,

        agentName:
          agent.agent_name,

        shortId,

        found: false,

        active: false,

        allowed: false,

        accessStatus:
          "not_found",

        reason:
          "No matching ARMLS member account was found.",

        updatedAgent:
          Array.isArray(updatedRows)
            ? updatedRows[0] || null
            : null
      });
    }


    /* -----------------------------------------------------
       ARMLS account found
    ----------------------------------------------------- */

    const account =
      verification.account;


    const officeShortId =
      clean(
        account?.Office?.ShortId ||
        account?.OfficeShortId ||
        ""
      );


    const sparkLoginName =
      clean(
        account?.LoginName ||
        ""
      );


    /*
      Spark may mask LoginName.

      Never save ******** into Supabase.
    */

    const usableLoginName =
      sparkLoginName &&
      !isMasked(sparkLoginName)
        ? sparkLoginName
        : null;


    /* -----------------------------------------------------
       ACTIVE
    ----------------------------------------------------- */

    if (verification.active) {

      const updates = {
        armls_agent_short_id:
          clean(
            account?.ShortId ||
            shortId
          ),

        armls_office_short_id:
          officeShortId || null,

        armls_active:
          true,

        armls_access_enabled:
          true,

        armls_access_status:
          "active",

        armls_verified_at:
          now,

        armls_last_checked_at:
          now
      };


      if (usableLoginName) {
        updates.armls_login_name =
          usableLoginName;
      }


      const updatedRows =
        await updateAgent(
          agent.id,
          updates
        );


      return res.status(200).json({
        success: true,

        verified: true,

        agentId:
          agent.id,

        agentName:
          agent.agent_name,

        email:
          agent.email || null,

        shortId:
          account?.ShortId ||
          shortId,

        officeShortId:
          officeShortId || null,

        found: true,

        active: true,

        allowed: true,

        accessStatus:
          "active",

        reason:
          "ARMLS subscriber is active and eligible for ARMLS access.",

        checkedAt:
          now,

        updatedAgent:
          Array.isArray(updatedRows)
            ? updatedRows[0] || null
            : null
      });
    }


    /* -----------------------------------------------------
       FOUND BUT INACTIVE
    ----------------------------------------------------- */

    const updates = {
      armls_agent_short_id:
        clean(
          account?.ShortId ||
          shortId
        ),

      armls_office_short_id:
        officeShortId || null,

      armls_active:
        false,

      armls_access_enabled:
        false,

      armls_access_status:
        "inactive",

      armls_last_checked_at:
        now
    };


    if (usableLoginName) {
      updates.armls_login_name =
        usableLoginName;
    }


    const updatedRows =
      await updateAgent(
        agent.id,
        updates
      );


    return res.status(200).json({
      success: true,

      verified: true,

      agentId:
        agent.id,

      agentName:
        agent.agent_name,

      email:
        agent.email || null,

      shortId:
        account?.ShortId ||
        shortId,

      officeShortId:
        officeShortId || null,

      found: true,

      active: false,

      allowed: false,

      accessStatus:
        "inactive",

      reason:
        "ARMLS account was found, but Active is not true. ARMLS access has been disabled.",

      checkedAt:
        now,

      updatedAgent:
        Array.isArray(updatedRows)
          ? updatedRows[0] || null
          : null
    });


  } catch (error) {

    console.error(
      "ARMLS agent verification failed:",
      error
    );


    return res.status(
      error?.status &&
      Number.isInteger(
        error.status
      )
        ? error.status
        : 500
    ).json({
      success: false,

      error:
        error?.message ||
        "ARMLS agent verification failed.",

      details:
        error?.details ||
        error?.sparkResponse ||
        null
    });
  }
}

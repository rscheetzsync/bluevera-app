const SPARK_BASE =
  "https://replication.sparkapi.com/v1";

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


function normalize(value) {
  return clean(value)
    .toLowerCase();
}


function escapeSparkString(value) {
  return clean(value)
    .replace(/'/g, "''");
}


function splitAgentName(name) {
  const parts =
    clean(name)
      .split(" ")
      .filter(Boolean);

  if (parts.length < 2) {
    return {
      firstName:
        parts[0] || "",
      lastName:
        ""
    };
  }

  return {
    firstName:
      parts[0],

    lastName:
      parts[
        parts.length - 1
      ]
  };
}


function isMasked(value) {
  const text =
    clean(value);

  return (
    text &&
    /^\*+$/.test(text)
  );
}


function needsCheck(agent) {
  if (
    !agent.armls_last_checked_at
  ) {
    return true;
  }

  const checked =
    new Date(
      agent.armls_last_checked_at
    );

  if (
    Number.isNaN(
      checked.getTime()
    )
  ) {
    return true;
  }

  const twentyFourHours =
    24 * 60 * 60 * 1000;

  return (
    Date.now() -
      checked.getTime()
      >= twentyFourHours
  );
}


/* ---------------------------------------------------------
   Supabase
--------------------------------------------------------- */

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
            SUPABASE_SERVICE_ROLE_KEY,

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

  const text =
    await response.text();

  let data = null;

  if (text) {
    try {
      data =
        JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const error =
      new Error(
        data?.message ||
        data?.error ||
        `Supabase request failed with ${response.status}`
      );

    error.status =
      response.status;

    error.details =
      data;

    throw error;
  }

  return data;
}


async function getBlueVeraAgents() {
  const select = [
    "id",
    "agent_name",
    "email",
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

  const path =
    `agents` +
    `?select=${encodeURIComponent(select)}` +
    `&account_type=eq.agent` +
    `&order=created_at.asc`;

  const rows =
    await supabaseRequest(
      path,
      {
        method:
          "GET"
      }
    );

  return Array.isArray(rows)
    ? rows
    : [];
}


async function updateAgent(
  agentId,
  updates
) {
  return await supabaseRequest(
    `agents?id=eq.${encodeURIComponent(agentId)}`,
    {
      method:
        "PATCH",

      prefer:
        "return=representation",

      body:
        JSON.stringify(updates)
    }
  );
}


/* ---------------------------------------------------------
   Spark request
--------------------------------------------------------- */

async function sparkAccountsQuery(
  filter,
  limit = 10
) {
  const sparkUrl =
    `${SPARK_BASE}/accounts` +
    `?_filter=${encodeURIComponent(filter)}` +
    `&_limit=${limit}`;

  const response =
    await fetch(
      sparkUrl,
      {
        method:
          "GET",

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
    const error =
      new Error(
        data?.D?.Message ||
        data?.message ||
        "Spark account request failed."
      );

    error.status =
      response.status;

    error.sparkResponse =
      data;

    throw error;
  }

  return Array.isArray(
    data?.D?.Results
  )
    ? data.D.Results
    : [];
}


/* ---------------------------------------------------------
   Find ARMLS account
--------------------------------------------------------- */

async function findByShortId(
  shortId
) {
  const safe =
    escapeSparkString(
      shortId
    );

  const filter =
    `UserType Eq 'Member' And ShortId Eq '${safe}'`;

  const results =
    await sparkAccountsQuery(
      filter,
      5
    );

  const exact =
    results.find(
      (account) =>
        normalize(
          account?.ShortId
        ) ===
        normalize(
          shortId
        )
    );

  return exact || null;
}


async function findByEmail(
  email
) {
  if (!email) {
    return {
      match: null,
      ambiguous: false
    };
  }

  const safe =
    escapeSparkString(
      email
    );

  const filter =
    `UserType Eq 'Member' And Email Eq '${safe}'`;

  const results =
    await sparkAccountsQuery(
      filter,
      10
    );

  if (results.length === 1) {
    return {
      match:
        results[0],

      ambiguous:
        false
    };
  }

  return {
    match:
      null,

    ambiguous:
      results.length > 1
  };
}


async function findByName(
  agentName
) {
  const {
    firstName,
    lastName
  } =
    splitAgentName(
      agentName
    );

  if (
    !firstName ||
    !lastName
  ) {
    return {
      match: null,
      ambiguous: false
    };
  }

  const safeFirst =
    escapeSparkString(
      firstName
    );

  const safeLast =
    escapeSparkString(
      lastName
    );

  const filter =
    `UserType Eq 'Member'` +
    ` And FirstName Eq '${safeFirst}'` +
    ` And LastName Eq '${safeLast}'`;

  const results =
    await sparkAccountsQuery(
      filter,
      25
    );

  const exact =
    results.filter(
      (account) =>
        normalize(
          account?.FirstName
        ) ===
          normalize(
            firstName
          ) &&
        normalize(
          account?.LastName
        ) ===
          normalize(
            lastName
          )
    );

  if (exact.length === 1) {
    return {
      match:
        exact[0],

      ambiguous:
        false
    };
  }

  return {
    match:
      null,

    ambiguous:
      exact.length > 1
  };
}


/* ---------------------------------------------------------
   Locate ARMLS account for one BlueVera agent
--------------------------------------------------------- */

async function locateArmlsAccount(
  agent
) {
  /*
    1. Existing ShortID is strongest.
  */

  const existingShortId =
    clean(
      agent.armls_agent_short_id
    );

  if (existingShortId) {
    const account =
      await findByShortId(
        existingShortId
      );

    return {
      account,

      source:
        "stored_short_id",

      ambiguous:
        false
    };
  }


  /*
    2. Email.
  */

  const emailResult =
    await findByEmail(
      clean(
        agent.email
      )
    );

  if (
    emailResult.match ||
    emailResult.ambiguous
  ) {
    return {
      account:
        emailResult.match,

      source:
        "email",

      ambiguous:
        emailResult.ambiguous
    };
  }


  /*
    3. Exact first + last name.

    Only one exact result is accepted.
    Multiple matching ARMLS members are
    deliberately NOT auto-linked.
  */

  const nameResult =
    await findByName(
      agent.agent_name
    );

  return {
    account:
      nameResult.match,

    source:
      "exact_name",

    ambiguous:
      nameResult.ambiguous
  };
}


/* ---------------------------------------------------------
   Verify one agent
--------------------------------------------------------- */

async function verifyAgent(
  agent
) {
  const now =
    new Date()
      .toISOString();

  const located =
    await locateArmlsAccount(
      agent
    );


  /* -------------------------------------------------------
     Ambiguous result
  ------------------------------------------------------- */

  if (located.ambiguous) {
    await updateAgent(
      agent.id,
      {
        armls_active:
          false,

        armls_access_enabled:
          false,

        armls_access_status:
          "needs_review",

        armls_last_checked_at:
          now
      }
    );

    return {
      agentId:
        agent.id,

      agentName:
        agent.agent_name,

      success:
        false,

      status:
        "needs_review",

      reason:
        "Multiple ARMLS member matches were found. No ARMLS account was automatically linked."
    };
  }


  /* -------------------------------------------------------
     Nothing found
  ------------------------------------------------------- */

  if (!located.account) {
    await updateAgent(
      agent.id,
      {
        armls_active:
          false,

        armls_access_enabled:
          false,

        armls_access_status:
          "not_found",

        armls_last_checked_at:
          now
      }
    );

    return {
      agentId:
        agent.id,

      agentName:
        agent.agent_name,

      success:
        false,

      status:
        "not_found",

      reason:
        "No matching ARMLS member account was found."
    };
  }


  const account =
    located.account;

  const shortId =
    clean(
      account?.ShortId
    );

  const officeShortId =
    clean(
      account?.OfficeShortId ||
      account?.Office?.ShortId
    );

  const sparkLoginName =
    clean(
      account?.LoginName
    );

  const active =
    account?.Active === true;


  const updates = {
    armls_agent_short_id:
      shortId || null,

    armls_office_short_id:
      officeShortId || null,

    armls_active:
      active,

    armls_access_enabled:
      active,

    armls_access_status:
      active
        ? "active"
        : "inactive",

    armls_last_checked_at:
      now
  };


  /*
    verified_at means we successfully
    verified eligibility.

    It is populated for ACTIVE agents.
  */

  if (active) {
    updates.armls_verified_at =
      now;
  }


  /*
    Do not store Spark's masked
    ******** LoginName.
  */

  if (
    sparkLoginName &&
    !isMasked(
      sparkLoginName
    )
  ) {
    updates.armls_login_name =
      sparkLoginName;
  }


  await updateAgent(
    agent.id,
    updates
  );


  return {
    agentId:
      agent.id,

    agentName:
      agent.agent_name,

    success:
      true,

    shortId:
      shortId || null,

    officeShortId:
      officeShortId || null,

    active,

    allowed:
      active,

    status:
      active
        ? "active"
        : "inactive",

    matchSource:
      located.source
  };
}


/* ---------------------------------------------------------
   API Handler
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


  if (req.method !== "POST") {
    res.setHeader(
      "Allow",
      "POST"
    );

    return res.status(405).json({
      success:
        false,

      error:
        "Method not allowed. Use POST."
    });
  }


  try {

    if (!SPARK_TOKEN) {
      return res.status(500).json({
        success:
          false,

        error:
          "SPARK_ACCESS_TOKEN is missing."
      });
    }


    if (
      !SUPABASE_URL ||
      !SUPABASE_SERVICE_ROLE_KEY
    ) {
      return res.status(500).json({
        success:
          false,

        error:
          "Supabase server credentials are missing."
      });
    }


    const mode =
      clean(
        req.body?.mode ||
        "changed"
      ).toLowerCase();


    /*
      For now we are ONLY enabling the
      New / Changed workflow.

      Full Standing Check remains disabled
      until this workflow is fully proven.
    */

    if (mode !== "changed") {
      return res.status(400).json({
        success:
          false,

        error:
          "Full standing verification is not enabled yet."
      });
    }


    const allAgents =
      await getBlueVeraAgents();


    const candidates =
      allAgents.filter(
        needsCheck
      );


    /*
      Safety limit for one Vercel request.
    */

    const MAX_PER_RUN = 25;


    const batch =
      candidates.slice(
        0,
        MAX_PER_RUN
      );


    const results = [];


    /*
      Sequential verification is intentional.
      It avoids sending a large burst of
      requests to Spark.
    */

    for (const agent of batch) {
      try {
        const result =
          await verifyAgent(
            agent
          );

        results.push(
          result
        );

      } catch (error) {
        console.error(
          `ARMLS verification failed for ${agent.agent_name}:`,
          error
        );

        results.push({
          agentId:
            agent.id,

          agentName:
            agent.agent_name,

          success:
            false,

          status:
            "error",

          reason:
            error?.message ||
            "Verification failed."
        });
      }
    }


    const activeCount =
      results.filter(
        (item) =>
          item.active === true
      ).length;


    const inactiveCount =
      results.filter(
        (item) =>
          item.status ===
          "inactive"
      ).length;


    const notFoundCount =
      results.filter(
        (item) =>
          item.status ===
          "not_found"
      ).length;


    const reviewCount =
      results.filter(
        (item) =>
          item.status ===
          "needs_review"
      ).length;


    const errorCount =
      results.filter(
        (item) =>
          item.status ===
          "error"
      ).length;


    const candidateCount =
      candidates.length;


    const attemptedCount =
      batch.length;


    const processedCount =
      results.length;


    const successfulCount =
      results.filter(
        (item) =>
          item.status !==
          "error"
      ).length;


    const remainingCount =
      Math.max(
        0,
        candidateCount -
        attemptedCount
      );


    return res.status(200).json({
      success:
        true,

      message:
        `ARMLS check complete — ${processedCount} of ${candidateCount} agent(s) processed. ${activeCount} active, ${inactiveCount} inactive, ${notFoundCount} not found, ${reviewCount} need review, ${errorCount} error(s).`,

      mode:
        "changed",

      candidates:
        candidateCount,

      attempted:
        attemptedCount,

      processed:
        processedCount,

      successful:
        successfulCount,

      remaining:
        remainingCount,

      active:
        activeCount,

      inactive:
        inactiveCount,

      notFound:
        notFoundCount,

      needsReview:
        reviewCount,

      errors:
        errorCount,

      results
    });


  } catch (error) {

    console.error(
      "ARMLS changed-agent verification failed:",
      error
    );


    return res.status(500).json({
      success:
        false,

      error:
        error?.message ||
        "ARMLS changed-agent verification failed."
    });
  }
}

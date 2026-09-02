const SUPABASE_URL =
  process.env.SUPABASE_URL || "";

const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "";

function clean(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function classifyAgent(agent) {
  const lastChecked = agent?.armls_last_checked_at
    ? new Date(agent.armls_last_checked_at)
    : null;

  const checkedValid =
    lastChecked &&
    !Number.isNaN(lastChecked.getTime());

  if (!checkedValid) {
    return "never_checked";
  }

  const status = clean(
    agent?.armls_access_status
  ).toLowerCase();

  const active =
    agent?.armls_active === true;

  const accessEnabled =
    agent?.armls_access_enabled === true;

  if (
    status === "inactive" ||
    status === "not_found" ||
    status === "failed" ||
    active !== true ||
    accessEnabled !== true
  ) {
    return "failed";
  }

  const ageMs =
    Date.now() - lastChecked.getTime();

  const twentyFourHours =
    24 * 60 * 60 * 1000;

  if (ageMs > twentyFourHours) {
    return "needs_recheck";
  }

  return "good_standing";
}

function isSameUtcDay(
  value,
  now
) {
  if (!value) {
    return false;
  }

  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return false;
  }

  return (
    date.getUTCFullYear() ===
      now.getUTCFullYear() &&
    date.getUTCMonth() ===
      now.getUTCMonth() &&
    date.getUTCDate() ===
      now.getUTCDate()
  );
}

async function readAgents() {
  const select = [
    "id",
    "account_type",
    "armls_active",
    "armls_access_enabled",
    "armls_access_status",
    "armls_verified_at",
    "armls_last_checked_at"
  ].join(",");

  const url =
    `${SUPABASE_URL}/rest/v1/agents` +
    `?select=${encodeURIComponent(select)}` +
    `&account_type=eq.agent`;

  const response =
    await fetch(
      url,
      {
        method: "GET",

        headers: {
          apikey:
            SUPABASE_SERVICE_ROLE_KEY,

          Authorization:
            `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,

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
      text
        ? JSON.parse(text)
        : [];
  } catch {
    throw new Error(
      "Supabase returned invalid JSON."
    );
  }

  if (!response.ok) {
    const error =
      new Error(
        data?.message ||
        data?.error ||
        "Unable to load ARMLS summary."
      );

    error.status =
      response.status;

    throw error;
  }

  return Array.isArray(data)
    ? data
    : [];
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

  if (req.method !== "GET") {
    res.setHeader(
      "Allow",
      "GET"
    );

    return res.status(405).json({
      success: false,
      error:
        "Method not allowed."
    });
  }

  try {
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

    const agents =
      await readAgents();

    let goodStanding = 0;
    let needsRecheck = 0;
    let failed = 0;
    let neverChecked = 0;

    let lastSuccessfulRun =
      null;

    const now =
      new Date();

    let checkedToday = 0;

    for (const agent of agents) {
      const status =
        classifyAgent(agent);

      if (
        status ===
        "good_standing"
      ) {
        goodStanding++;

      } else if (
        status ===
        "needs_recheck"
      ) {
        needsRecheck++;

      } else if (
        status ===
        "failed"
      ) {
        failed++;

      } else {
        neverChecked++;
      }

      if (
        isSameUtcDay(
          agent.armls_last_checked_at,
          now
        )
      ) {
        checkedToday++;
      }

      if (
        agent.armls_verified_at &&
        agent.armls_active === true &&
        agent.armls_access_enabled === true
      ) {
        const verified =
          new Date(
            agent.armls_verified_at
          );

        if (
          !Number.isNaN(
            verified.getTime()
          ) &&
          (
            !lastSuccessfulRun ||
            verified >
              new Date(
                lastSuccessfulRun
              )
          )
        ) {
          lastSuccessfulRun =
            verified.toISOString();
        }
      }
    }

    /*
      Until the bulk verification job is connected:

      queueCount =
      agents that currently need verification
      or re-verification.

      errorCount =
      agents currently failed / inactive.
    */

    const queueCount =
      needsRecheck +
      neverChecked;

    const errorCount =
      failed;

    return res.status(200).json({
      success: true,

      total:
        agents.length,

      goodStanding,

      needsRecheck,

      failed,

      neverChecked,

      lastSuccessfulRun,

      queueCount,

      checkedToday,

      errorCount
    });

  } catch (error) {
    console.error(
      "ARMLS standing summary failed:",
      error
    );

    return res.status(
      Number.isInteger(
        error?.status
      )
        ? error.status
        : 500
    ).json({
      success: false,

      error:
        error?.message ||
        "Unable to load ARMLS standing summary."
    });
  }
}

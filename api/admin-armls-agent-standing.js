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

function accessLabel(agent) {
  return agent?.armls_access_enabled === true
    ? "active"
    : "restricted";
}

function matchesSearch(agent, q) {
  if (!q) return true;

  const haystack = [
    agent?.name,
    agent?.email,
    agent?.brokerage,
    agent?.armlsShortId,
    agent?.officeShortId
  ]
    .map(clean)
    .join(" ")
    .toLowerCase();

  return haystack.includes(
    q.toLowerCase()
  );
}

async function readAgents() {
  const select = [
    "id",
    "agent_name",
    "email",
    "brokerage_name",
    "account_type",
    "armls_agent_short_id",
    "armls_office_short_id",
    "armls_active",
    "armls_access_enabled",
    "armls_access_status",
    "armls_verified_at",
    "armls_last_checked_at"
  ].join(",");

  const url =
    `${SUPABASE_URL}/rest/v1/agents` +
    `?select=${encodeURIComponent(select)}` +
    `&account_type=eq.agent` +
    `&order=agent_name.asc`;

  const response = await fetch(
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
        "Unable to load BlueVera agents."
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

    const page =
      Math.max(
        1,
        Number(
          req.query?.page
        ) || 1
      );

    const limit =
      Math.min(
        100,
        Math.max(
          1,
          Number(
            req.query?.limit
          ) || 50
        )
      );

    const q =
      clean(
        req.query?.q ||
        ""
      );

    const requestedStatus =
      clean(
        req.query?.status ||
        ""
      ).toLowerCase();

    const allAgents =
      await readAgents();

    const normalized =
      allAgents.map(
        (agent) => ({
          id:
            agent.id,

          name:
            agent.agent_name ||
            null,

          email:
            agent.email ||
            null,

          brokerage:
            agent.brokerage_name ||
            null,

          armlsShortId:
            agent.armls_agent_short_id ||
            null,

          officeShortId:
            agent.armls_office_short_id ||
            null,

          armlsStatus:
            classifyAgent(agent),

          lastChecked:
            agent.armls_last_checked_at ||
            null,

          verifiedAt:
            agent.armls_verified_at ||
            null,

          access:
            accessLabel(agent)
        })
      );

    const filtered =
      normalized.filter(
        (agent) => {
          if (
            !matchesSearch(
              agent,
              q
            )
          ) {
            return false;
          }

          if (
            requestedStatus &&
            agent.armlsStatus !==
              requestedStatus
          ) {
            return false;
          }

          return true;
        }
      );

    const total =
      filtered.length;

    const start =
      (page - 1) * limit;

    const agents =
      filtered.slice(
        start,
        start + limit
      );

    return res.status(200).json({
      success: true,

      page,

      limit,

      total,

      agents
    });

  } catch (error) {
    console.error(
      "ARMLS agent standing directory failed:",
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
        "Unable to load ARMLS agent standing."
    });
  }
}

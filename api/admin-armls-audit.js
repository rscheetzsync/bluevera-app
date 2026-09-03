const SUPABASE_URL =
  process.env.SUPABASE_URL || "";

const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "";

function clean(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitName(fullName) {
  const parts =
    clean(fullName)
      .split(/\s+/)
      .filter(Boolean);

  if (!parts.length) {
    return {
      firstName: "",
      lastName: ""
    };
  }

  if (parts.length === 1) {
    return {
      firstName: parts[0],
      lastName: ""
    };
  }

  return {
    firstName: parts[0],

    lastName:
      parts
        .slice(1)
        .join(" ")
  };
}

function validMonth(value) {
  return /^\d{4}-\d{2}$/.test(
    clean(value)
  );
}

function periodLabel(month) {
  const [year, monthNumber] =
    month
      .split("-")
      .map(Number);

  const date =
    new Date(
      Date.UTC(
        year,
        monthNumber - 1,
        1
      )
    );

  return date.toLocaleDateString(
    "en-US",
    {
      month: "long",
      year: "numeric",
      timeZone: "UTC"
    }
  );
}

async function getAgents() {
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
    "armls_last_checked_at"
  ].join(",");

  const url =
    `${SUPABASE_URL}/rest/v1/agents` +
    `?select=${encodeURIComponent(select)}` +
    `&account_type=eq.agent` +
    `&order=agent_name.asc`;

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
        "Unable to load ARMLS audit records."
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

    const now =
      new Date();

    const defaultMonth =
      `${now.getUTCFullYear()}-${String(
        now.getUTCMonth() + 1
      ).padStart(2, "0")}`;

    const month =
      validMonth(
        req.query?.month
      )
        ? clean(
            req.query.month
          )
        : defaultMonth;

    const rows =
      await getAgents();

    const agents =
      rows.map(
        (agent) => {
          const name =
            splitName(
              agent.agent_name
            );

          const active =
            agent.armls_active === true;

          const access =
            agent.armls_access_enabled === true
              ? "active"
              : "restricted";

          const agentShortId =
            clean(
              agent.armls_agent_short_id
            );

          const officeShortId =
            clean(
              agent.armls_office_short_id
            );

          const email =
            clean(
              agent.email
            );

          const missingRequired =
            !name.firstName ||
            !name.lastName ||
            !email ||
            !agentShortId ||
            !officeShortId;

          return {
            id:
              agent.id,

            firstName:
              name.firstName,

            lastName:
              name.lastName,

            email,

            agentShortId,

            officeShortId,

            active,

            access,

            accessStatus:
              clean(
                agent.armls_access_status
              ) || null,

            verifiedAt:
              agent.armls_verified_at || null,

            lastChecked:
              agent.armls_last_checked_at || null,

            missingRequired
          };
        }
      );

    const active =
      agents.filter(
        (agent) =>
          agent.active === true &&
          agent.access === "active"
      ).length;

    const restricted =
      agents.length -
      active;

    const missingRequired =
      agents.filter(
        (agent) =>
          agent.missingRequired
      ).length;

    return res.status(200).json({
      success: true,

      month,

      periodLabel:
        periodLabel(month),

      total:
        agents.length,

      active,

      restricted,

      missingRequired,

      exportCount:
        agents.filter(
          (agent) =>
            agent.active === true &&
            agent.access === "active" &&
            !agent.missingRequired
        ).length,

      /*
        This endpoint currently builds
        the monthly report from BlueVera's
        current verified agent records.

        Historical month-by-month snapshots
        can be added next using
        armls_subscriber_audit.
      */

      source:
        "agents_current_verified_state",

      agents
    });

  } catch (error) {
    console.error(
      "ARMLS monthly audit failed:",
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
        "Unable to load ARMLS monthly audit."
    });
  }
}

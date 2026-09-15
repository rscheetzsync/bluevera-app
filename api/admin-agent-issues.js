// api/admin-agent-issues.js
// BlueVera admin API for agent-reported issues.
//
// GET
//   Loads all agent issue reports.
//
// POST
//   Updates an issue status, priority, and admin notes.

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SECRET_KEY;

const supabase = createClient(
  SUPABASE_URL || "",
  SERVICE_ROLE_KEY || "",
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);

function send(res, status, body) {
  return res.status(status).json(body);
}

function bearerToken(req) {
  const h = String(req.headers.authorization || "");

  return /^Bearer\s+/i.test(h)
    ? h.replace(/^Bearer\s+/i, "").trim()
    : "";
}

async function requireAdmin(req) {
  const token = bearerToken(req);

  if (!token) {
    throw Object.assign(
      new Error("Missing admin token."),
      { statusCode: 401 }
    );
  }

  const {
    data,
    error
  } = await supabase.auth.getUser(token);

  if (error || !data?.user) {
    throw Object.assign(
      new Error("Invalid or expired admin session."),
      { statusCode: 401 }
    );
  }

  const user = data.user;

  /*
    BlueVera may have used different admin-user columns
    during development, so this checks the common possibilities.
  */

  const candidates = [
    ["auth_user_id", user.id],
    ["user_id", user.id],
    ["id", user.id],
    ["email", user.email || ""]
  ];

  for (const [column, value] of candidates) {
    if (!value) {
      continue;
    }

    const {
      data: rows,
      error: lookupError
    } = await supabase
      .from("admin_users")
      .select("*")
      .eq(column, value)
      .limit(1);

    if (!lookupError && rows?.length) {
      const row = rows[0];

      if (
        row.active === false ||
        row.is_active === false ||
        String(row.status || "").toLowerCase() === "disabled"
      ) {
        throw Object.assign(
          new Error("This admin account is disabled."),
          { statusCode: 403 }
        );
      }

      return user;
    }

    /*
      PostgreSQL code 42703 means the column does not exist.
      We ignore that and try the next possible admin column.
    */

    if (
      lookupError &&
      lookupError.code !== "42703"
    ) {
      console.error(
        "Admin lookup error:",
        lookupError
      );
    }
  }

  throw Object.assign(
    new Error(
      "You do not have permission to use this admin tool."
    ),
    { statusCode: 403 }
  );
}

async function listIssues(res) {
  const {
    data,
    error
  } = await supabase
    .from("agent_issue_reports")
    .select("*")
    .order(
      "created_at",
      { ascending: false }
    );

  if (error) {
    console.error(
      "List agent issues failed:",
      error
    );

    return send(
      res,
      500,
      {
        success: false,
        error: "Unable to load agent issues."
      }
    );
  }

  return send(
    res,
    200,
    {
      success: true,
      issues: data || []
    }
  );
}

async function updateIssue(req, res) {
  const issueId = String(
    req.body?.issueId || ""
  ).trim();

  const status = String(
    req.body?.status || ""
  )
    .trim()
    .toLowerCase();

  const priority = String(
    req.body?.priority || ""
  )
    .trim()
    .toLowerCase();

  const adminNotes = String(
    req.body?.adminNotes ?? ""
  )
    .trim()
    .slice(0, 5000);

  if (!issueId) {
    return send(
      res,
      400,
      {
        success: false,
        error: "Issue ID is required."
      }
    );
  }

  if (
    ![
      "open",
      "in_progress",
      "resolved"
    ].includes(status)
  ) {
    return send(
      res,
      400,
      {
        success: false,
        error: "Invalid issue status."
      }
    );
  }

  if (
    ![
      "low",
      "normal",
      "high"
    ].includes(priority)
  ) {
    return send(
      res,
      400,
      {
        success: false,
        error: "Invalid priority."
      }
    );
  }

  const now =
    new Date().toISOString();

  const patch = {
    status,
    priority,

    admin_notes:
      adminNotes || null,

    updated_at:
      now,

    reviewed_at:
      status === "open"
        ? null
        : now,

    resolved_at:
      status === "resolved"
        ? now
        : null
  };

  const {
    data,
    error
  } = await supabase
    .from("agent_issue_reports")
    .update(patch)
    .eq(
      "id",
      issueId
    )
    .select("*")
    .single();

  if (error) {
    console.error(
      "Update agent issue failed:",
      error
    );

    return send(
      res,
      500,
      {
        success: false,
        error:
          "Unable to update the issue."
      }
    );
  }

  return send(
    res,
    200,
    {
      success: true,
      issue: data
    }
  );
}

module.exports =
  async function handler(req, res) {
    try {
      if (
        !SUPABASE_URL ||
        !SERVICE_ROLE_KEY
      ) {
        return send(
          res,
          500,
          {
            success: false,
            error:
              "Admin issue service is not configured."
          }
        );
      }

      await requireAdmin(req);

      if (
        req.method === "GET"
      ) {
        return listIssues(res);
      }

      if (
        req.method === "POST" &&
        req.body?.action === "update"
      ) {
        return updateIssue(
          req,
          res
        );
      }

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
        "Admin agent issues API error:",
        error
      );

      return send(
        res,
        error.statusCode || 500,
        {
          success: false,
          error:
            error.message ||
            "Agent issue request failed."
        }
      );
    }
  };

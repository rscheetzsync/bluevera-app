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

function getBearerToken(req) {
  const authHeader = String(
    req.headers.authorization || ""
  );

  if (!/^Bearer\s+/i.test(authHeader)) {
    return "";
  }

  return authHeader
    .replace(/^Bearer\s+/i, "")
    .trim();
}

async function verifyAdmin(req) {
  const token = getBearerToken(req);

  if (!token) {
    const error = new Error(
      "Admin authentication token is missing."
    );
    error.statusCode = 401;
    throw error;
  }

  const {
    data,
    error
  } = await supabase.auth.getUser(token);

  if (
    error ||
    !data ||
    !data.user
  ) {
    const authError = new Error(
      "Admin session is invalid or expired."
    );

    authError.statusCode = 401;

    throw authError;
  }

  const user = data.user;

  /*
    Check BlueVera admin_users table.

    This tries several possible column names
    because admin tables sometimes evolve
    during development.
  */

  const possibleMatches = [
    {
      column: "auth_user_id",
      value: user.id
    },
    {
      column: "user_id",
      value: user.id
    },
    {
      column: "id",
      value: user.id
    },
    {
      column: "email",
      value: user.email || ""
    }
  ];

  for (
    const match
    of possibleMatches
  ) {
    if (!match.value) {
      continue;
    }

    const {
      data: adminRows,
      error: lookupError
    } = await supabase
      .from("admin_users")
      .select("*")
      .eq(
        match.column,
        match.value
      )
      .limit(1);

    if (
      !lookupError &&
      adminRows &&
      adminRows.length > 0
    ) {
      const admin = adminRows[0];

      if (
        admin.active === false ||
        admin.is_active === false ||
        String(
          admin.status || ""
        ).toLowerCase() === "disabled"
      ) {
        const disabledError =
          new Error(
            "This admin account is disabled."
          );

        disabledError.statusCode = 403;

        throw disabledError;
      }

      return user;
    }

    /*
      PostgreSQL 42703:
      column does not exist.

      Ignore it and try the next possible
      admin column.
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

  const permissionError =
    new Error(
      "You do not have permission to use this admin tool."
    );

  permissionError.statusCode = 403;

  throw permissionError;
}

async function loadIssues(res) {
  const {
    data,
    error
  } = await supabase
    .from("agent_issue_reports")
    .select("*")
    .order(
      "created_at",
      {
        ascending: false
      }
    );

  if (error) {
    console.error(
      "Unable to load agent issues:",
      error
    );

    return send(
      res,
      500,
      {
        success: false,
        error:
          "Unable to load agent issues."
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

async function updateIssue(
  req,
  res
) {
  const issueId =
    String(
      req.body?.issueId || ""
    ).trim();

  const status =
    String(
      req.body?.status || ""
    )
      .trim()
      .toLowerCase();

  const priority =
    String(
      req.body?.priority || ""
    )
      .trim()
      .toLowerCase();

  const adminNotes =
    String(
      req.body?.adminNotes || ""
    )
      .trim()
      .slice(
        0,
        5000
      );

  if (!issueId) {
    return send(
      res,
      400,
      {
        success: false,
        error:
          "Issue ID is required."
      }
    );
  }

  const validStatuses = [
    "open",
    "in_progress",
    "resolved"
  ];

  if (
    !validStatuses.includes(
      status
    )
  ) {
    return send(
      res,
      400,
      {
        success: false,
        error:
          "Invalid issue status."
      }
    );
  }

  const validPriorities = [
    "low",
    "normal",
    "high"
  ];

  if (
    !validPriorities.includes(
      priority
    )
  ) {
    return send(
      res,
      400,
      {
        success: false,
        error:
          "Invalid issue priority."
      }
    );
  }

  const now =
    new Date().toISOString();

  const updateData = {
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
    .from(
      "agent_issue_reports"
    )
    .update(
      updateData
    )
    .eq(
      "id",
      issueId
    )
    .select("*")
    .single();

  if (error) {
    console.error(
      "Unable to update agent issue:",
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
  async function handler(
    req,
    res
  ) {
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

      await verifyAdmin(req);

      /*
        GET
        Load all agent issues.
      */

      if (
        req.method === "GET"
      ) {
        return loadIssues(res);
      }

      /*
        POST
        Update an existing issue.
      */

      if (
        req.method === "POST"
      ) {
        const action =
          String(
            req.body?.action || ""
          ).trim();

        if (
          action === "update"
        ) {
          return updateIssue(
            req,
            res
          );
        }
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
        "Admin Agent Issues API error:",
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

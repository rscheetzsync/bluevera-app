// api/admin-property-errors.js
// BlueVera Admin API for property error reports.
//
// Supports:
//   GET  ?action=list
//   GET  ?action=load&id=<error uuid>
//   POST { action:"update", errorId, status, adminNotes }
//
// Required Vercel environment variables:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
}

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
  res.status(status).json(body);
}

function bearerToken(req) {
  const header = String(req.headers.authorization || "");

  if (!header.toLowerCase().startsWith("bearer ")) {
    return "";
  }

  return header.slice(7).trim();
}

async function requireAuthenticatedUser(req) {
  const token = bearerToken(req);

  if (!token) {
    throw Object.assign(
      new Error("Missing authorization token."),
      { statusCode: 401 }
    );
  }

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data?.user) {
    throw Object.assign(
      new Error("Invalid or expired admin session."),
      { statusCode: 401 }
    );
  }

  return data.user;
}

async function requireAdmin(user) {
  if (!user?.id) {
    throw Object.assign(
      new Error("Admin user could not be identified."),
      { statusCode: 401 }
    );
  }

  const candidateQueries = [
    { column: "auth_user_id", value: user.id },
    { column: "user_id", value: user.id },
    { column: "id", value: user.id },
    { column: "email", value: user.email || "" }
  ];

  let tableMissing = false;

  for (const query of candidateQueries) {
    if (!query.value) continue;

    const { data, error } = await supabase
      .from("admin_users")
      .select("*")
      .eq(query.column, query.value)
      .limit(1);

    if (!error && Array.isArray(data) && data.length > 0) {
      const row = data[0];

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

      return row;
    }

    if (error?.code === "42P01") {
      tableMissing = true;
      break;
    }

    if (error && error.code !== "42703") {
      console.error("Admin lookup error:", error);
    }
  }

  if (tableMissing) {
    throw Object.assign(
      new Error("Admin authorization table is not available."),
      { statusCode: 500 }
    );
  }

  throw Object.assign(
    new Error("You do not have permission to use this admin tool."),
    { statusCode: 403 }
  );
}

function cleanStatus(value) {
  const status = String(value || "").trim().toLowerCase();

  if (!["open", "reviewing", "resolved"].includes(status)) {
    throw Object.assign(
      new Error("Status must be open, reviewing, or resolved."),
      { statusCode: 400 }
    );
  }

  return status;
}

function cleanNotes(value) {
  const notes = String(value ?? "").trim();

  if (notes.length > 5000) {
    throw Object.assign(
      new Error("Admin notes must be 5,000 characters or fewer."),
      { statusCode: 400 }
    );
  }

  return notes || null;
}

async function listErrors(req, res) {
  const { data, error } = await supabase
    .from("property_error_reports")
    .select(`
      id,
      property_id,
      property_address,
      reported_by_user_id,
      reported_by_name,
      reported_by_email,
      error_category,
      error_description,
      status,
      admin_notes,
      created_at,
      reviewed_at,
      resolved_at,
      updated_at
    `)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("List property errors failed:", error);

    return send(res, 500, {
      success: false,
      error: "Unable to load property error reports."
    });
  }

  return send(res, 200, {
    success: true,
    errors: data || []
  });
}

async function loadError(req, res) {
  const id = String(req.query.id || "").trim();

  if (!id) {
    return send(res, 400, {
      success: false,
      error: "Error report ID is required."
    });
  }

  const { data, error } = await supabase
    .from("property_error_reports")
    .select(`
      id,
      property_id,
      property_address,
      reported_by_user_id,
      reported_by_name,
      reported_by_email,
      error_category,
      error_description,
      status,
      admin_notes,
      created_at,
      reviewed_at,
      resolved_at,
      updated_at
    `)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("Load property error failed:", error);

    return send(res, 500, {
      success: false,
      error: "Unable to load this property error report."
    });
  }

  if (!data) {
    return send(res, 404, {
      success: false,
      error: "Property error report not found."
    });
  }

  return send(res, 200, {
    success: true,
    error_report: data
  });
}

async function updateError(req, res, adminUser) {
  const body = req.body || {};

  const errorId = String(body.errorId || "").trim();
  const status = cleanStatus(body.status);
  const adminNotes = cleanNotes(body.adminNotes);

  if (!errorId) {
    return send(res, 400, {
      success: false,
      error: "Error report ID is required."
    });
  }

  const now = new Date().toISOString();

  const update = {
    status,
    admin_notes: adminNotes,
    updated_at: now
  };

  if (status === "reviewing") {
    update.reviewed_at = now;
    update.resolved_at = null;
  }

  if (status === "resolved") {
    update.reviewed_at = now;
    update.resolved_at = now;
  }

  if (status === "open") {
    update.resolved_at = null;
  }

  const { data, error } = await supabase
    .from("property_error_reports")
    .update(update)
    .eq("id", errorId)
    .select(`
      id,
      property_id,
      property_address,
      reported_by_user_id,
      reported_by_name,
      reported_by_email,
      error_category,
      error_description,
      status,
      admin_notes,
      created_at,
      reviewed_at,
      resolved_at,
      updated_at
    `)
    .maybeSingle();

  if (error) {
    console.error("Update property error failed:", error);

    return send(res, 500, {
      success: false,
      error: "Unable to update this property error report."
    });
  }

  if (!data) {
    return send(res, 404, {
      success: false,
      error: "Property error report not found."
    });
  }

  console.log(
    "Property error updated",
    errorId,
    "by",
    adminUser?.email || adminUser?.id || "admin",
    "to",
    status
  );

  return send(res, 200, {
    success: true,
    error_report: data
  });
}

module.exports = async function handler(req, res) {
  try {
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return send(res, 500, {
        success: false,
        error: "Server configuration is missing Supabase credentials."
      });
    }

    if (!["GET", "POST"].includes(req.method)) {
      res.setHeader("Allow", "GET, POST");

      return send(res, 405, {
        success: false,
        error: "Method not allowed."
      });
    }

    const user = await requireAuthenticatedUser(req);

    await requireAdmin(user);

    if (req.method === "GET") {
      const action = String(
        req.query.action || "list"
      ).toLowerCase();

      if (action === "list") {
        return await listErrors(req, res);
      }

      if (action === "load") {
        return await loadError(req, res);
      }

      return send(res, 400, {
        success: false,
        error: "Unknown GET action."
      });
    }

    if (req.method === "POST") {
      const action = String(
        req.body?.action || ""
      ).toLowerCase();

      if (action === "update") {
        return await updateError(
          req,
          res,
          user
        );
      }

      return send(res, 400, {
        success: false,
        error: "Unknown POST action."
      });
    }
  } catch (error) {
    console.error(
      "admin-property-errors API error:",
      error
    );

    return send(
      res,
      Number(error.statusCode) || 500,
      {
        success: false,
        error:
          error.message ||
          "The property error request failed."
      }
    );
  }
};

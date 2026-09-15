// api/agent-issues-submit.js
// Receives an issue from an authenticated BlueVera agent dashboard.

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;

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

function clean(value, max) {
  return String(value ?? "")
    .trim()
    .slice(0, max);
}

function normalizeIssueKey(category, title) {
  return `${category}::${title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 180);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return send(res, 405, {
      success: false,
      error: "Method not allowed."
    });
  }

  try {
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return send(res, 500, {
        success: false,
        error: "Agent issue service is not configured."
      });
    }

    const token = bearerToken(req);

    if (!token) {
      return send(res, 401, {
        success: false,
        error: "Agent authentication token is missing."
      });
    }

    // Verify the Supabase user from the agent's access token.
    const {
      data: authData,
      error: authError
    } = await supabase.auth.getUser(token);

    const user = authData?.user;

    if (authError || !user?.id) {
      return send(res, 401, {
        success: false,
        error: "Agent session is invalid or expired."
      });
    }

    // Match the authenticated Supabase user to the BlueVera agents table.
    const {
      data: profile,
      error: profileError
    } = await supabase
      .from("agents")
      .select(
        "id,auth_user_id,agent_name,brokerage_name,email,profile_status"
      )
      .eq("auth_user_id", user.id)
      .maybeSingle();

    if (profileError) {
      console.error(
        "Agent profile lookup failed:",
        profileError
      );

      return send(res, 500, {
        success: false,
        error: "Unable to verify the agent account."
      });
    }

    if (
      !profile ||
      String(profile.profile_status || "").toLowerCase() !== "approved"
    ) {
      return send(res, 403, {
        success: false,
        error: "This agent account is not approved."
      });
    }

    const title = clean(
      req.body?.issueTitle,
      160
    );

    const description = clean(
      req.body?.issueDescription,
      4000
    );

    const category = clean(
      req.body?.issueCategory,
      80
    );

    const priority = clean(
      req.body?.priority || "normal",
      20
    ).toLowerCase();

    const allowedCategories = new Set([
      "Property Reports",
      "Login / Access",
      "Saved Transactions",
      "Property Data",
      "Dashboard",
      "Search / Map",
      "Other"
    ]);

    if (!title || !description || !category) {
      return send(res, 400, {
        success: false,
        error:
          "Issue title, category, and description are required."
      });
    }

    if (!allowedCategories.has(category)) {
      return send(res, 400, {
        success: false,
        error: "Please select a valid issue category."
      });
    }

    if (
      !["low", "normal", "high"].includes(priority)
    ) {
      return send(res, 400, {
        success: false,
        error:
          "Priority must be low, normal, or high."
      });
    }

    const row = {
      agent_id: profile.id || null,

      auth_user_id: user.id,

      agent_name: clean(
        profile.agent_name,
        160
      ),

      agent_email: clean(
        profile.email || user.email,
        320
      ),

      brokerage_name: clean(
        profile.brokerage_name,
        200
      ),

      issue_title: title,

      issue_category: category,

      issue_description: description,

      issue_key: normalizeIssueKey(
        category,
        title
      ),

      page_name: clean(
        req.body?.pageName,
        120
      ),

      page_url: clean(
        req.body?.pageUrl,
        1000
      ),

      property_id:
        req.body?.propertyId || null,

      property_address:
        clean(
          req.body?.propertyAddress,
          300
        ) || null,

      mls_number:
        clean(
          req.body?.mlsNumber,
          80
        ) || null,

      priority,

      status: "open"
    };

    const {
      data,
      error
    } = await supabase
      .from("agent_issue_reports")
      .insert(row)
      .select("id,created_at")
      .single();

    if (error) {
      console.error(
        "Insert agent issue failed:",
        error
      );

      return send(res, 500, {
        success: false,
        error: "Unable to submit the issue."
      });
    }

    return send(res, 200, {
      success: true,
      issueId: data.id,
      createdAt: data.created_at
    });

  } catch (error) {
    console.error(
      "Agent issue submit error:",
      error
    );

    return send(res, 500, {
      success: false,
      error: "Unable to submit the issue."
    });
  }
};

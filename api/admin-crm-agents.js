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
  const header = String(
    req.headers.authorization || ""
  );

  if (!header.toLowerCase().startsWith("bearer ")) {
    return "";
  }

  return header.slice(7).trim();
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
    data: authData,
    error: authError
  } = await supabase.auth.getUser(token);

  if (
    authError ||
    !authData?.user
  ) {
    throw Object.assign(
      new Error("Invalid or expired admin session."),
      { statusCode: 401 }
    );
  }

  const user = authData.user;

  const {
    data: adminUser,
    error: adminError
  } = await supabase
    .from("admin_users")
    .select(
      "id,email,role,is_active,display_name,default_page"
    )
    .eq(
      "email",
      String(user.email || "").toLowerCase()
    )
    .maybeSingle();

  if (adminError) {
    console.error(
      "Admin lookup failed:",
      adminError
    );

    throw Object.assign(
      new Error("Unable to verify admin account."),
      { statusCode: 500 }
    );
  }

  if (!adminUser) {
    throw Object.assign(
      new Error("Admin access required."),
      { statusCode: 403 }
    );
  }

  if (adminUser.is_active === false) {
    throw Object.assign(
      new Error("Admin account is disabled."),
      { statusCode: 403 }
    );
  }

  return adminUser;
}

function clean(value) {
  if (
    value === undefined ||
    value === null
  ) {
    return "";
  }

  return String(value).trim();
}

module.exports = async function handler(
  req,
  res
) {
  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return send(res, 500, {
      ok: false,
      error:
        "CRM API is missing Supabase environment variables."
    });
  }

  try {
    const adminUser =
      await requireAdmin(req);

    // ==================================================
    // GET AGENTS
    // ==================================================

    if (req.method === "GET") {
      const owner =
        clean(req.query.owner) || "all";

      const status =
        clean(req.query.status);

      const search =
        clean(req.query.search);

      const page =
        Math.max(
          parseInt(req.query.page || "1", 10),
          1
        );

      const limit =
        Math.min(
          Math.max(
            parseInt(
              req.query.limit || "50",
              10
            ),
            1
          ),
          100
        );

      const from =
        (page - 1) * limit;

      const to =
        from + limit - 1;

      let query = supabase
        .from("crm_agents")
        .select("*", {
          count: "exact"
        })
        .eq("is_active", true);

      // ------------------------------------------
      // OWNER FILTER
      // ------------------------------------------

      if (owner === "mine") {
        query = query.eq(
          "assigned_user_id",
          adminUser.id
        );
      }

      if (owner === "unassigned") {
        query = query.is(
          "assigned_user_id",
          null
        );
      }

      // ------------------------------------------
      // STATUS FILTER
      // ------------------------------------------

      if (
        status &&
        status !== "all"
      ) {
        query = query.eq(
          "status",
          status
        );
      }

      // ------------------------------------------
      // SEARCH
      // ------------------------------------------

      if (search) {
        const safeSearch =
          search
            .replace(/,/g, " ")
            .trim();

        query = query.or(
          [
            `first_name.ilike.%${safeSearch}%`,
            `last_name.ilike.%${safeSearch}%`,
            `email.ilike.%${safeSearch}%`,
            `phone.ilike.%${safeSearch}%`,
            `source.ilike.%${safeSearch}%`,
            `notes.ilike.%${safeSearch}%`
          ].join(",")
        );
      }

      const {
        data,
        error,
        count
      } = await query
        .order(
          "last_name",
          { ascending: true }
        )
        .order(
          "first_name",
          { ascending: true }
        )
        .range(from, to);

      if (error) {
        console.error(
          "CRM AGENTS SUPABASE ERROR:",
          error
        );

        return send(res, 500, {
          ok: false,
          error:
            "Unable to load CRM agents.",
          details: error.message,
          code: error.code,
          hint: error.hint || null
        });
      }

      const agents =
        (data || []).map(
          agent => ({
            ...agent,

            full_name:
              [
                agent.first_name,
                agent.last_name
              ]
                .filter(Boolean)
                .join(" ")
                .trim()
          })
        );

      return send(res, 200, {
        ok: true,

        admin: {
          id: adminUser.id,
          email: adminUser.email,
          display_name:
            adminUser.display_name,
          role: adminUser.role
        },

        agents,

        pagination: {
          page,
          limit,
          total: count || 0,
          totalPages:
            count
              ? Math.ceil(
                  count / limit
                )
              : 0
        }
      });
    }

    // ==================================================
    // ADD AGENT
    // ==================================================

    if (req.method === "POST") {
      const body =
        req.body || {};

      const firstName =
        clean(body.first_name);

      const lastName =
        clean(body.last_name);

      const email =
        clean(body.email)
          .toLowerCase();

      const phone =
        clean(body.phone);

      if (
        !firstName &&
        !lastName
      ) {
        return send(res, 400, {
          ok: false,
          error:
            "Agent name is required."
        });
      }

      if (!email && !phone) {
        return send(res, 400, {
          ok: false,
          error:
            "Email or phone is required."
        });
      }

      if (email) {
        const {
          data: existing,
          error: duplicateError
        } = await supabase
          .from("crm_agents")
          .select(
            "id,first_name,last_name,email"
          )
          .eq(
            "email",
            email
          )
          .maybeSingle();

        if (duplicateError) {
          console.error(
            "Duplicate lookup error:",
            duplicateError
          );
        }

        if (existing) {
          return send(res, 409, {
            ok: false,
            error:
              "This email already exists in CRM.",
            agent: existing
          });
        }
      }

      const newAgent = {
        first_name:
          firstName || null,

        last_name:
          lastName || null,

        email:
          email || null,

        phone:
          phone || null,

        license_number:
          clean(
            body.license_number
          ) || null,

        brokerage_id:
          clean(
            body.brokerage_id
          ) || null,

        status:
          clean(body.status) ||
          "new_contact",

        source:
          clean(body.source) ||
          null,

        assigned_user_id:
          body.assign_to_me
            ? adminUser.id
            : (
                clean(
                  body.assigned_user_id
                ) || null
              ),

        signed_up:
          body.signed_up === true,

        notes:
          clean(body.notes) ||
          null,

        is_active: true,

        updated_at:
          new Date().toISOString()
      };

      const {
        data,
        error
      } = await supabase
        .from("crm_agents")
        .insert(newAgent)
        .select("*")
        .single();

      if (error) {
        console.error(
          "CRM agent insert error:",
          error
        );

        return send(res, 500, {
          ok: false,
          error:
            "Unable to add CRM agent.",
          details:
            error.message
        });
      }

      return send(res, 201, {
        ok: true,
        agent: data
      });
    }

    // ==================================================
    // UPDATE AGENT
    // ==================================================

    if (req.method === "PATCH") {
      const body =
        req.body || {};

      const id =
        clean(body.id);

      if (!id) {
        return send(res, 400, {
          ok: false,
          error:
            "CRM agent id is required."
        });
      }

      const allowed = [
        "first_name",
        "last_name",
        "email",
        "phone",
        "license_number",
        "brokerage_id",
        "status",
        "source",
        "assigned_user_id",
        "last_contact_at",
        "next_follow_up_at",
        "signed_up",
        "notes",
        "is_active",
        "bluevera_agent_id"
      ];

      const updates = {};

      for (
        const field of allowed
      ) {
        if (
          Object.prototype.hasOwnProperty.call(
            body,
            field
          )
        ) {
          updates[field] =
            body[field];
        }
      }

      if (body.assign_to_me === true) {
        updates.assigned_user_id =
          adminUser.id;
      }

      updates.updated_at =
        new Date().toISOString();

      const {
        data,
        error
      } = await supabase
        .from("crm_agents")
        .update(updates)
        .eq("id", id)
        .select("*")
        .maybeSingle();

      if (error) {
        console.error(
          "CRM agent update error:",
          error
        );

        return send(res, 500, {
          ok: false,
          error:
            "Unable to update CRM agent.",
          details:
            error.message
        });
      }

      if (!data) {
        return send(res, 404, {
          ok: false,
          error:
            "CRM agent not found."
        });
      }

      return send(res, 200, {
        ok: true,
        agent: data
      });
    }

    return send(res, 405, {
      ok: false,
      error:
        "Method not allowed."
    });

  } catch (error) {
    console.error(
      "CRM API ERROR:",
      error
    );

    return send(
      res,
      error.statusCode || 500,
      {
        ok: false,
        error:
          error.message ||
          "Unexpected CRM error."
      }
    );
  }
};

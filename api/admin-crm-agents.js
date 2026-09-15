const { createClient } = require("@supabase/supabase-js");

function send(res, status, body) {
  return res.status(status).json(body);
}

function getBearerToken(req) {
  const header = String(req.headers.authorization || "");

  if (!/^Bearer\s+/i.test(header)) {
    return "";
  }

  return header.replace(/^Bearer\s+/i, "").trim();
}

function clean(value) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value).trim();
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  try {
    // =====================================================
    // LOAD ENVIRONMENT VARIABLES INSIDE THE FUNCTION
    // =====================================================

    const supabaseUrl =
      process.env.SUPABASE_URL ||
      process.env.NEXT_PUBLIC_SUPABASE_URL;

    const serviceRoleKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_KEY ||
      process.env.SUPABASE_SECRET_KEY;

    if (!supabaseUrl) {
      return send(res, 500, {
        ok: false,
        error: "SUPABASE_URL is missing."
      });
    }

    if (!serviceRoleKey) {
      return send(res, 500, {
        ok: false,
        error: "Supabase service role key is missing."
      });
    }

    // =====================================================
    // CREATE SUPABASE CLIENT
    // =====================================================

    const supabase = createClient(
      supabaseUrl,
      serviceRoleKey,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      }
    );

    // =====================================================
    // VERIFY ADMIN SESSION
    // =====================================================

    const token = getBearerToken(req);

    if (!token) {
      return send(res, 401, {
        ok: false,
        error: "Missing admin authentication token."
      });
    }

    const {
      data: authData,
      error: authError
    } = await supabase.auth.getUser(token);

    if (authError || !authData?.user) {
      console.error(
        "Admin authentication failed:",
        authError
      );

      return send(res, 401, {
        ok: false,
        error: "Invalid or expired admin session."
      });
    }

    const authUser = authData.user;

    // =====================================================
    // VERIFY ADMIN_USERS RECORD
    // =====================================================

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
        String(authUser.email || "")
          .trim()
          .toLowerCase()
      )
      .maybeSingle();

    if (adminError) {
      console.error(
        "admin_users lookup failed:",
        adminError
      );

      return send(res, 500, {
        ok: false,
        error: "Unable to verify admin account.",
        details: adminError.message,
        code: adminError.code
      });
    }

    if (!adminUser) {
      return send(res, 403, {
        ok: false,
        error: "Admin account not found."
      });
    }

    if (adminUser.is_active === false) {
      return send(res, 403, {
        ok: false,
        error: "Admin account is disabled."
      });
    }

    // =====================================================
    // GET CRM AGENTS
    // =====================================================

    if (req.method === "GET") {
      const owner =
        clean(req.query.owner) || "all";

      const status =
        clean(req.query.status);

      const search =
        clean(req.query.search);

      const page =
        Math.max(
          Number.parseInt(
            req.query.page || "1",
            10
          ) || 1,
          1
        );

      const limit =
        Math.min(
          Math.max(
            Number.parseInt(
              req.query.limit || "50",
              10
            ) || 50,
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

      // OWNER FILTER
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

      // STATUS FILTER
      if (
        status &&
        status !== "all"
      ) {
        query = query.eq(
          "status",
          status
        );
      }

      // SEARCH
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
        data: agents,
        error: agentsError,
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

      if (agentsError) {
        console.error(
          "crm_agents query failed:",
          agentsError
        );

        return send(res, 500, {
          ok: false,
          error: "Unable to load CRM agents.",
          details: agentsError.message,
          code: agentsError.code,
          hint: agentsError.hint || null
        });
      }

      const formattedAgents =
        (agents || []).map(
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
            adminUser.display_name || null,
          role: adminUser.role
        },

        agents: formattedAgents,

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

    // =====================================================
    // POST - ADD CRM AGENT
    // =====================================================

    if (req.method === "POST") {
      const body = req.body || {};

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
          error: "Agent name is required."
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
          error: existingError
        } = await supabase
          .from("crm_agents")
          .select(
            "id,first_name,last_name,email"
          )
          .ilike(
            "email",
            email
          )
          .maybeSingle();

        if (existingError) {
          console.error(
            "Duplicate check failed:",
            existingError
          );

          return send(res, 500, {
            ok: false,
            error:
              "Unable to check CRM duplicate.",
            details:
              existingError.message
          });
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
          clean(
            body.status
          ) || "new_contact",

        source:
          clean(
            body.source
          ) || null,

        assigned_user_id:
          body.assign_to_me === true
            ? adminUser.id
            : (
                clean(
                  body.assigned_user_id
                ) || null
              ),

        signed_up:
          body.signed_up === true,

        notes:
          clean(
            body.notes
          ) || null,

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
          "CRM insert failed:",
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

    // =====================================================
    // PATCH - UPDATE CRM AGENT
    // =====================================================

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

      const allowedFields = [
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
        const field of allowedFields
      ) {
        if (
          Object.prototype
            .hasOwnProperty.call(
              body,
              field
            )
        ) {
          updates[field] =
            body[field];
        }
      }

      if (
        body.assign_to_me === true
      ) {
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
          "CRM update failed:",
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
      error: "Method not allowed."
    });

  } catch (error) {
    console.error(
      "admin-crm-agents fatal error:",
      error
    );

    return send(res, 500, {
      ok: false,
      error:
        error?.message ||
        "Unexpected CRM API error."
    });
  }
};

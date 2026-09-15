// api/admin-crm-agents.js
// BlueVera CRM Agents API
// Uses native fetch - NO @supabase/supabase-js package required.

function send(res, status, body) {
  return res.status(status).json(body);
}

function clean(value) {
  return String(value ?? "").trim();
}

function bearerToken(req) {
  const header = String(req.headers.authorization || "");

  return /^Bearer\s+/i.test(header)
    ? header.replace(/^Bearer\s+/i, "").trim()
    : "";
}

async function readJson(response) {
  const text = await response.text();

  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return {
      raw: text
    };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  try {
    // =====================================================
    // ENVIRONMENT VARIABLES
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
        error: "Supabase service key is missing."
      });
    }

    // =====================================================
    // VERIFY LOGGED-IN ADMIN
    // =====================================================

    const token = bearerToken(req);

    if (!token) {
      return send(res, 401, {
        ok: false,
        error: "Missing admin authentication token."
      });
    }

    const authResponse = await fetch(
      `${supabaseUrl}/auth/v1/user`,
      {
        method: "GET",

        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${token}`
        }
      }
    );

    const authUser = await readJson(authResponse);

    if (!authResponse.ok || !authUser?.id) {
      console.error(
        "CRM auth failed:",
        authUser
      );

      return send(res, 401, {
        ok: false,
        error: "Invalid or expired admin session."
      });
    }

    const email =
      clean(authUser.email).toLowerCase();

    if (!email) {
      return send(res, 401, {
        ok: false,
        error: "Authenticated user email is missing."
      });
    }

    // =====================================================
    // VERIFY ADMIN_USERS RECORD
    // =====================================================

    const adminParams =
      new URLSearchParams({
        email: `eq.${email}`,
        select:
          "id,email,role,is_active,display_name,default_page",
        limit: "1"
      });

    const adminResponse = await fetch(
      `${supabaseUrl}/rest/v1/admin_users?${adminParams.toString()}`,
      {
        method: "GET",

        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          Accept: "application/json"
        }
      }
    );

    const adminRows =
      await readJson(adminResponse);

    if (!adminResponse.ok) {
      console.error(
        "admin_users lookup failed:",
        adminRows
      );

      return send(res, 500, {
        ok: false,
        error: "Unable to verify admin account.",
        details:
          adminRows?.message ||
          adminRows?.error ||
          null
      });
    }

    const adminUser =
      Array.isArray(adminRows)
        ? adminRows[0]
        : null;

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
          parseInt(req.query.page || "1", 10) || 1,
          1
        );

      const limit =
        Math.min(
          Math.max(
            parseInt(
              req.query.limit || "50",
              10
            ) || 50,
            1
          ),
          100
        );

      const offset =
        (page - 1) * limit;

      const params =
        new URLSearchParams();

      params.set("select", "*");
      params.set("is_active", "eq.true");

      params.set(
        "order",
        "last_name.asc,first_name.asc"
      );

      params.set(
        "limit",
        String(limit)
      );

      params.set(
        "offset",
        String(offset)
      );

      // OWNER FILTER
      if (owner === "mine") {
        params.set(
          "assigned_user_id",
          `eq.${adminUser.id}`
        );
      }

      if (owner === "unassigned") {
        params.set(
          "assigned_user_id",
          "is.null"
        );
      }

      // STATUS FILTER
      if (
        status &&
        status !== "all"
      ) {
        params.set(
          "status",
          `eq.${status}`
        );
      }

      // SEARCH FILTER
      if (search) {
        const safeSearch =
          search
            .replace(/,/g, " ")
            .replace(/\(/g, "")
            .replace(/\)/g, "")
            .trim();

        const pattern =
          `*${safeSearch}*`;

        params.set(
          "or",
          [
            `first_name.ilike.${pattern}`,
            `last_name.ilike.${pattern}`,
            `email.ilike.${pattern}`,
            `phone.ilike.${pattern}`,
            `source.ilike.${pattern}`,
            `notes.ilike.${pattern}`
          ].join(",")
        );
      }

      const agentsResponse =
        await fetch(
          `${supabaseUrl}/rest/v1/crm_agents?${params.toString()}`,
          {
            method: "GET",

            headers: {
              apikey: serviceRoleKey,
              Authorization:
                `Bearer ${serviceRoleKey}`,

              Prefer:
                "count=exact",

              Accept:
                "application/json"
            }
          }
        );

      const agents =
        await readJson(
          agentsResponse
        );

      if (!agentsResponse.ok) {
        console.error(
          "crm_agents load failed:",
          agents
        );

        return send(res, 500, {
          ok: false,
          error:
            "Unable to load CRM agents.",
          details:
            agents?.message ||
            agents?.error ||
            null
        });
      }

      let total =
        Array.isArray(agents)
          ? agents.length
          : 0;

      const contentRange =
        agentsResponse.headers.get(
          "content-range"
        );

      if (contentRange) {
        const match =
          contentRange.match(
            /\/(\d+|\*)$/
          );

        if (
          match &&
          match[1] !== "*"
        ) {
          total =
            parseInt(
              match[1],
              10
            ) || total;
        }
      }

      const formattedAgents =
        (Array.isArray(agents)
          ? agents
          : []
        ).map(agent => ({
          ...agent,

          full_name:
            [
              agent.first_name,
              agent.last_name
            ]
              .filter(Boolean)
              .join(" ")
              .trim()
        }));

      return send(res, 200, {
        ok: true,

        admin: {
          id:
            adminUser.id,

          email:
            adminUser.email,

          display_name:
            adminUser.display_name ||
            null,

          role:
            adminUser.role
        },

        agents:
          formattedAgents,

        pagination: {
          page,
          limit,
          total,

          totalPages:
            total > 0
              ? Math.ceil(
                  total / limit
                )
              : 0
        }
      });
    }

    // =====================================================
    // ADD CRM AGENT
    // =====================================================

    if (req.method === "POST") {
      const body =
        req.body || {};

      const firstName =
        clean(
          body.first_name
        );

      const lastName =
        clean(
          body.last_name
        );

      const email =
        clean(
          body.email
        ).toLowerCase();

      const phone =
        clean(
          body.phone
        );

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

      if (
        !email &&
        !phone
      ) {
        return send(res, 400, {
          ok: false,
          error:
            "Email or phone is required."
        });
      }

      // DUPLICATE EMAIL CHECK
      if (email) {
        const duplicateParams =
          new URLSearchParams({
            email:
              `eq.${email}`,

            select:
              "id,first_name,last_name,email",

            limit:
              "1"
          });

        const duplicateResponse =
          await fetch(
            `${supabaseUrl}/rest/v1/crm_agents?${duplicateParams.toString()}`,
            {
              headers: {
                apikey:
                  serviceRoleKey,

                Authorization:
                  `Bearer ${serviceRoleKey}`
              }
            }
          );

        const duplicateRows =
          await readJson(
            duplicateResponse
          );

        if (
          duplicateResponse.ok &&
          Array.isArray(
            duplicateRows
          ) &&
          duplicateRows.length
        ) {
          return send(res, 409, {
            ok: false,
            error:
              "This email already exists in CRM.",

            agent:
              duplicateRows[0]
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
          ) ||
          "new_contact",

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

        is_active:
          true,

        updated_at:
          new Date()
            .toISOString()
      };

      const insertResponse =
        await fetch(
          `${supabaseUrl}/rest/v1/crm_agents`,
          {
            method: "POST",

            headers: {
              apikey:
                serviceRoleKey,

              Authorization:
                `Bearer ${serviceRoleKey}`,

              "Content-Type":
                "application/json",

              Prefer:
                "return=representation"
            },

            body:
              JSON.stringify(
                newAgent
              )
          }
        );

      const inserted =
        await readJson(
          insertResponse
        );

      if (!insertResponse.ok) {
        console.error(
          "CRM insert failed:",
          inserted
        );

        return send(res, 500, {
          ok: false,
          error:
            "Unable to add CRM agent.",
          details:
            inserted?.message ||
            null
        });
      }

      return send(res, 201, {
        ok: true,

        agent:
          Array.isArray(inserted)
            ? inserted[0]
            : inserted
      });
    }

    // =====================================================
    // UPDATE CRM AGENT
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
        new Date()
          .toISOString();

      const updateResponse =
        await fetch(
          `${supabaseUrl}/rest/v1/crm_agents?id=eq.${encodeURIComponent(id)}`,
          {
            method:
              "PATCH",

            headers: {
              apikey:
                serviceRoleKey,

              Authorization:
                `Bearer ${serviceRoleKey}`,

              "Content-Type":
                "application/json",

              Prefer:
                "return=representation"
            },

            body:
              JSON.stringify(
                updates
              )
          }
        );

      const updated =
        await readJson(
          updateResponse
        );

      if (!updateResponse.ok) {
        console.error(
          "CRM update failed:",
          updated
        );

        return send(res, 500, {
          ok: false,
          error:
            "Unable to update CRM agent.",
          details:
            updated?.message ||
            null
        });
      }

      if (
        !Array.isArray(
          updated
        ) ||
        !updated.length
      ) {
        return send(res, 404, {
          ok: false,
          error:
            "CRM agent not found."
        });
      }

      return send(res, 200, {
        ok: true,
        agent:
          updated[0]
      });
    }

    return send(res, 405, {
      ok: false,
      error:
        "Method not allowed."
    });

  } catch (error) {
    console.error(
      "admin-crm-agents fatal:",
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

// api/admin-crm-brokerages.js
// BlueVera CRM Brokerages API
// Uses native fetch - no @supabase/supabase-js package required.

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
        "Brokerage CRM auth failed:",
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
    // GET BROKERAGES
    // =====================================================

    if (req.method === "GET") {
      const owner =
        clean(req.query.owner) || "all";

      const status =
        clean(req.query.status);

      const search =
        clean(req.query.search);

      const market =
        clean(req.query.market);

      const page =
        Math.max(
          parseInt(req.query.page || "1", 10) || 1,
          1
        );

      const limit =
        Math.min(
          Math.max(
            parseInt(req.query.limit || "50", 10) || 50,
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
        "name.asc,office_name.asc"
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

      // MARKET / STATE FILTER
      if (
        market &&
        market !== "all"
      ) {
        params.set(
          "state",
          `eq.${market}`
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
            `name.ilike.${pattern}`,
            `office_name.ilike.${pattern}`,
            `broker_name.ilike.${pattern}`,
            `email.ilike.${pattern}`,
            `phone.ilike.${pattern}`,
            `city.ilike.${pattern}`,
            `state.ilike.${pattern}`,
            `notes.ilike.${pattern}`
          ].join(",")
        );
      }

      const brokeragesResponse =
        await fetch(
          `${supabaseUrl}/rest/v1/crm_brokerages?${params.toString()}`,
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

      const brokerages =
        await readJson(
          brokeragesResponse
        );

      if (!brokeragesResponse.ok) {
        console.error(
          "crm_brokerages load failed:",
          brokerages
        );

        return send(res, 500, {
          ok: false,
          error:
            "Unable to load CRM brokerages.",
          details:
            brokerages?.message ||
            brokerages?.error ||
            null
        });
      }

      let total =
        Array.isArray(brokerages)
          ? brokerages.length
          : 0;

      const contentRange =
        brokeragesResponse.headers.get(
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

        brokerages:
          Array.isArray(brokerages)
            ? brokerages
            : [],

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
    // ADD BROKERAGE
    // =====================================================

    if (req.method === "POST") {
      const body =
        req.body || {};

      const name =
        clean(body.name);

      const officeName =
        clean(body.office_name);

      if (!name) {
        return send(res, 400, {
          ok: false,
          error:
            "Brokerage name is required."
        });
      }

      // Existing table requires office_name,
      // so default it to the brokerage name.
      const finalOfficeName =
        officeName || name;

      // DUPLICATE CHECK
      const duplicateParams =
        new URLSearchParams({
          name:
            `eq.${name}`,

          office_name:
            `eq.${finalOfficeName}`,

          select:
            "id,name,office_name,broker_name",

          limit:
            "1"
        });

      const duplicateResponse =
        await fetch(
          `${supabaseUrl}/rest/v1/crm_brokerages?${duplicateParams.toString()}`,
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
            "This brokerage office already exists in CRM.",

          brokerage:
            duplicateRows[0]
        });
      }

      const newBrokerage = {
        name,

        office_name:
          finalOfficeName,

        broker_name:
          clean(
            body.broker_name
          ) || null,

        phone:
          clean(
            body.phone
          ) || null,

        email:
          clean(
            body.email
          ).toLowerCase() || null,

        website:
          clean(
            body.website
          ) || null,

        address_line1:
          clean(
            body.address_line1
          ) || null,

        address_line2:
          clean(
            body.address_line2
          ) || null,

        city:
          clean(
            body.city
          ) || null,

        state:
          clean(
            body.state
          ) || null,

        zip:
          clean(
            body.zip
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

        last_contact_at:
          body.last_contact_at || null,

        next_follow_up_at:
          body.next_follow_up_at || null,

        partnership_status:
          clean(
            body.partnership_status
          ) || null,

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
          `${supabaseUrl}/rest/v1/crm_brokerages`,
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
                newBrokerage
              )
          }
        );

      const inserted =
        await readJson(
          insertResponse
        );

      if (!insertResponse.ok) {
        console.error(
          "CRM brokerage insert failed:",
          inserted
        );

        return send(res, 500, {
          ok: false,
          error:
            "Unable to add CRM brokerage.",
          details:
            inserted?.message ||
            null
        });
      }

      return send(res, 201, {
        ok: true,

        brokerage:
          Array.isArray(inserted)
            ? inserted[0]
            : inserted
      });
    }

    // =====================================================
    // UPDATE BROKERAGE
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
            "CRM brokerage id is required."
        });
      }

      const allowedFields = [
        "name",
        "office_name",
        "broker_name",
        "phone",
        "email",
        "website",
        "address_line1",
        "address_line2",
        "city",
        "state",
        "zip",
        "status",
        "source",
        "assigned_user_id",
        "last_contact_at",
        "next_follow_up_at",
        "partnership_status",
        "notes",
        "is_active"
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
          `${supabaseUrl}/rest/v1/crm_brokerages?id=eq.${encodeURIComponent(id)}`,
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
          "CRM brokerage update failed:",
          updated
        );

        return send(res, 500, {
          ok: false,
          error:
            "Unable to update CRM brokerage.",
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
            "CRM brokerage not found."
        });
      }

      return send(res, 200, {
        ok: true,

        brokerage:
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
      "admin-crm-brokerages fatal:",
      error
    );

    return send(res, 500, {
      ok: false,

      error:
        error?.message ||
        "Unexpected CRM brokerage API error."
    });
  }
};

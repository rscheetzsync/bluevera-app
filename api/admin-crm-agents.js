const { createClient } = require("@supabase/supabase-js");

function getSupabaseAdmin() {
  const supabaseUrl =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL;

  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing Supabase environment variables.");
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

async function getAdminUser(supabase, authUser) {
  if (!authUser) return null;

  const email = String(authUser.email || "").trim().toLowerCase();

  if (!email) return null;

  const { data, error } = await supabase
    .from("admin_users")
    .select(`
      id,
      email,
      role,
      is_active,
      display_name,
      default_page
    `)
    .ilike("email", email)
    .maybeSingle();

  if (error) {
    console.error("Admin lookup failed:", error);
    return null;
  }

  if (!data || data.is_active === false) {
    return null;
  }

  return data;
}

function normalizeText(value) {
  if (value === undefined || value === null) return null;

  const cleaned = String(value).trim();

  return cleaned === "" ? null : cleaned;
}

function normalizeEmail(value) {
  const email = normalizeText(value);

  return email ? email.toLowerCase() : null;
}

function fullName(agent) {
  return [agent.first_name, agent.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!["GET", "POST", "PATCH"].includes(req.method)) {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
    });
  }

  let supabase;

  try {
    supabase = getSupabaseAdmin();
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      ok: false,
      error: "Server configuration error",
    });
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.substring(7).trim()
    : null;

  if (!token) {
    return res.status(401).json({
      ok: false,
      error: "Missing authentication token",
    });
  }

  const {
    data: authData,
    error: authError,
  } = await supabase.auth.getUser(token);

  if (authError || !authData?.user) {
    console.error("Auth failed:", authError);

    return res.status(401).json({
      ok: false,
      error: "Invalid or expired session",
    });
  }

  const adminUser = await getAdminUser(
    supabase,
    authData.user
  );

  if (!adminUser) {
    return res.status(403).json({
      ok: false,
      error: "Admin access required",
    });
  }

  // ======================================================
  // GET CRM AGENTS
  // ======================================================

  if (req.method === "GET") {
    try {
      const search = normalizeText(req.query.search);
      const owner = normalizeText(req.query.owner) || "all";
      const status = normalizeText(req.query.status);

      const requestedPage = Number(req.query.page || 1);
      const requestedLimit = Number(req.query.limit || 50);

      const page =
        Number.isFinite(requestedPage) && requestedPage > 0
          ? Math.floor(requestedPage)
          : 1;

      const limit =
        Number.isFinite(requestedLimit)
          ? Math.min(
              Math.max(Math.floor(requestedLimit), 1),
              100
            )
          : 50;

      const from = (page - 1) * limit;
      const to = from + limit - 1;

      let query = supabase
        .from("crm_agents")
        .select(
          `
          id,
          bluevera_agent_id,
          brokerage_id,
          first_name,
          last_name,
          email,
          phone,
          license_number,
          status,
          source,
          assigned_user_id,
          last_contact_at,
          next_follow_up_at,
          signed_up,
          notes,
          is_active,
          created_at,
          updated_at
        `,
          { count: "exact" }
        )
        .eq("is_active", true);

      // Owner filter:
      // all
      // mine
      // unassigned
      // explicit admin user UUID

      if (owner === "mine") {
        query = query.eq(
          "assigned_user_id",
          adminUser.id
        );
      } else if (owner === "unassigned") {
        query = query.is(
          "assigned_user_id",
          null
        );
      } else if (
        owner !== "all" &&
        /^[0-9a-fA-F-]{36}$/.test(owner)
      ) {
        query = query.eq(
          "assigned_user_id",
          owner
        );
      }

      if (status && status !== "all") {
        query = query.eq(
          "status",
          status
        );
      }

      if (search) {
        const safeSearch = search
          .replace(/,/g, " ")
          .replace(/\s+/g, " ")
          .trim();

        query = query.or(
          [
            `first_name.ilike.%${safeSearch}%`,
            `last_name.ilike.%${safeSearch}%`,
            `email.ilike.%${safeSearch}%`,
            `phone.ilike.%${safeSearch}%`,
            `license_number.ilike.%${safeSearch}%`,
            `source.ilike.%${safeSearch}%`,
            `notes.ilike.%${safeSearch}%`,
          ].join(",")
        );
      }

      const {
        data,
        error,
        count,
      } = await query
        .order("last_name", {
          ascending: true,
          nullsFirst: false,
        })
        .order("first_name", {
          ascending: true,
          nullsFirst: false,
        })
        .range(from, to);

      if (error) {
        console.error(
          "CRM agent load failed:",
          error
        );

        return res.status(500).json({
          ok: false,
          error: "Unable to load CRM agents",
        });
      }

      const agents = (data || []).map((agent) => ({
        ...agent,
        full_name: fullName(agent),
      }));

      return res.status(200).json({
        ok: true,
        admin: {
          id: adminUser.id,
          email: adminUser.email,
          display_name:
            adminUser.display_name || null,
          role: adminUser.role,
        },
        agents,
        pagination: {
          page,
          limit,
          total: count || 0,
          totalPages:
            count && count > 0
              ? Math.ceil(count / limit)
              : 0,
        },
      });
    } catch (error) {
      console.error(
        "Unexpected CRM GET error:",
        error
      );

      return res.status(500).json({
        ok: false,
        error: "Unexpected server error",
      });
    }
  }

  // ======================================================
  // CREATE CRM AGENT
  // ======================================================

  if (req.method === "POST") {
    try {
      const body = req.body || {};

      const firstName =
        normalizeText(body.first_name);

      const lastName =
        normalizeText(body.last_name);

      const email =
        normalizeEmail(body.email);

      const phone =
        normalizeText(body.phone);

      const licenseNumber =
        normalizeText(body.license_number);

      const source =
        normalizeText(body.source);

      const status =
        normalizeText(body.status) ||
        "new_contact";

      const notes =
        normalizeText(body.notes);

      const brokerageId =
        normalizeText(body.brokerage_id);

      let assignedUserId =
        normalizeText(body.assigned_user_id);

      // If requested, automatically assign the
      // new CRM contact to the logged-in user.
      if (
        body.assign_to_me === true ||
        body.assign_to_me === "true"
      ) {
        assignedUserId = adminUser.id;
      }

      if (!firstName && !lastName) {
        return res.status(400).json({
          ok: false,
          error:
            "First name or last name is required",
        });
      }

      if (!email && !phone) {
        return res.status(400).json({
          ok: false,
          error:
            "Email or phone is required",
        });
      }

      if (email) {
        const {
          data: existing,
          error: duplicateError,
        } = await supabase
          .from("crm_agents")
          .select(`
            id,
            first_name,
            last_name,
            email
          `)
          .ilike("email", email)
          .maybeSingle();

        if (duplicateError) {
          console.error(
            "Duplicate lookup failed:",
            duplicateError
          );

          return res.status(500).json({
            ok: false,
            error:
              "Unable to verify CRM contact",
          });
        }

        if (existing) {
          return res.status(409).json({
            ok: false,
            error:
              "A CRM agent with this email already exists",
            existingAgent: existing,
          });
        }
      }

      const insertRow = {
        first_name: firstName,
        last_name: lastName,
        email,
        phone,
        license_number: licenseNumber,
        brokerage_id: brokerageId,
        status,
        source,
        assigned_user_id:
          assignedUserId || null,
        notes,
        signed_up: false,
        is_active: true,
        updated_at: new Date().toISOString(),
      };

      const {
        data,
        error,
      } = await supabase
        .from("crm_agents")
        .insert(insertRow)
        .select()
        .single();

      if (error) {
        console.error(
          "CRM agent insert failed:",
          error
        );

        return res.status(500).json({
          ok: false,
          error: "Unable to add CRM agent",
        });
      }

      return res.status(201).json({
        ok: true,
        agent: {
          ...data,
          full_name: fullName(data),
        },
      });
    } catch (error) {
      console.error(
        "Unexpected CRM POST error:",
        error
      );

      return res.status(500).json({
        ok: false,
        error: "Unexpected server error",
      });
    }
  }

  // ======================================================
  // UPDATE CRM AGENT
  // ======================================================

  if (req.method === "PATCH") {
    try {
      const body = req.body || {};
      const agentId =
        normalizeText(body.id);

      if (!agentId) {
        return res.status(400).json({
          ok: false,
          error: "CRM agent id is required",
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
        "bluevera_agent_id",
      ];

      const updates = {};

      for (const field of allowedFields) {
        if (
          Object.prototype.hasOwnProperty.call(
            body,
            field
          )
        ) {
          updates[field] = body[field];
        }
      }

      if (
        Object.prototype.hasOwnProperty.call(
          updates,
          "email"
        )
      ) {
        updates.email =
          normalizeEmail(updates.email);
      }

      if (
        Object.prototype.hasOwnProperty.call(
          updates,
          "first_name"
        )
      ) {
        updates.first_name =
          normalizeText(updates.first_name);
      }

      if (
        Object.prototype.hasOwnProperty.call(
          updates,
          "last_name"
        )
      ) {
        updates.last_name =
          normalizeText(updates.last_name);
      }

      if (
        Object.prototype.hasOwnProperty.call(
          updates,
          "phone"
        )
      ) {
        updates.phone =
          normalizeText(updates.phone);
      }

      if (
        Object.prototype.hasOwnProperty.call(
          body,
          "assign_to_me"
        ) &&
        (
          body.assign_to_me === true ||
          body.assign_to_me === "true"
        )
      ) {
        updates.assigned_user_id =
          adminUser.id;
      }

      updates.updated_at =
        new Date().toISOString();

      const {
        data,
        error,
      } = await supabase
        .from("crm_agents")
        .update(updates)
        .eq("id", agentId)
        .select()
        .maybeSingle();

      if (error) {
        console.error(
          "CRM agent update failed:",
          error
        );

        return res.status(500).json({
          ok: false,
          error:
            "Unable to update CRM agent",
        });
      }

      if (!data) {
        return res.status(404).json({
          ok: false,
          error: "CRM agent not found",
        });
      }

      return res.status(200).json({
        ok: true,
        agent: {
          ...data,
          full_name: fullName(data),
        },
      });
    } catch (error) {
      console.error(
        "Unexpected CRM PATCH error:",
        error
      );

      return res.status(500).json({
        ok: false,
        error: "Unexpected server error",
      });
    }
  }
};

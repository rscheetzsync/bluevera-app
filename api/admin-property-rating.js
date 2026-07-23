const SUPABASE_URL = String(
  process.env.SUPABASE_URL || ""
).replace(/\/+$/, "");

const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  "";

const ANON_KEY =
  process.env.SUPABASE_ANON_KEY || "";

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeAddress(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[.,#]/g, " ")
    .replace(/\bwest\b/g, "w")
    .replace(/\beast\b/g, "e")
    .replace(/\bnorth\b/g, "n")
    .replace(/\bsouth\b/g, "s")
    .replace(/\bavenue\b/g, "ave")
    .replace(/\bstreet\b/g, "st")
    .replace(/\bdrive\b/g, "dr")
    .replace(/\broad\b/g, "rd")
    .replace(/\bboulevard\b/g, "blvd")
    .replace(/\bplace\b/g, "pl")
    .replace(/\bcourt\b/g, "ct")
    .replace(/\bcircle\b/g, "cir")
    .replace(/\blane\b/g, "ln")
    .replace(/\bterrace\b/g, "ter")
    .replace(/\bparkway\b/g, "pkwy")
    .replace(
      /\b(arizona|az|phoenix|glendale|scottsdale|tempe|mesa|chandler|gilbert|paradise valley)\b/g,
      " "
    )
    .replace(/\b\d{5}(?:-\d{4})?\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function addressParts(value) {
  const normalized = normalizeAddress(value);

  const parts = normalized
    .split(" ")
    .filter(Boolean);

  const number =
    parts.find(part =>
      /^\d+[a-z]?$/.test(part)
    ) || "";

  const words =
    parts.filter(part =>
      !/^\d+[a-z]?$/.test(part)
    );

  return {
    normalized,
    number,
    words
  };
}

function addressesMatch(firstAddress, secondAddress) {
  const first =
    addressParts(firstAddress);

  const second =
    addressParts(secondAddress);

  if (
    !first.normalized ||
    !second.normalized
  ) {
    return false;
  }

  if (
    first.number &&
    second.number &&
    first.number !== second.number
  ) {
    return false;
  }

  if (
    first.normalized ===
    second.normalized
  ) {
    return true;
  }

  if (
    first.normalized.includes(
      second.normalized
    ) ||
    second.normalized.includes(
      first.normalized
    )
  ) {
    return true;
  }

  const sharedWords =
    first.words.filter(word =>
      word.length >= 3 &&
      second.words.includes(word)
    );

  return sharedWords.length >= 1;
}

function mergeUniqueRows(...groups) {
  const rows = new Map();

  groups.flat().forEach(row => {
    if (!row) {
      return;
    }

    const key =
      clean(row.id) ||
      [
        clean(row.property_id),
        clean(row.property_address),
        clean(row.created_at),
        clean(row.statement),
        clean(row.description),
        clean(row.note)
      ].join("|");

    if (!rows.has(key)) {
      rows.set(key, row);
    }
  });

  return Array.from(rows.values());
}

async function rest(path, options = {}) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      ...options,

      headers: {
        apikey: SERVICE_KEY,
        Authorization:
          `Bearer ${SERVICE_KEY}`,

        "Content-Type":
          "application/json",

        ...(options.headers || {})
      }
    }
  );

  const text =
    await response.text();

  let data = null;

  try {
    data = text
      ? JSON.parse(text)
      : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(
      data?.message ||
      data?.error ||
      data?.hint ||
      text ||
      `Supabase request failed (${response.status}).`
    );
  }

  return data;
}

async function optionalRest(
  path,
  options = {}
) {
  try {
    const data =
      await rest(path, options);

    return Array.isArray(data)
      ? data
      : [];
  } catch (error) {
    console.warn(
      "Optional property source unavailable:",
      path,
      error?.message
    );

    return [];
  }
}

function firstValue(
  row,
  keys,
  fallback = ""
) {
  for (const key of keys) {
    const value =
      row?.[key];

    if (
      value !== null &&
      value !== undefined &&
      clean(value) !== ""
    ) {
      return value;
    }
  }

  return fallback;
}

function normalizeEvidenceRow(
  row,
  defaults = {}
) {
  const statement =
    firstValue(
      row,
      [
        "statement",
        "description",
        "work_description",
        "update_description",
        "note",
        "notes",
        "details",
        "summary",
        "title",
        "document_name",
        "file_name"
      ],
      "Record available"
    );

  return {
    id:
      firstValue(
        row,
        ["id"],
        `${defaults.sourceType || "record"}-${Math.random()}`
      ),

    property_id:
      firstValue(
        row,
        ["property_id"],
        defaults.propertyId || null
      ),

    category:
      firstValue(
        row,
        [
          "category",
          "record_category",
          "update_type",
          "work_type",
          "document_type"
        ],
        defaults.category ||
        "Property Record"
      ),

    system_name:
      firstValue(
        row,
        [
          "system_name",
          "system",
          "home_system",
          "trade",
          "service_type",
          "update_type",
          "work_type"
        ],
        defaults.systemName || "—"
      ),

    event_year:
      firstValue(
        row,
        [
          "event_year",
          "year",
          "service_year",
          "work_year",
          "installed_year",
          "replacement_year"
        ],
        null
      ),

    event_date:
      firstValue(
        row,
        [
          "event_date",
          "service_date",
          "work_date",
          "completed_date",
          "completed_at",
          "inspection_date",
          "approximate_date"
        ],
        null
      ),

    statement:
      clean(statement),

    source_type:
      firstValue(
        row,
        ["source_type"],
        defaults.sourceType ||
        "property_record"
      ),

    source_name:
      firstValue(
        row,
        [
          "source_name",
          "business_name",
          "contractor_name",
          "homeowner_name",
          "company_name",
          "contractor",
          "email"
        ],
        defaults.sourceName || ""
      ),

    verification_status:
      firstValue(
        row,
        [
          "verification_status",
          "status",
          "record_status"
        ],
        defaults.verificationStatus ||
        "submitted"
      ),

    document_type:
      firstValue(
        row,
        [
          "document_type",
          "file_type"
        ],
        defaults.documentType || ""
      ),

    document_url:
      firstValue(
        row,
        [
          "document_url",
          "file_url",
          "report_url",
          "receipt_url",
          "invoice_url",
          "storage_url",
          "public_url"
        ],
        ""
      ),

    created_at:
      firstValue(
        row,
        [
          "created_at",
          "submitted_at"
        ],
        null
      ),

    updated_at:
      firstValue(
        row,
        [
          "updated_at",
          "modified_at",
          "created_at",
          "submitted_at"
        ],
        null
      ),

    original_table:
      defaults.originalTable || ""
  };
}

function sortEvidenceRows(rows) {
  return [...rows].sort(
    (first, second) => {
      const firstDate =
        Date.parse(
          first.updated_at ||
          first.created_at ||
          first.event_date ||
          ""
        ) || 0;

      const secondDate =
        Date.parse(
          second.updated_at ||
          second.created_at ||
          second.event_date ||
          ""
        ) || 0;

      return secondDate - firstDate;
    }
  );
}

async function verifyAdmin(req) {
  const token =
    clean(
      req.headers.authorization
    ).replace(
      /^Bearer\s+/i,
      ""
    );

  if (!token) {
    throw new Error(
      "Admin authentication token is missing."
    );
  }

  const response = await fetch(
    `${SUPABASE_URL}/auth/v1/user`,
    {
      headers: {
        apikey: ANON_KEY,
        Authorization:
          `Bearer ${token}`
      }
    }
  );

  const user =
    await response
      .json()
      .catch(() => null);

  if (
    !response.ok ||
    !user?.id
  ) {
    throw new Error(
      "The admin login session is invalid or expired."
    );
  }

  const admins = await rest(
    "admin_users?select=*",
    {
      method: "GET"
    }
  );

  const email =
    clean(user.email)
      .toLowerCase();

  const admin = (
    Array.isArray(admins)
      ? admins
      : []
  ).find(row => {
    const ids = [
      row.id,
      row.auth_user_id,
      row.user_id
    ].map(clean);

    const emails = [
      row.email,
      row.admin_email,
      row.username
    ].map(value =>
      clean(value).toLowerCase()
    );

    return (
      ids.includes(user.id) ||
      (
        email &&
        emails.includes(email)
      )
    );
  });

  if (!admin) {
    throw new Error(
      "This authenticated account is not authorized as a BlueVera admin."
    );
  }

  const status =
    clean(
      admin.status ||
      admin.account_status ||
      "active"
    ).toLowerCase();

  if (
    [
      "disabled",
      "inactive",
      "suspended",
      "denied"
    ].includes(status)
  ) {
    throw new Error(
      "This BlueVera admin account is not active."
    );
  }

  return {
    user,
    admin
  };
}

async function searchProperties(query) {
  const q = clean(query);

  if (!q) {
    return [];
  }

  const encoded =
    encodeURIComponent(
      `*${q}*`
    );

  const uuidLike =
    /^[0-9a-f-]{30,}$/i.test(q);

  let path;

  if (uuidLike) {
    path =
      "properties?or=(" +
      `id.eq.${encodeURIComponent(q)},` +
      `full_address.ilike.${encoded},` +
      `normalized_address.ilike.${encoded},` +
      `apn.ilike.${encoded}` +
      ")&select=*&limit=25";
  } else {
    path =
      "properties?or=(" +
      `full_address.ilike.${encoded},` +
      `address.ilike.${encoded},` +
      `street.ilike.${encoded},` +
      `normalized_address.ilike.${encoded},` +
      `apn.ilike.${encoded}` +
      ")&select=*&limit=25";
  }

  const rows = await rest(
    path,
    {
      method: "GET"
    }
  );

  return Array.isArray(rows)
    ? rows
    : [];
}

async function loadProperty(propertyId) {
  const rawPropertyId =
    clean(propertyId);

  const id =
    encodeURIComponent(
      rawPropertyId
    );

  const properties =
    await rest(
      `properties?id=eq.${id}&select=*&limit=1`,
      {
        method: "GET"
      }
    );

  const property =
    Array.isArray(properties)
      ? properties[0]
      : null;

  if (!property) {
    throw new Error(
      "The central property record was not found."
    );
  }

  const propertyAddress =
    clean(
      property.full_address ||
      property.address ||
      property.street
    );

  const [
    reportEntries,
    adjustments,
    homeownerById,
    contractorById,
    allHomeownerUpdates,
    allContractorWork,
    contractorDocuments,
    propertyDocuments,
    sellerDocuments,
    propertyHistoryItems
  ] = await Promise.all([
    optionalRest(
      `property_report_entries?property_id=eq.${id}&select=*`,
      {
        method: "GET"
      }
    ),

    rest(
      `property_rating_adjustments?property_id=eq.${id}&select=*&order=created_at.desc`,
      {
        method: "GET"
      }
    ),

    optionalRest(
      `homeowner_updates?property_id=eq.${id}&select=*`,
      {
        method: "GET"
      }
    ),

    optionalRest(
      `contractor_work_submissions?property_id=eq.${id}&select=*,contractors(business_name,phone,email,license_number,insurance_status)`,
      {
        method: "GET"
      }
    ),

    optionalRest(
      "homeowner_updates?status=eq.active&select=*&order=created_at.desc",
      {
        method: "GET"
      }
    ),

    optionalRest(
      "contractor_work_submissions?select=*,contractors(business_name,phone,email,license_number,insurance_status)&order=created_at.desc",
      {
        method: "GET"
      }
    ),

    optionalRest(
      `contractor_documents?property_id=eq.${id}&select=*`,
      {
        method: "GET"
      }
    ),

    optionalRest(
      `property_documents?property_id=eq.${id}&select=*`,
      {
        method: "GET"
      }
    ),

    optionalRest(
      `seller_documents?property_id=eq.${id}&select=*`,
      {
        method: "GET"
      }
    ),

    optionalRest(
      `property_history_items?property_id=eq.${id}&select=*`,
      {
        method: "GET"
      }
    )
  ]);

  const homeownerByAddress =
    allHomeownerUpdates.filter(row =>
      addressesMatch(
        propertyAddress,
        row.property_address
      )
    );

  const contractorByAddress =
    allContractorWork.filter(row =>
      addressesMatch(
        propertyAddress,
        row.property_address
      )
    );

  const homeownerUpdates =
    mergeUniqueRows(
      homeownerById,
      homeownerByAddress
    );

  const contractorWork =
    mergeUniqueRows(
      contractorById,
      contractorByAddress
    );

  const entries = [
    ...reportEntries.map(row =>
      normalizeEvidenceRow(
        row,
        {
          propertyId: property.id,

          originalTable:
            "property_report_entries"
        }
      )
    ),

    ...homeownerUpdates.map(row =>
      normalizeEvidenceRow(
        {
          ...row,

          statement:
            row.note ||
            row.update_type ||
            "Homeowner update",

          system_name:
            row.update_type ||
            "Homeowner update",

          event_date:
            row.approximate_date ||
            row.created_at,

          source_name:
            row.contractor ||
            row.email ||
            "Homeowner",

          verification_status:
            row.record_status ||
            "homeowner_submitted"
        },
        {
          propertyId:
            property.id,

          category:
            "Homeowner Reported Update",

          sourceType:
            "homeowner_update",

          sourceName:
            "Homeowner",

          verificationStatus:
            "homeowner_submitted",

          originalTable:
            "homeowner_updates"
        }
      )
    ),

    ...contractorWork.map(row =>
      normalizeEvidenceRow(
        {
          ...row,

          statement:
            row.description ||
            row.work_type ||
            "Contractor work record",

          system_name:
            row.work_type ||
            "Contractor work",

          event_date:
            row.completed_date ||
            row.created_at,

          source_name:
            row.contractors
              ?.business_name ||
            row.contractor_name ||
            "Contractor",

          verification_status:
            row.status ||
            "contractor_submitted",

          document_type:
            row.permit_number
              ? "Permit reference"
              : ""
        },
        {
          propertyId:
            property.id,

          category:
            "Contractor Work Record",

          sourceType:
            "contractor_record",

          sourceName:
            "Contractor",

          verificationStatus:
            "contractor_submitted",

          originalTable:
            "contractor_work_submissions"
        }
      )
    ),

    ...contractorDocuments.map(row =>
      normalizeEvidenceRow(
        row,
        {
          propertyId:
            property.id,

          category:
            "Contractor Document",

          sourceType:
            "contractor_document",

          sourceName:
            "Contractor",

          verificationStatus:
            "document_uploaded",

          originalTable:
            "contractor_documents"
        }
      )
    ),

    ...propertyDocuments.map(row =>
      normalizeEvidenceRow(
        row,
        {
          propertyId:
            property.id,

          category:
            "Property Document",

          sourceType:
            "property_document",

          sourceName:
            "BlueVera Document",

          verificationStatus:
            "document_uploaded",

          originalTable:
            "property_documents"
        }
      )
    ),

    ...sellerDocuments.map(row =>
      normalizeEvidenceRow(
        row,
        {
          propertyId:
            property.id,

          category:
            "Seller Document",

          sourceType:
            "seller_document",

          sourceName:
            "Seller",

          verificationStatus:
            "document_uploaded",

          originalTable:
            "seller_documents"
        }
      )
    ),

    ...propertyHistoryItems.map(row =>
      normalizeEvidenceRow(
        row,
        {
          propertyId:
            property.id,

          category:
            "Property History Item",

          sourceType:
            "property_history",

          sourceName:
            "BlueVera",

          verificationStatus:
            "recorded",

          originalTable:
            "property_history_items"
        }
      )
    )
  ];

  const adjustmentRows =
    Array.isArray(adjustments)
      ? adjustments
      : [];

  const adjustmentTotal =
    adjustmentRows.reduce(
      (total, row) =>
        total +
        Number(
          row.adjustment_points ||
          0
        ),
      0
    );

  return {
    property,

    entries:
      sortEvidenceRows(entries),

    adjustments:
      adjustmentRows,

    adjustmentTotal,

    evidenceCounts: {
      listingAndReportEntries:
        reportEntries.length,

      homeownerUpdates:
        homeownerUpdates.length,

      homeownerByPropertyId:
        homeownerById.length,

      homeownerByAddress:
        homeownerByAddress.length,

      contractorWork:
        contractorWork.length,

      contractorByPropertyId:
        contractorById.length,

      contractorByAddress:
        contractorByAddress.length,

      contractorDocuments:
        contractorDocuments.length,

      propertyDocuments:
        propertyDocuments.length,

      sellerDocuments:
        sellerDocuments.length,

      propertyHistoryItems:
        propertyHistoryItems.length
    }
  };
}

async function callCentralRecalculation(
  req,
  propertyId
) {
  const origin =
    new URL(
      req.url,
      `https://${req.headers.host}`
    ).origin;

  const response = await fetch(
    `${origin}/api/recalculate-property-rating`,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",

        Authorization:
          req.headers.authorization
      },

      body: JSON.stringify({
        propertyId
      })
    }
  );

  const result =
    await response
      .json()
      .catch(() => ({}));

  if (
    !response.ok ||
    !result.success
  ) {
    throw new Error(
      result.error ||
      "The central property rating could not be recalculated."
    );
  }

  return result;
}

async function saveAdjustment(
  propertyId,
  points,
  reason,
  adminContext
) {
  const value =
    Number(points);

  if (
    !Number.isInteger(value) ||
    value < -25 ||
    value > 25
  ) {
    throw new Error(
      "Adjustment must be a whole number from -25 to 25."
    );
  }

  if (
    clean(reason).length < 12
  ) {
    throw new Error(
      "A specific adjustment reason is required."
    );
  }

  const payload = {
    property_id:
      clean(propertyId),

    adjustment_points:
      value,

    reason:
      clean(reason),

    created_by:
      adminContext.user.id,

    admin_email:
      adminContext.user.email ||
      null,

    created_at:
      new Date().toISOString()
  };

  const rows = await rest(
    "property_rating_adjustments",
    {
      method: "POST",

      headers: {
        Prefer:
          "return=representation"
      },

      body:
        JSON.stringify(payload)
    }
  );

  return Array.isArray(rows)
    ? rows[0]
    : rows;
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

  if (
    !SUPABASE_URL ||
    !SERVICE_KEY ||
    !ANON_KEY
  ) {
    return res.status(500).json({
      success: false,

      error:
        "Supabase server environment variables are not configured."
    });
  }

  try {
    const adminContext =
      await verifyAdmin(req);

    if (req.method === "GET") {
      const action =
        clean(req.query.action);

      if (action === "search") {
        const properties =
          await searchProperties(
            req.query.q
          );

        return res.status(200).json({
          success: true,
          properties
        });
      }

      if (action === "load") {
        const propertyId =
          clean(req.query.id);

        if (!propertyId) {
          return res.status(400).json({
            success: false,

            error:
              "A property ID is required."
          });
        }

        /*
          Always refresh the central rating before returning a property to
          the manager. The manual button remains available as a backup, but
          an admin should never have to click it just to see the current
          evidence-based score.
        */
        await callCentralRecalculation(
          req,
          propertyId
        );

        const result =
          await loadProperty(
            propertyId
          );

        return res.status(200).json({
          success: true,
          ...result
        });
      }

      return res.status(400).json({
        success: false,

        error:
          "Unknown admin property action."
      });
    }

    if (req.method === "POST") {
      const body =
        typeof req.body === "string"
          ? JSON.parse(req.body)
          : req.body || {};

      const action =
        clean(body.action);

      const propertyId =
        clean(
          body.propertyId ||
          body.property_id
        );

      if (!propertyId) {
        return res.status(400).json({
          success: false,

          error:
            "A property ID is required."
        });
      }

      if (action === "recalculate") {
        const rating =
          await callCentralRecalculation(
            req,
            propertyId
          );

        return res.status(200).json({
          success: true,
          ...rating
        });
      }

      if (action === "adjust") {
        const adjustment =
          await saveAdjustment(
            propertyId,
            body.adjustmentPoints,
            body.reason,
            adminContext
          );

        return res.status(200).json({
          success: true,
          adjustment
        });
      }

      return res.status(400).json({
        success: false,

        error:
          "Unknown admin property action."
      });
    }

    return res.status(405).json({
      success: false,

      error:
        "Method not allowed."
    });
  } catch (error) {
    const message =
      error?.message ||
      "The admin property request failed.";

    const status =
      /authentication|session|authorized|admin account/i
        .test(message)
        ? 401
        : 500;

    return res.status(status).json({
      success: false,
      error: message
    });
  }
}


 // BlueVera ARMLS sold history
// Five-year, read-only admin diagnostic.
// Deploy to: api/armls-sold-history-test.js
// Browser must send Authorization: Bearer <Supabase access token>.
// NEVER expose Supabase service-role or Spark credentials in browser code.

const BASE = 'https://replication.sparkapi.com/v1';
const START_DATE = '2021-10-15';
const END_DATE = '2026-10-15';

const CATEGORIES = {
  flooring: ['Floor Yr Updated', 'Floor Partial/Full'],
  electrical: ['Wiring Yr Updated', 'Wiring Partial/Full'],
  plumbing: ['Plmbg Yr Updated', 'Plmbg Partial/Full'],
  hvac: ['Ht/Cool Yr Updated', 'Ht/Cool Partial/Full'],
  roof: ['Roof Yr Updated', 'Roof Partial/Full'],
  kitchen: ['Kitchen Yr Updated', 'Kitchen Partial/Full'],
  bathrooms: ['Bath(s) Yr Updated', 'Bath(s) Partial/Full'],
  room_additions: ['Rm Adtn Yr Updated', 'Rm Adtn Partial/Full'],
  pool: ['Pool Yr Updated', 'Pool Partial/Full']
};

const normalizeEmail = v =>
  String(v ?? '').trim().toLowerCase();

const stringOrNull = v =>
  v == null || String(v).trim() === ''
    ? null
    : String(v).trim();

function numberOrNull(v) {
  return v == null ||
    v === '' ||
    !Number.isFinite(Number(v))
      ? null
      : Number(v);
}

function yearOrNull(v) {
  const n = numberOrNull(v);

  return Number.isInteger(n) &&
    n >= 1800 &&
    n <= 2027
      ? n
      : null;
}

function dateOrNull(v) {
  const s = stringOrNull(v);

  return s && /^\d{4}-\d{2}-\d{2}/.test(s)
    ? s.slice(0, 10)
    : null;
}

function deepFind(obj, key) {
  if (!obj || typeof obj !== 'object') return null;

  if (Object.prototype.hasOwnProperty.call(obj, key)) {
    return obj[key];
  }

  for (const value of Object.values(obj)) {
    const hit = deepFind(value, key);

    if (hit != null) return hit;
  }

  return null;
}

function address(f) {
  return stringOrNull(f.UnparsedAddress) ||
    stringOrNull([
      f.StreetNumber,
      f.StreetDirPrefix,
      f.StreetName,
      f.StreetSuffix
    ].filter(Boolean).join(' '));
}

function normalize(record) {
  const f = record.StandardFields || record;

  const custom =
    record.CustomFields ||
    f.CustomFields ||
    {};

  const updates = {};

  for (const [name, [yearLabel, scopeLabel]]
    of Object.entries(CATEGORIES)) {

    const year = yearOrNull(
      deepFind(custom, yearLabel)
    );

    const scope = stringOrNull(
      deepFind(custom, scopeLabel)
    );

    if (year != null || scope != null) {
      updates[name] = { year, scope };
    }
  }

  return {
    mls: stringOrNull(f.ListingId || f.MlsId),

    listingKey:
      stringOrNull(f.ListingKey || record.Id),

    address: address(f),

    city: stringOrNull(f.City),

    state: stringOrNull(f.StateOrProvince),

    zip: stringOrNull(f.PostalCode),

    parcel:
      stringOrNull(f.ParcelNumber || f.TaxParcelId),

    propertyType: stringOrNull(f.PropertyType),

    yearBuilt: yearOrNull(f.YearBuilt),

    sqft: numberOrNull(
      f.LivingArea || f.BuildingAreaTotal
    ),

    status: stringOrNull(
      f.StandardStatus || f.MlsStatus
    ),

    closeDate: dateOrNull(f.CloseDate),

    closePrice: numberOrNull(f.ClosePrice),

    remarks: stringOrNull(f.PublicRemarks),

    updates,

    updateCount: Object.keys(updates).length
  };
}

// Verify existing BlueVera administrator login.

async function requireAdmin(req) {
  const bearer = /^Bearer\s+(.+)$/i.exec(
    String(req.headers.authorization || '')
  );

  if (!bearer) {
    return {
      status: 401,
      error:
        'Missing Supabase admin access token. Please sign in again.'
    };
  }

  const base = String(
    process.env.SUPABASE_URL || ''
  ).replace(/\/$/, '');

  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!base || !serviceKey) {
    return {
      status: 503,
      error:
        'Supabase admin verification environment variables are missing.'
    };
  }

  const identity = await fetch(
    `${base}/auth/v1/user`,
    {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${bearer[1]}`
      },

      signal: AbortSignal.timeout(10000)
    }
  );

  if (!identity.ok) {
    return {
      status: 401,
      error:
        'Supabase admin session is invalid or expired. Please log in again.'
    };
  }

  const user = await identity.json();

  if (!user?.id || !normalizeEmail(user.email)) {
    return {
      status: 401,
      error:
        'Supabase did not return a valid user identity.'
    };
  }

  const query = new URLSearchParams({
    select: 'email,role,is_active',
    is_active: 'eq.true',
    limit: '100'
  });

  const response = await fetch(
    `${base}/rest/v1/admin_users?${query}`,
    {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`
      },

      signal: AbortSignal.timeout(10000)
    }
  );

  if (!response.ok) {
    return {
      status: 503,
      error:
        `Supabase admin_users lookup failed (HTTP ${response.status}). Verify SUPABASE_URL and service-role key.`
    };
  }

  const admins = await response.json();

  if (!Array.isArray(admins)) {
    return {
      status: 503,
      error:
        'Unexpected response from admin_users lookup.'
    };
  }

  const approved = admins.some(a =>
    a.is_active === true &&
    normalizeEmail(a.email) ===
      normalizeEmail(user.email) &&
    ['admin', 'super_admin'].includes(
      String(a.role || '').trim().toLowerCase()
    )
  );

  if (!approved) {
    return {
      status: 403,
      error:
        'Signed-in Supabase user is not matched to an active admin_users account. Verify you logged into the same Supabase project configured for bluevera-app.'
    };
  }

  return { ok: true };
}

// Retrieve listings and pagination information
// from Spark ARMLS.

async function fetchSpark(
  params,
  includePagination = false
) {
  const token =
    process.env.SPARK_ACCESS_TOKEN;

  if (!token) {
    throw new Error(
      'SPARK_ACCESS_TOKEN is missing in Vercel.'
    );
  }

  const response = await fetch(
    `${BASE}/listings?${params}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      },

      signal: AbortSignal.timeout(24000)
    }
  );

  const json = await response.json()
    .catch(() => null);

  if (!json) {
    throw new Error(
      `Spark returned invalid JSON (HTTP ${response.status}).`
    );
  }

  if (
    !response.ok ||
    json?.D?.Success === false
  ) {
    throw new Error(
      json?.D?.Message ||
      json?.message ||
      `Spark query rejected (HTTP ${response.status}).`
    );
  }

  const results =
    Array.isArray(json?.D?.Results)
      ? json.D.Results
      : [];

  if (includePagination) {
    return {
      results,
      pagination: json?.D?.Pagination || null
    };
  }

  return results;
}

// Main API handler.

export default async function handler(req, res) {
  res.setHeader(
    'Cache-Control',
    'private, no-store'
  );

  res.setHeader(
    'Content-Type',
    'application/json; charset=utf-8'
  );

  // Read-only API. No Supabase writes.

  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      error: 'Read-only: GET only.'
    });
  }

  try {
    const admin = await requireAdmin(req);

    if (!admin.ok) {
      return res.status(admin.status).json({
        success: false,
        error: admin.error
      });
    }

  } catch (err) {
    console.error(
      'Sold history admin authorization failed:',
      err?.message
    );

    return res.status(503).json({
      success: false,
      error:
        'Admin verification request failed. Check Vercel function logs.'
    });
  }

  try {
    const mls = String(
      req.query?.mls || ''
    ).trim();

    // Single closed MLS listing lookup.

    if (mls) {
      if (!/^\d{5,12}$/.test(mls)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid MLS number.'
        });
      }

      const params = new URLSearchParams({
        _filter: `ListingId Eq '${mls}'`,
        _limit: '1',
        _expand: 'CustomFields'
      });

      const result = (
        await fetchSpark(params)
      )[0];

      if (!result) {
        return res.status(404).json({
          success: false,
          error:
            `MLS ${mls} not returned by Spark.`
        });
      }

      const row = normalize(result);

      const isClosed =
        String(row.status || '').toLowerCase() ===
        'closed';

      return res.status(200).json({
        success: true,

        mode: 'SOLD_SINGLE_READ_ONLY',

        mls,

        isClosed,

        status: row.status,

        saved: false,

        row: isClosed ? row : null
      });
    }

    // Five-year sold-property ZIP search.

    const zip = String(
      req.query?.zip || ''
    ).trim();

    const limit = Number(
      req.query?.limit ?? 25
    );

    const page = Number(
      req.query?.page ?? 1
    );

    if (!/^\d{5}$/.test(zip)) {
      return res.status(400).json({
        success: false,
        error:
          'Enter a five-digit ZIP code.'
      });
    }

    if (
      ![25, 50, 100].includes(limit) ||
      !Number.isInteger(page) ||
      page < 1 ||
      page > 1000
    ) {
      return res.status(400).json({
        success: false,
        error:
          'Invalid batch size or page.'
      });
    }

    const filter =
      `StandardStatus Eq 'Closed' ` +
      `And PostalCode Eq '${zip}' ` +
      `And CloseDate Ge ${START_DATE} ` +
      `And CloseDate Le ${END_DATE}`;

    const params = new URLSearchParams({
      _filter: filter,
      _limit: String(limit),
      _page: String(page),
      _expand: 'CustomFields',
      _pagination: '1'
    });

    const spark = await fetchSpark(
      params,
      true
    );

    const rows = spark.results.map(normalize);

    // Total matching sold MLS listings
    // reported by Spark pagination.

    const rawTotal =
      spark.pagination?.TotalRows;

    const totalSold =
      Number.isSafeInteger(Number(rawTotal)) &&
      rawTotal != null
        ? Number(rawTotal)
        : null;

    const totalPages =
      Number.isSafeInteger(
        Number(spark.pagination?.TotalPages)
      )
        ? Number(spark.pagination.TotalPages)
        : null;

    return res.status(200).json({
      success: true,

      mode: 'SOLD_ZIP_HISTORY_READ_ONLY',

      zip,

      page,

      limit,

      from: START_DATE,

      to: END_DATE,

      fetched: rows.length,

      matchedUpdates:
        rows.filter(
          row => row.updateCount > 0
        ).length,

      categoryCounts:
        Object.fromEntries(
          Object.keys(CATEGORIES).map(k => [
            k,
            rows.filter(
              row => row.updates[k]
            ).length
          ])
        ),

      totalSold,

      totalPages,

      hasNextPage:
        totalPages !== null
          ? page < totalPages
          : rows.length === limit,

      rows
    });

  } catch (err) {
    console.error(
      'Sold history Spark lookup failed:',
      err?.message
    );

    return res.status(502).json({
      success: false,
      error:
        err?.message ||
        'Spark lookup failed.'
    });
  }
}

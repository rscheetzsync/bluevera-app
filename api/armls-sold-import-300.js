
 // Deploy as api/armls-sold-import-300.js
// Controlled ZIP 85003 import: pages 1-3, 100 records/page.
// Each request fetches exactly one Spark page and upserts it into Supabase.
// Requires signed-in BlueVera administrator bearer token.
// No raw MLS payloads, listing remarks or agent fields are persisted.

const SB = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SPARK = process.env.SPARK_ACCESS_TOKEN;
const ZIP = '85003';
const FROM = '2021-10-15';
const TO = '2026-10-15';

const FIELDS = {
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

const normalizeEmail = x => String(x || '').trim().toLowerCase();

const textOrNull = x =>
  x == null || String(x).trim() === ''
    ? null
    : String(x).trim();

const num = x =>
  x == null ||
  String(x).trim() === '' ||
  !Number.isFinite(Number(x))
    ? null
    : Number(x);

const year = x => {
  const n = num(x);
  return Number.isInteger(n) && n >= 1800 && n <= 2027
    ? n
    : null;
};

function deepFind(obj, key) {
  if (!obj || typeof obj !== 'object') return null;

  if (Object.prototype.hasOwnProperty.call(obj, key)) {
    return obj[key];
  }

  for (const v of Object.values(obj)) {
    const x = deepFind(v, key);
    if (x != null) return x;
  }

  return null;
}

function encodeResponse(res, status, payload) {
  return res.status(status).json(payload);
}

async function authenticatedAdmin(req) {
  const bearer = /^Bearer\s+(.+)$/i.exec(
    String(req.headers.authorization || '')
  );

  if (!bearer) {
    throw Object.assign(
      new Error('Sign in to the BlueVera admin dashboard.'),
      { status: 401 }
    );
  }

  if (!SB || !KEY) {
    throw Object.assign(
      new Error('Supabase server environment is missing.'),
      { status: 503 }
    );
  }

  const identity = await fetch(`${SB}/auth/v1/user`, {
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${bearer[1]}`
    },
    signal: AbortSignal.timeout(10000)
  });

  if (!identity.ok) {
    throw Object.assign(
      new Error('Admin session expired. Sign in again.'),
      { status: 401 }
    );
  }

  const user = await identity.json();

  if (!user?.id || !normalizeEmail(user.email)) {
    throw Object.assign(
      new Error('Invalid user identity.'),
      { status: 401 }
    );
  }

  const adminsRes = await fetch(
    `${SB}/rest/v1/admin_users?select=email,role,is_active&is_active=eq.true&limit=100`,
    {
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`
      },
      signal: AbortSignal.timeout(10000)
    }
  );

  if (!adminsRes.ok) {
    throw new Error(
      `Admin lookup failed: ${adminsRes.status}`
    );
  }

  const admins = await adminsRes.json();

  const approved =
    Array.isArray(admins) &&
    admins.some(a =>
      a.is_active === true &&
      normalizeEmail(a.email) === normalizeEmail(user.email) &&
      ['admin', 'super_admin'].includes(
        String(a.role || '').toLowerCase()
      )
    );

  if (!approved) {
    throw Object.assign(
      new Error('Access denied: active administrator required.'),
      { status: 403 }
    );
  }
}

function mapRecord(record) {
  const f = record.StandardFields || record;
  const custom = record.CustomFields || f.CustomFields || {};

  const mls = textOrNull(f.ListingId || f.MlsId);
  if (!mls) return null;

  const addr =
    textOrNull(f.UnparsedAddress) ||
    textOrNull(
      [
        f.StreetNumber,
        f.StreetDirPrefix,
        f.StreetName,
        f.StreetSuffix
      ].filter(Boolean).join(' ')
    );

  const row = {
    listing_key: textOrNull(f.ListingKey || record.Id),
    mls_number: mls,
    property_address: addr,
    city: textOrNull(f.City),
    state: textOrNull(f.StateOrProvince),
    zip_code: textOrNull(f.PostalCode),
    parcel_number: textOrNull(
      f.ParcelNumber || f.TaxParcelId
    ),
    property_type: textOrNull(f.PropertyType),
    year_built: year(f.YearBuilt),
    living_area_sqft: num(
      f.LivingArea || f.BuildingAreaTotal
    ),
    sold_date:
      /^\d{4}-\d{2}-\d{2}/.test(String(f.CloseDate || ''))
        ? String(f.CloseDate).slice(0, 10)
        : null,
    sold_price: num(f.ClosePrice),
    listing_status: textOrNull(
      f.StandardStatus || f.MlsStatus
    ),
    updated_at: new Date().toISOString()
  };

  for (const [field, [yearLabel, scopeLabel]] of Object.entries(FIELDS)) {
    row[field] = textOrNull(
      deepFind(custom, scopeLabel)
    );

    row[`${field}_year`] = year(
      deepFind(custom, yearLabel)
    );
  }

  return row;
}

async function sparkPage(page) {
  if (!SPARK) {
    throw new Error('SPARK_ACCESS_TOKEN is missing.');
  }

  const filter =
    `StandardStatus Eq 'Closed' ` +
    `And PostalCode Eq '${ZIP}' ` +
    `And CloseDate Ge ${FROM} ` +
    `And CloseDate Le ${TO}`;

  const params = new URLSearchParams({
    _filter: filter,
    _limit: '100',
    _page: String(page),
    _expand: 'CustomFields',
    _pagination: '1'
  });

  const reply = await fetch(
    `https://replication.sparkapi.com/v1/listings?${params}`,
    {
      headers: {
        Authorization: `Bearer ${SPARK}`,
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(26000)
    }
  );

  const json = await reply.json().catch(() => null);

  if (
    !reply.ok ||
    json?.D?.Success === false ||
    !Array.isArray(json?.D?.Results)
  ) {
    throw new Error(
      `Spark lookup failed (${reply.status}): ` +
      `${json?.D?.Message || json?.message || 'Invalid response'}`
    );
  }

  return {
    results: json.D.Results,
    total: num(json.D.Pagination?.TotalRows)
  };
}

async function supabaseUpsert(rows) {
  const response = await fetch(
    `${SB}/rest/v1/armls_sold_properties?on_conflict=mls_number`,
    {
      method: 'POST',
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation'
      },
      body: JSON.stringify(rows),
      signal: AbortSignal.timeout(25000)
    }
  );

  const data = await response.json().catch(() => null);

  if (!response.ok || !Array.isArray(data)) {
    throw new Error(
      `Supabase upsert failed (${response.status}): ` +
      `${JSON.stringify(data)?.slice(0, 600) || 'No response'}`
    );
  }

  return data;
}

async function countSaved(numbers) {
  let present = 0;

  for (let i = 0; i < numbers.length; i += 50) {
    const clause = numbers
      .slice(i, i + 50)
      .map(x =>
        `"${String(x).replace(/["\\]/g, '')}"`
      )
      .join(',');

    const params = new URLSearchParams({
      select: 'mls_number',
      mls_number: `in.(${clause})`,
      limit: '50'
    });

    const response = await fetch(
      `${SB}/rest/v1/armls_sold_properties?${params}`,
      {
        headers: {
          apikey: KEY,
          Authorization: `Bearer ${KEY}`
        },
        signal: AbortSignal.timeout(12000)
      }
    );

    if (!response.ok) {
      throw new Error(
        `Saved-record verification failed (${response.status})`
      );
    }

    const rows = await response.json();
    present += rows.length;
  }

  return present;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');

  if (req.method !== 'POST') {
    return encodeResponse(res, 405, {
      success: false,
      error: 'POST only.'
    });
  }

  try {
    await authenticatedAdmin(req);

    const page = Number(req.body?.page);

    if (![1, 2, 3].includes(page)) {
      return encodeResponse(res, 400, {
        success: false,
        error: 'Allowed pages are 1, 2 and 3 only.'
      });
    }

    const fetched = await sparkPage(page);

    if (fetched.results.length !== 100) {
      throw new Error(
        `Page ${page} returned ${fetched.results.length}, ` +
        `expected 100; no records saved.`
      );
    }

    const mapped = fetched.results.map(mapRecord);

    if (
      mapped.some(x =>
        !x ||
        x.zip_code !== ZIP ||
        String(x.listing_status || '').toLowerCase() !== 'closed' ||
        !x.sold_date ||
        x.sold_date < FROM ||
        x.sold_date > TO
      )
    ) {
      throw new Error(
        'Spark page contained an incomplete or ' +
        'out-of-scope listing; no records saved.'
      );
    }

    const keys = mapped.map(x => x.mls_number);

    if (new Set(keys).size !== 100) {
      throw new Error(
        'Duplicate MLS numbers in Spark page; no records saved.'
      );
    }

    const written = await supabaseUpsert(mapped);
    const verified = await countSaved(keys);

    if (verified !== 100) {
      throw new Error(
        `Database verification found ${verified} of 100 ` +
        `MLS numbers. Review before retrying.`
      );
    }

    return encodeResponse(res, 200, {
      success: true,
      zip: ZIP,
      page,
      fetched: fetched.results.length,
      upserted: written.length,
      verified,
      sparkReportedTotal: fetched.total,
      listingsWithImprovements:
        mapped.filter(row =>
          Object.keys(FIELDS).some(
            k => row[k] || row[`${k}_year`]
          )
        ).length,
      note:
        'Batch stored in Supabase; rerunning this page ' +
        'updates matching MLS numbers.'
    });

  } catch (err) {
    console.error('ARMLS sold import failed:', err);

    return encodeResponse(
      res,
      err.status || 500,
      {
        success: false,
        error: err.message || 'Import failed.'
      }
    );
  }
}

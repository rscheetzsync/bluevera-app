// BlueVera ARMLS sold history
// GET = read-only
// POST ?mls= = save one closed listing
// Deploy as api/armls-sold-history-test.js

const BASE = 'https://replication.sparkapi.com/v1';

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

function deep(obj, key) {
  if (!obj || typeof obj !== 'object') return null;

  if (Object.prototype.hasOwnProperty.call(obj, key)) {
    return obj[key];
  }

  for (const value of Object.values(obj)) {
    const found = deep(value, key);

    if (found !== null && found !== undefined) {
      return found;
    }
  }

  return null;
}

function text(v) {
  return v == null || String(v).trim() === ''
    ? null
    : String(v).trim();
}

function number(v) {
  return v == null ||
    v === '' ||
    !Number.isFinite(Number(v))
      ? null
      : Number(v);
}

function year(v) {
  const n = number(v);

  return Number.isInteger(n) &&
    n >= 1800 &&
    n <= 2027
      ? n
      : null;
}

function date(v) {
  const s = text(v);

  return s && /^\d{4}-\d{2}-\d{2}/.test(s)
    ? s.slice(0, 10)
    : null;
}

function address(f) {
  return text(f.UnparsedAddress) || text([
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

  for (const [category, [yearLabel, scopeLabel]]
    of Object.entries(CATEGORIES)) {

    const y = year(deep(custom, yearLabel));

    const scope = text(deep(custom, scopeLabel));

    if (y !== null || scope !== null) {
      updates[category] = {
        year: y,
        scope
      };
    }
  }

  return {
    mls: text(f.ListingId || f.MlsId),

    listingKey: text(f.ListingKey || record.Id),

    address: address(f),

    city: text(f.City),

    state: text(f.StateOrProvince),

    zip: text(f.PostalCode),

    parcel: text(f.ParcelNumber || f.TaxParcelId),

    propertyType: text(f.PropertyType),

    yearBuilt: year(f.YearBuilt),

    sqft: number(
      f.LivingArea || f.BuildingAreaTotal
    ),

    status: text(
      f.StandardStatus || f.MlsStatus
    ),

    closeDate: date(f.CloseDate),

    closePrice: number(f.ClosePrice),

    remarks: text(f.PublicRemarks),

    updates,

    updateCount: Object.keys(updates).length
  };
}

async function fetchSpark(params, token) {
  const upstream = await fetch(
    `${BASE}/listings?${params}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      },

      signal: AbortSignal.timeout(24000)
    }
  );

  const data = await upstream.json()
    .catch(() => null);

  if (!data) {
    throw new Error(
      `Spark returned invalid JSON (HTTP ${upstream.status}).`
    );
  }

  if (
    !upstream.ok ||
    data?.D?.Success === false
  ) {
    throw new Error(
      data?.D?.Message ||
      data?.message ||
      `Spark rejected query (HTTP ${upstream.status}).`
    );
  }

  return Array.isArray(data?.D?.Results)
    ? data.D.Results
    : [];
}

function dbRecord(row, original) {
  const payload = {
    mls_number: row.mls,

    listing_key: row.listingKey,

    property_address: row.address,

    city: row.city,

    state: row.state,

    zip_code: row.zip,

    parcel_number: row.parcel,

    property_type: row.propertyType,

    year_built: row.yearBuilt,

    living_area_sqft: row.sqft,

    sold_date: row.closeDate,

    sold_price: row.closePrice,

    listing_status: row.status,

    listing_remarks: row.remarks,

    updated_at: new Date().toISOString(),

    // Store original data only if ARMLS
    // licensing permits historical storage.
    raw_armls_data: original
  };

  for (const [category, data]
    of Object.entries(row.updates)) {

    payload[category] = data.scope;

    payload[`${category}_year`] = data.year;
  }

  return payload;
}

async function saveOne(row, original) {
  const url = process.env.SUPABASE_URL;

  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in Vercel.'
    );
  }

  const response = await fetch(
    `${url.replace(/\/$/, '')}/rest/v1/armls_sold_properties?on_conflict=mls_number`,
    {
      method: 'POST',

      headers: {
        apikey: key,

        Authorization: `Bearer ${key}`,

        'Content-Type': 'application/json',

        Prefer:
          'resolution=merge-duplicates,return=representation'
      },

      body: JSON.stringify(
        dbRecord(row, original)
      ),

      signal: AbortSignal.timeout(15000)
    }
  );

  const result = await response.json()
    .catch(() => null);

  if (!response.ok) {
    throw new Error(
      `Supabase save failed (${response.status}): ${
        result?.message ||
        result?.details ||
        'Unknown error'
      }`
    );
  }

  return Array.isArray(result) && result[0]
    ? result[0].id
    : null;
}

export default async function handler(req, res) {
  res.setHeader(
    'Cache-Control',
    'private, no-store'
  );

  res.setHeader(
    'Content-Type',
    'application/json; charset=utf-8'
  );

  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({
      success: false,
      error: 'GET or POST only.'
    });
  }

  const secret =
    process.env.BLUEVERA_SOLD_DIAGNOSTIC_KEY;

  if (!secret) {
    return res.status(503).json({
      success: false,
      error: 'Missing BLUEVERA_SOLD_DIAGNOSTIC_KEY.'
    });
  }

  if (
    req.headers['x-bluevera-diagnostic-key'] !== secret
  ) {
    return res.status(403).json({
      success: false,
      error: 'Invalid diagnostic key.'
    });
  }

  const token =
    process.env.SPARK_ACCESS_TOKEN;

  if (!token) {
    return res.status(503).json({
      success: false,
      error: 'Missing SPARK_ACCESS_TOKEN.'
    });
  }

  const mls =
    String(req.query.mls || '').trim();

  try {
    // ----------------------------------
    // SINGLE SOLD PROPERTY LOOKUP
    // ----------------------------------

    if (mls) {
      if (!/^\d{5,12}$/.test(mls)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid numeric MLS number.'
        });
      }

      const params = new URLSearchParams({
        _filter: `ListingId Eq '${mls}'`,
        _limit: '1',
        _expand: 'CustomFields'
      });

      const results = await fetchSpark(
        params,
        token
      );

      if (!results.length) {
        return res.status(404).json({
          success: false,
          error: `MLS ${mls} not returned by Spark.`
        });
      }

      const row = normalize(results[0]);

      const closed =
        row.status?.toLowerCase() === 'closed';

      if (!closed) {
        return res.status(200).json({
          success: true,
          isClosed: false,
          mls,
          status: row.status,
          row: null,
          saved: false
        });
      }

      if (req.method === 'POST') {
        if (!row.mls) {
          return res.status(422).json({
            success: false,
            error: 'MLS ID missing in Spark response.'
          });
        }

        const id = await saveOne(
          row,
          results[0]
        );

        return res.status(200).json({
          success: true,
          mode: 'SOLD_SINGLE_SAVED',
          isClosed: true,
          saved: true,
          id,
          row
        });
      }

      return res.status(200).json({
        success: true,
        mode: 'SOLD_SINGLE_READ_ONLY',
        isClosed: true,
        saved: false,
        row
      });
    }

    // ----------------------------------
    // ZIP CODE SOLD HISTORY LOOKUP
    // ----------------------------------

    if (req.method === 'POST') {
      return res.status(400).json({
        success: false,
        error:
          'POST requires a single MLS number. ZIP batches remain read-only.'
      });
    }

    const zip =
      String(req.query.zip || '').trim();

    const limit =
      Number(req.query.limit || 25);

    const page =
      Number(req.query.page || 1);

    if (!/^\d{5}$/.test(zip)) {
      return res.status(400).json({
        success: false,
        error: 'Enter a five-digit ZIP code.'
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
        error: 'Invalid batch size or page.'
      });
    }

    // Ten-year sold-listing filter
    const filter =
      `StandardStatus Eq 'Closed' ` +
      `And PostalCode Eq '${zip}' ` +
      `And CloseDate Ge 2016-10-14 ` +
      `And CloseDate Le 2026-10-14`;

    const params = new URLSearchParams({
      _filter: filter,
      _limit: String(limit),
      _page: String(page),
      _expand: 'CustomFields'
    });

    const records = await fetchSpark(
      params,
      token
    );

    const rows = records.map(normalize);

    const categoryCounts = Object.fromEntries(
      Object.keys(CATEGORIES).map(k => [
        k,
        rows.filter(r => r.updates[k]).length
      ])
    );

    return res.status(200).json({
      success: true,

      mode: 'SOLD_ZIP_HISTORY_READ_ONLY',

      zip,

      page,

      limit,

      from: '2016-10-14',

      to: '2026-10-14',

      fetched: rows.length,

      matchedUpdates:
        rows.filter(
          r => r.updateCount > 0
        ).length,

      categoryCounts,

      hasNextPage:
        rows.length === limit,

      rows
    });

  } catch (error) {
    return res.status(502).json({
      success: false,
      error:
        error?.message ||
        'Sold history request failed.'
    });
  }
}

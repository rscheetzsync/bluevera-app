
 // BlueVera ZIP-code sold-history diagnostic.
 // Read only; no Supabase writes.

const BASE = 'https://replication.sparkapi.com/v1';

const FIELDS = {
  floor: ['Floor Yr Updated', 'Floor Partial/Full'],
  wiring: ['Wiring Yr Updated', 'Wiring Partial/Full'],
  plumbing: ['Plmbg Yr Updated', 'Plmbg Partial/Full'],
  hvac: ['Ht/Cool Yr Updated', 'Ht/Cool Partial/Full'],
  roof: ['Roof Yr Updated', 'Roof Partial/Full'],
  kitchen: ['Kitchen Yr Updated', 'Kitchen Partial/Full'],
  baths: ['Bath(s) Yr Updated', 'Bath(s) Partial/Full'],
  roomAddition: ['Rm Adtn Yr Updated', 'Rm Adtn Partial/Full'],
  pool: ['Pool Yr Updated', 'Pool Partial/Full']
};

function deep(obj, key) {
  if (!obj || typeof obj !== 'object') return null;

  if (Object.prototype.hasOwnProperty.call(obj, key)) {
    return obj[key];
  }

  for (const value of Object.values(obj)) {
    const hit = deep(value, key);

    if (hit !== null && hit !== undefined) {
      return hit;
    }
  }

  return null;
}

function improvements(custom) {
  const result = {};

  for (const [category, [yearLabel, scopeLabel]]
    of Object.entries(FIELDS)) {

    const raw = deep(custom, yearLabel);
    const year = Number(raw);
    const scope = deep(custom, scopeLabel);

    if (
      raw !== null &&
      raw !== undefined &&
      String(raw).trim() !== '' &&
      Number.isInteger(year) &&
      year >= 1800 &&
      year <= 2027
    ) {
      result[category] = {
        year,
        scope: scope == null
          ? null
          : String(scope).trim() || null
      };
    }
  }

  return result;
}

function numeric(value) {
  return value == null ||
    value === '' ||
    !Number.isFinite(Number(value))
      ? null
      : Number(value);
}

function address(f) {
  return f.UnparsedAddress ||
    [
      f.StreetNumber,
      f.StreetDirPrefix,
      f.StreetName,
      f.StreetSuffix,
      f.City
    ].filter(Boolean).join(' ');
}

export default async function handler(req, res) {

  res.setHeader('Cache-Control', 'private, no-store');

  res.setHeader(
    'Content-Type',
    'application/json; charset=utf-8'
  );

  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      error: 'GET only'
    });
  }

  const secret =
    process.env.BLUEVERA_SOLD_DIAGNOSTIC_KEY;

  if (!secret) {
    return res.status(503).json({
      success: false,
      error:
        'Configure BLUEVERA_SOLD_DIAGNOSTIC_KEY in Vercel.'
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

  const token = process.env.SPARK_ACCESS_TOKEN;

  if (!token) {
    return res.status(503).json({
      success: false,
      error: 'SPARK_ACCESS_TOKEN is missing.'
    });
  }

  // ==================================================
  // SINGLE SOLD MLS PROPERTY TEST
  // ==================================================

  const mls = String(req.query.mls || '').trim();

  if (mls) {

    if (!/^\d{5,12}$/.test(mls)) {
      return res.status(400).json({
        success: false,
        error: 'Enter a valid numeric MLS number.'
      });
    }

    const singleFilter =
      `ListingId Eq '${mls}'`;

    const params = new URLSearchParams({
      _filter: singleFilter,
      _limit: '1',
      _expand: 'CustomFields'
    });

    try {

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
        return res.status(502).json({
          success: false,
          error: 'Spark returned invalid JSON.',
          sparkStatus: upstream.status
        });
      }

      if (
        !upstream.ok ||
        data?.D?.Success === false
      ) {
        return res.status(502).json({
          success: false,
          error:
            data?.D?.Message ||
            data?.message ||
            'Spark request rejected.',
          sparkStatus: upstream.status
        });
      }

      const record =
        Array.isArray(data?.D?.Results)
          ? data.D.Results[0]
          : null;

      if (!record) {
        return res.status(404).json({
          success: false,
          error:
            `MLS ${mls} was not returned by Spark.`
        });
      }

      const f = record.StandardFields || record;

      const status =
        f.StandardStatus ||
        f.MlsStatus ||
        null;

      if (String(status).toLowerCase() !== 'closed') {
        return res.status(200).json({
          success: true,
          mode: 'SOLD_SINGLE_READ_ONLY',
          isClosed: false,
          mls,
          status,
          message:
            'Listing found, but status is not Closed.',
          row: null
        });
      }

      const updates = improvements(
        record.CustomFields ||
        f.CustomFields ||
        {}
      );

      const row = {
        mls: f.ListingId || f.MlsId || mls,

        listingKey:
          f.ListingKey ||
          record.Id ||
          null,

        address: address(f),

        zip: f.PostalCode || null,

        status,

        closeDate: f.CloseDate || null,

        closePrice: numeric(f.ClosePrice),

        updates,

        updateCount:
          Object.keys(updates).length
      };

      return res.status(200).json({
        success: true,
        mode: 'SOLD_SINGLE_READ_ONLY',
        isClosed: true,
        mls,
        status,
        row
      });

    } catch (error) {

      return res.status(502).json({
        success: false,
        error:
          error?.message ||
          'Spark single MLS request failed.'
      });
    }
  }

  // ==================================================
  // SOLD LISTINGS BY ZIP CODE
  // ==================================================

  const zip = String(req.query.zip || '').trim();

  const limit = Number(req.query.limit || 25);

  const page = Number(req.query.page || 1);

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

  // Ten-year closed listing search.
  // ZIP query syntax requires live Spark verification.

  const filter =
    `StandardStatus Eq 'Closed' ` +
    `And PostalCode Eq '${zip}' ` +
    `And CloseDate Ge 2016-10-14 ` +
    `And CloseDate Le 2026-10-14`;

  const q = new URLSearchParams({
    _filter: filter,
    _limit: String(limit),
    _page: String(page),
    _expand: 'CustomFields'
  });

  try {

    const upstream = await fetch(
      `${BASE}/listings?${q}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(24000)
      }
    );

    const body = await upstream.text();

    let data;

    try {
      data = JSON.parse(body);
    } catch {
      return res.status(502).json({
        success: false,
        error: 'Spark returned non-JSON.',
        sparkStatus: upstream.status
      });
    }

    if (
      !upstream.ok ||
      data?.D?.Success === false
    ) {
      return res.status(502).json({
        success: false,
        error:
          data?.D?.Message ||
          data?.message ||
          'Spark query rejected.',
        sparkStatus: upstream.status
      });
    }

    const raw =
      Array.isArray(data?.D?.Results)
        ? data.D.Results
        : [];

    const rows = raw.map(record => {

      const f = record.StandardFields || record;

      const updates = improvements(
        record.CustomFields ||
        f.CustomFields ||
        {}
      );

      return {
        mls:
          f.ListingId ||
          f.MlsId ||
          null,

        listingKey:
          f.ListingKey ||
          record.Id ||
          null,

        address: address(f),

        zip: f.PostalCode || null,

        status:
          f.StandardStatus ||
          f.MlsStatus ||
          null,

        closeDate: f.CloseDate || null,

        closePrice: numeric(f.ClosePrice),

        updates,

        updateCount:
          Object.keys(updates).length
      };
    });

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
          x => x.updateCount > 0
        ).length,

      categoryCounts:
        Object.fromEntries(
          Object.keys(FIELDS).map(k => [
            k,
            rows.filter(
              x => x.updates[k]
            ).length
          ])
        ),

      hasNextPage: raw.length === limit,

      rows
    });

  } catch (error) {

    return res.status(502).json({
      success: false,
      error:
        error?.message ||
        'Spark request failed.'
    });
  }
}

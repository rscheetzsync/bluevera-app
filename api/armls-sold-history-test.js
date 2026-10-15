
 // BlueVera ARMLS closed-listing diagnostic.
 // READ ONLY. Protect with a separate diagnostic key.

export const config = { api: { bodyParser: false } };

const BASE = 'https://replication.sparkapi.com/v1';

const LABELS = {
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

function findDeep(obj, name) {
  if (!obj || typeof obj !== 'object') return null;

  if (Object.prototype.hasOwnProperty.call(obj, name)) {
    return obj[name];
  }

  for (const val of Object.values(obj)) {
    const result = findDeep(val, name);

    if (result !== null && result !== undefined) {
      return result;
    }
  }

  return null;
}

function readUpdates(custom) {
  const result = {};

  for (const [category, labels] of Object.entries(LABELS)) {
    const yearRaw = findDeep(custom, labels[0]);
    const year = Number(yearRaw);
    const scope = findDeep(custom, labels[1]);

    if (
      yearRaw != null &&
      String(yearRaw).trim() !== '' &&
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

function numberOrNull(v) {
  return v == null ||
    v === '' ||
    !Number.isFinite(Number(v))
      ? null
      : Number(v);
}

function fmtAddress(f) {
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
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      error: 'GET only'
    });
  }

  const secret = process.env.BLUEVERA_SOLD_DIAGNOSTIC_KEY;

  if (!secret) {
    return res.status(503).json({
      success: false,
      error: 'Set BLUEVERA_SOLD_DIAGNOSTIC_KEY in Vercel before using this private diagnostic.'
    });
  }

  if (req.headers['x-bluevera-diagnostic-key'] !== secret) {
    return res.status(403).json({
      success: false,
      error: 'Invalid diagnostic key'
    });
  }

  if (!process.env.SPARK_ACCESS_TOKEN) {
    return res.status(503).json({
      success: false,
      error: 'SPARK_ACCESS_TOKEN is missing'
    });
  }

  const rawLimit = Number(req.query.limit || 25);
  const rawPage = Number(req.query.page || 1);

  if (
    ![25, 50, 100].includes(rawLimit) ||
    !Number.isInteger(rawPage) ||
    rawPage < 1 ||
    rawPage > 1000
  ) {
    return res.status(400).json({
      success: false,
      error: 'Invalid page or batch size'
    });
  }

  // Approximate map extent.
  // Bounds are editable on the diagnostic page.

  const south = Number(req.query.south ?? 33.4680);
  const north = Number(req.query.north ?? 33.4810);
  const west = Number(req.query.west ?? -112.0830);
  const east = Number(req.query.east ?? -112.0460);

  if (
    ![south, north, west, east].every(Number.isFinite) ||
    south >= north ||
    west >= east ||
    north - south > .12 ||
    east - west > .12 ||
    south < 33.35 ||
    north > 33.65 ||
    west < -112.25 ||
    east > -111.85
  ) {
    return res.status(400).json({
      success: false,
      error: 'Invalid Phoenix area bounds.'
    });
  }

  const filter =
    `StandardStatus Eq 'Closed' ` +
    `And CloseDate Ge 2016-10-14 ` +
    `And CloseDate Le 2026-10-14 ` +
    `And Location Eq rectangle('${north} ${west},${south} ${east}')`;

  const query = new URLSearchParams({
    _filter: filter,
    _limit: String(rawLimit),
    _page: String(rawPage),
    _expand: 'CustomFields'
  });

  try {
    const response = await fetch(
      `${BASE}/listings?${query}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.SPARK_ACCESS_TOKEN}`,
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(24000)
      }
    );

    const text = await response.text();

    let payload;

    try {
      payload = JSON.parse(text);
    } catch {
      return res.status(502).json({
        success: false,
        error: 'Spark returned non-JSON',
        status: response.status
      });
    }

    if (!response.ok || payload?.D?.Success === false) {
      return res.status(502).json({
        success: false,
        error:
          payload?.D?.Message ||
          payload?.message ||
          'Spark query failed',
        sparkStatus: response.status
      });
    }

    const raw = Array.isArray(payload?.D?.Results)
      ? payload.D.Results
      : [];

    const rows = raw.map(rec => {
      const f = rec.StandardFields || rec;

      const updates = readUpdates(
        rec.CustomFields ||
        f.CustomFields ||
        {}
      );

      return {
        mls: f.ListingId || f.MlsId || null,
        listingKey: f.ListingKey || rec.Id || null,
        address: fmtAddress(f),
        city: f.City || null,
        status: f.StandardStatus || f.MlsStatus || null,
        closeDate: f.CloseDate || null,
        closePrice: numberOrNull(f.ClosePrice),
        latitude: numberOrNull(f.Latitude),
        longitude: numberOrNull(f.Longitude),
        updates,
        updateCount: Object.keys(updates).length
      };
    });

    const categories = Object.fromEntries(
      Object.keys(LABELS).map(k => [
        k,
        rows.filter(r => r.updates[k]).length
      ])
    );

    return res.status(200).json({
      success: true,
      mode: 'CLOSED_HISTORY_READ_ONLY',
      dates: {
        from: '2016-10-14',
        to: '2026-10-14'
      },
      bounds: {
        south,
        north,
        west,
        east
      },
      page: rawPage,
      limit: rawLimit,
      fetched: rows.length,
      matchedUpdates: rows.filter(
        r => r.updateCount
      ).length,
      categoryCounts: categories,
      hasNextPage: raw.length === rawLimit,
      rows
    });

  } catch (e) {
    return res.status(502).json({
      success: false,
      error: e?.message || 'Spark request failed'
    });
  }
}

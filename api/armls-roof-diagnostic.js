
/**
 * BlueVera — Read-only ARMLS Roof Diagnostic
 * Deploy as: bluevera.app/api/armls-roof-diagnostic.js
 *
 * Required Vercel environment variables:
 *   SPARK_ACCESS_TOKEN       (existing licensed ARMLS Spark token)
 *   ARMLS_DIAGNOSTIC_KEY     (NEW, random independent access key)
 *
 * Test (do not share the secret URL publicly):
 *   /api/armls-roof-diagnostic?mls=7103560&key=YOUR_DIAGNOSTIC_KEY
 *
 * This endpoint NEVER writes to Supabase, never logs credentials,
 * and never returns the full listing or private remarks.
 */
import crypto from 'node:crypto';

const SPARK_BASE = 'https://replication.sparkapi.com/v1';
const SAFE_MAX_DEPTH = 9;
const SAFE_MAX_NODES = 5000;

function constantTimeEqual(a, b) {
  if (!a || !b) return false;
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

function safeValue(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value.slice(0, 300);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(safeValue);

  // Some Spark enum fields are structured objects; keep only compact, safe values.
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 15)) {
      if (/^(value|values|name|label|description|displayvalue|id)$/i.test(key)) {
        out[key] = safeValue(item);
      }
    }
    return Object.keys(out).length ? out : '[structured value]';
  }
  return String(value).slice(0, 300);
}

function findRoofFields(source, sourceLabel) {
  const out = [];
  let visited = 0;
  const seen = new WeakSet();

  function visit(node, path, depth) {
    if (
      node == null ||
      typeof node !== 'object' ||
      depth > SAFE_MAX_DEPTH ||
      ++visited > SAFE_MAX_NODES
    ) return;

    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      node.slice(0, 100).forEach((item, i) =>
        visit(item, `${path}[${i}]`, depth + 1)
      );
      return;
    }

    for (const [name, value] of Object.entries(node)) {
      // Only roof-specific keys, not whole records or remarks.
      if (/roof|roofing|underlay|underlayment/i.test(name)) {
        out.push({
          field: name,
          path: `${path}.${name}`,
          value: safeValue(value),
          source: sourceLabel
        });
      }

      if (value !== null && typeof value === 'object') {
        visit(value, `${path}.${name}`, depth + 1);
      }
    }
  }

  visit(source, sourceLabel, 0);
  return out.slice(0, 100);
}

function firstMatching(fields, patterns) {
  const match = fields.find(item =>
    patterns.some(re => re.test(item.field)) &&
    item.value !== null &&
    item.value !== ''
  );

  return match
    ? { value: match.value, field: match.field, path: match.path }
    : null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      error: 'Method not allowed'
    });
  }

  const configuredKey = process.env.ARMLS_DIAGNOSTIC_KEY;

  if (!configuredKey) {
    return res.status(503).json({
      success: false,
      error: 'Diagnostic access is not configured'
    });
  }

  const suppliedKey = String(
    req.headers['x-bluevera-diagnostic-key'] ||
    req.query.key ||
    ''
  );

  if (!constantTimeEqual(suppliedKey, configuredKey)) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized'
    });
  }

  const mls = String(req.query.mls || '').trim();

  if (!/^\d{5,12}$/.test(mls)) {
    return res.status(400).json({
      success: false,
      error: 'Provide a numeric MLS number'
    });
  }

  const sparkToken = process.env.SPARK_ACCESS_TOKEN;

  if (!sparkToken) {
    return res.status(503).json({
      success: false,
      error: 'Spark connection is not configured'
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const url =
      `${SPARK_BASE}/listings?_filter=${
        encodeURIComponent(`ListingId Eq '${mls}'`)
      }&_limit=1&_expand=CustomFields`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${sparkToken}`,
        Accept: 'application/json'
      },
      signal: controller.signal
    });

    if (!response.ok) {
      return res.status(502).json({
        success: false,
        error: 'Spark listing request failed',
        sparkStatus: response.status
      });
    }

    const payload = await response.json();

    const listing = Array.isArray(payload?.D?.Results)
      ? payload.D.Results[0]
      : Array.isArray(payload?.Results)
        ? payload.Results[0]
        : null;

    if (!listing) {
      return res.status(404).json({
        success: false,
        mlsNumber: mls,
        error: 'Listing not found or not permitted by feed'
      });
    }

    const standard =
      listing.StandardFields ||
      listing.standardFields ||
      {};

    const custom =
      listing.CustomFields ||
      standard.CustomFields ||
      listing.customFields ||
      standard.customFields ||
      {};

    const standardRoofFields = findRoofFields(
      standard,
      'StandardFields'
    );

    const customRoofFields = findRoofFields(
      custom,
      'CustomFields'
    );

    const allFields = [
      ...standardRoofFields,
      ...customRoofFields
    ];

    return res.status(200).json({
      success: true,
      mode: 'READ_ONLY_ROOF_DIAGNOSTIC',
      mlsNumber: mls,

      property: {
        city: standard.City || null,
        state:
          standard.StateOrProvince ||
          standard.State ||
          null,
        zip: standard.PostalCode || null,
        yearBuiltFromMLS: standard.YearBuilt ?? null
      },

      roof: {
        material: firstMatching(allFields, [
          /^roofing$/i,
          /^roofmaterial$/i,
          /^roofingmaterial$/i,
          /^rooftype$/i,
          /^roofcovering/i
        ]),

        yearUpdated: firstMatching(allFields, [
          /roof\s*yr\s*updated/i,
          /roof.*year.*updated/i,
          /roof.*updated.*year/i,
          /^roof_year$/i
        ]),

        partialOrFull: firstMatching(allFields, [
          /roof\s*partial\s*\/\s*full/i,
          /roof.*partial.*full/i,
          /^roof_scope$/i
        ]),

        otherRoofFields: allFields
      },

      diagnostics: {
        standardRoofFieldCount: standardRoofFields.length,
        customRoofFieldCount: customRoofFields.length,
        hasStandardFields: Object.keys(standard).length > 0,
        hasCustomFields: Object.keys(custom).length > 0,
        note:
          'Fields are listing-reported. A field on the ARMLS input form is not necessarily populated in a specific listing or available in this licensed response.'
      },

      writesToDatabase: false
    });

  } catch (error) {
    return res.status(502).json({
      success: false,
      error: error.name === 'AbortError'
        ? 'Spark request timed out'
        : 'Unable to complete Spark diagnostic'
    });

  } finally {
    clearTimeout(timeout);
  }
}


/**
 * BlueVera — ARMLS Roof Diagnostic
 * File: api/armls-roof-diagnostic.js
 *
 * READ ONLY
 * Uses existing environment variables:
 * SPARK_ACCESS_TOKEN
 * BLUEVERA_INTERNAL_API_KEY
 */

import crypto from "node:crypto";

const SPARK_BASE =
  "https://replication.sparkapi.com/v1";

function secureMatch(a, b) {
  if (!a || !b) return false;

  const left = crypto
    .createHash("sha256")
    .update(String(a))
    .digest();

  const right = crypto
    .createHash("sha256")
    .update(String(b))
    .digest();

  return crypto.timingSafeEqual(left, right);
}

function safeValue(value) {
  if (value === null || value === undefined)
    return null;

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return typeof value === "string"
      ? value.slice(0, 300)
      : value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map(safeValue);
  }

  if (typeof value === "object") {
    const result = {};

    for (const [key, item] of Object.entries(value)) {
      if (
        /^(value|values|label|name|description|displayvalue)$/i
          .test(key)
      ) {
        result[key] = safeValue(item);
      }
    }

    return Object.keys(result).length
      ? result
      : "[structured value]";
  }

  return null;
}

function findRoofFields(source, sourceName) {
  const results = [];
  const visited = new WeakSet();
  let count = 0;

  function scan(node, path, depth) {
    if (
      !node ||
      typeof node !== "object" ||
      depth > 9 ||
      ++count > 5000
    ) return;

    if (visited.has(node)) return;
    visited.add(node);

    if (Array.isArray(node)) {
      node.slice(0, 100).forEach((item, index) => {
        scan(item, `${path}[${index}]`, depth + 1);
      });
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      if (/roof|roofing|underlay/i.test(key)) {
        results.push({
          field: key,
          path: `${path}.${key}`,
          value: safeValue(value),
          source: sourceName
        });
      }

      if (value && typeof value === "object") {
        scan(value, `${path}.${key}`, depth + 1);
      }
    }
  }

  scan(source, sourceName, 0);
  return results.slice(0, 100);
}

function findMatch(fields, patterns) {
  return fields.find(item =>
    patterns.some(pattern =>
      pattern.test(item.field)
    ) &&
    item.value !== null &&
    item.value !== ""
  ) || null;
}

export default async function handler(req, res) {
  res.setHeader(
    "Cache-Control",
    "private, no-store, max-age=0"
  );

  res.setHeader(
    "X-Content-Type-Options",
    "nosniff"
  );

  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  const expectedKey =
    process.env.BLUEVERA_INTERNAL_API_KEY;

  const providedKey = String(
    req.headers["x-bluevera-internal-key"] || ""
  );

  if (!expectedKey) {
    return res.status(503).json({
      success: false,
      error: "Internal API key not configured"
    });
  }

  if (!secureMatch(providedKey, expectedKey)) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized"
    });
  }

  const mls = String(req.query.mls || "").trim();

  if (!/^\d{5,12}$/.test(mls)) {
    return res.status(400).json({
      success: false,
      error: "Invalid MLS number"
    });
  }

  const sparkToken =
    process.env.SPARK_ACCESS_TOKEN;

  if (!sparkToken) {
    return res.status(503).json({
      success: false,
      error: "Spark token not configured"
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    12000
  );

  try {
    const filter = encodeURIComponent(
      `ListingId Eq '${mls}'`
    );

    const url =
      `${SPARK_BASE}/listings` +
      `?_filter=${filter}` +
      `&_limit=1` +
      `&_expand=CustomFields`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${sparkToken}`,
        Accept: "application/json"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      return res.status(502).json({
        success: false,
        error: "Spark request failed",
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
        error: "Listing not found",
        mlsNumber: mls
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

    const standardRoof = findRoofFields(
      standard,
      "StandardFields"
    );

    const customRoof = findRoofFields(
      custom,
      "CustomFields"
    );

    const allRoof = [
      ...standardRoof,
      ...customRoof
    ];

    return res.status(200).json({
      success: true,
      mode: "READ_ONLY_ROOF_DIAGNOSTIC",
      mlsNumber: mls,

      property: {
        city: standard.City || null,
        state: standard.StateOrProvince || null,
        zip: standard.PostalCode || null,
        yearBuiltFromMLS:
          standard.YearBuilt ?? null
      },

      roof: {
        material: findMatch(allRoof, [
          /^roofing$/i,
          /^roofmaterial$/i,
          /^roofingmaterial$/i,
          /^rooftype$/i,
          /^roofcovering/i
        ]),

        yearUpdated: findMatch(allRoof, [
          /roof\s*yr\s*updated/i,
          /roof.*year.*updated/i,
          /roof.*updated.*year/i,
          /^roof_year$/i
        ]),

        partialOrFull: findMatch(allRoof, [
          /roof\s*partial\s*\/\s*full/i,
          /roof.*partial.*full/i,
          /^roof_scope$/i
        ]),

        allRoofFields: allRoof
      },

      diagnostics: {
        standardRoofFieldCount:
          standardRoof.length,

        customRoofFieldCount:
          customRoof.length,

        hasCustomFields:
          Object.keys(custom).length > 0,

        writesToDatabase: false
      }
    });

  } catch (error) {
    return res.status(502).json({
      success: false,
      error: error.name === "AbortError"
        ? "Spark request timed out"
        : "Unable to complete roof diagnostic"
    });

  } finally {
    clearTimeout(timeout);
  }
}


/**
 * BLUEVERA — ARMLS HVAC DIAGNOSTIC
 *
 * File: api/armls-hvac-diagnostic.js
 *
 * PURPOSE:
 * Inspect HVAC information from ARMLS Spark.
 *
 * Uses existing:
 *   SPARK_ACCESS_TOKEN
 *
 * TEST URL:
 * https://bluevera.app/api/armls-hvac-diagnostic?mls=7094684
 *
 * READ ONLY:
 * No Supabase writes.
 * No changes to existing production files.
 *
 * TEMPORARY DIAGNOSTIC:
 * Restricted to one MLS number.
 * Remove after testing.
 */

const SPARK_BASE =
  "https://replication.sparkapi.com/v1";

const TEST_MLS = "7106241";

const HVAC_PATTERN =
  /hvac|heating|cooling|heat\s*\/\s*cool|ht\s*\/\s*cool|furnace|air.?condition|mini.?split|heat.?pump|refrigeration|evaporative|duct|thermostat|package.?unit/i;

function compactValue(value, depth = 0) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return value.slice(0, 1000);
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (depth >= 6) {
    return "[maximum depth reached]";
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map(item =>
      compactValue(item, depth + 1)
    );
  }

  if (typeof value === "object") {
    const result = {};

    for (const [key, item] of
      Object.entries(value).slice(0, 50)) {

      result[key] = compactValue(
        item,
        depth + 1
      );
    }

    return result;
  }

  return String(value);
}

function scanHVACFields(source, sourceName) {
  const found = [];
  const visited = new WeakSet();

  let scanned = 0;

  function visit(node, path, depth) {
    if (
      node === null ||
      typeof node !== "object" ||
      depth > 10 ||
      scanned >= 5000
    ) {
      return;
    }

    if (visited.has(node)) {
      return;
    }

    visited.add(node);
    scanned++;

    if (Array.isArray(node)) {
      node.slice(0, 200).forEach((item, index) => {
        visit(
          item,
          `${path}[${index}]`,
          depth + 1
        );
      });

      return;
    }

    // Supports label/value-style Spark fields.
    const label =
      node.Name ||
      node.name ||
      node.Label ||
      node.label ||
      node.FieldName ||
      node.fieldName;

    if (
      typeof label === "string" &&
      HVAC_PATTERN.test(label)
    ) {
      const value =
        node.Value ??
        node.value ??
        node.DisplayValue ??
        node.displayValue ??
        node.Values ??
        node.values ??
        null;

      found.push({
        field: label,
        value: compactValue(value),
        source: sourceName,
        path
      });
    }

    for (const [key, value] of Object.entries(node)) {
      const fieldPath = `${path}.${key}`;

      if (HVAC_PATTERN.test(key)) {
        found.push({
          field: key,
          value: compactValue(value),
          source: sourceName,
          path: fieldPath
        });
      }

      if (
        value !== null &&
        typeof value === "object"
      ) {
        visit(value, fieldPath, depth + 1);
      }
    }
  }

  visit(source, sourceName, 0);

  const unique = new Map();

  for (const item of found) {
    unique.set(
      `${item.source}|${item.path}|${item.field}`,
      item
    );
  }

  return Array.from(unique.values()).slice(0, 150);
}

function findField(fields, patterns) {
  return fields.find(entry =>
    patterns.some(pattern =>
      pattern.test(entry.field)
    ) &&
    entry.value !== null &&
    entry.value !== ""
  ) || null;
}

function extractHVACDetails(fields) {
  return {
    coolingType: findField(fields, [
      /^cooling$/i,
      /^cooling type$/i,
      /^coolingtype$/i,
      /^air.?conditioning$/i
    ]),

    heatingType: findField(fields, [
      /^heating$/i,
      /^heating type$/i,
      /^heatingtype$/i
    ]),

    heatingCoolingUpdateYear: findField(fields, [
      /^ht\s*\/\s*cool yr updated$/i,
      /^ht\s*\/\s*cool year updated$/i,
      /hvac.*year.*updated/i,
      /heating.*cooling.*updated/i
    ]),

    partialOrFull: findField(fields, [
      /^ht\s*\/\s*cool partial\s*\/\s*full$/i,
      /hvac.*partial.*full/i,
      /heating.*cooling.*partial.*full/i
    ]),

    heatPump: findField(fields, [
      /heat.?pump/i
    ]),

    miniSplit: findField(fields, [
      /mini.?split/i
    ]),

    furnace: findField(fields, [
      /furnace/i
    ]),

    packageUnit: findField(fields, [
      /package.?unit/i
    ]),

    evaporativeCooling: findField(fields, [
      /evaporative/i
    ])
  };
}

export default async function handler(req, res) {
  res.setHeader(
    "Cache-Control",
    "no-store, max-age=0"
  );

  res.setHeader(
    "X-Content-Type-Options",
    "nosniff"
  );

  res.setHeader(
    "Referrer-Policy",
    "no-referrer"
  );

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");

    return res.status(405).json({
      success: false,
      error: "GET requests only"
    });
  }

  const mls = String(
    req.query?.mls || ""
  ).trim();

  if (mls !== TEST_MLS) {
    return res.status(403).json({
      success: false,
      error:
        "Temporary diagnostic restricted to MLS 7094684"
    });
  }

  const sparkToken =
    process.env.SPARK_ACCESS_TOKEN;

  if (!sparkToken) {
    return res.status(500).json({
      success: false,
      error:
        "SPARK_ACCESS_TOKEN is missing"
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

    const sparkResponse = await fetch(url, {
      method: "GET",
      headers: {
        Authorization:
          `Bearer ${sparkToken}`,
        Accept: "application/json"
      },
      signal: controller.signal
    });

    if (!sparkResponse.ok) {
      return res.status(502).json({
        success: false,
        error: "ARMLS Spark request failed",
        sparkStatus: sparkResponse.status
      });
    }

    const payload =
      await sparkResponse.json();

    const results =
      payload?.D?.Results ||
      payload?.Results ||
      [];

    const listing = Array.isArray(results)
      ? results[0]
      : null;

    if (!listing) {
      return res.status(404).json({
        success: false,
        mlsNumber: mls,
        error:
          "MLS listing not found in Spark response"
      });
    }

    const standard =
      listing.StandardFields ||
      listing.standardFields ||
      {};

    const custom =
      listing.CustomFields ||
      listing.customFields ||
      standard.CustomFields ||
      standard.customFields ||
      {};

    const standardHVACFields =
      scanHVACFields(
        standard,
        "StandardFields"
      );

    const customHVACFields =
      scanHVACFields(
        custom,
        "CustomFields"
      );

    const allHVACFields = [
      ...standardHVACFields,
      ...customHVACFields
    ];

    const hvacDetails =
      extractHVACDetails(allHVACFields);

    return res.status(200).json({
      success: true,

      diagnostic:
        "ARMLS HVAC DATA — FULL VALUES",

      mode: "READ_ONLY",

      mlsNumber: mls,

      property: {
        city: standard.City || null,

        state:
          standard.StateOrProvince ||
          standard.State ||
          null,

        zip: standard.PostalCode || null,

        yearBuiltFromMLS:
          standard.YearBuilt ?? null
      },

      hvac: hvacDetails,

      allHVACFields,

      fieldCounts: {
        standardHVACFields:
          standardHVACFields.length,

        customHVACFields:
          customHVACFields.length,

        totalHVACFields:
          allHVACFields.length
      },

      note:
        "HVAC values are read directly from ARMLS Spark. Missing fields may be unpopulated or unavailable in this listing.",

      databaseUpdated: false,

      capitalExposureUpdated: false
    });

  } catch (error) {
    return res.status(502).json({
      success: false,
      error:
        error.name === "AbortError"
          ? "Spark request timed out"
          : "Unable to retrieve Spark HVAC data"
    });

  } finally {
    clearTimeout(timeout);
  }
}

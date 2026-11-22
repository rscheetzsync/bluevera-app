
/**
 * BLUEVERA — ARMLS ROOF DIAGNOSTIC
 *
 * File: api/armls-roof-diagnostic.js
 *
 * VERSION 2 — DISPLAY ACTUAL ROOFING VALUES
 *
 * Read-only diagnostic for MLS #7103560.
 *
 * Existing environment variable:
 * SPARK_ACCESS_TOKEN
 *
 * No Supabase writes.
 * No map, report, or capital exposure changes.
 *
 * TEMPORARY DIAGNOSTIC:
 * Restrict public access or remove after testing.
 */

const SPARK_BASE =
  "https://replication.sparkapi.com/v1";

const TEST_MLS = "7103560";

const ROOF_PATTERN =
  /roof|roofing|underlay|underlayment/i;

/**
 * Preserve the actual values of Spark roofing fields.
 *
 * IMPORTANT CHANGE:
 * Previously, nested objects became "[structured value]".
 * Now we recursively return their contents.
 *
 * Limits protect against excessive response sizes.
 */
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

/**
 * Find all roof-related fields within the
 * StandardFields and CustomFields objects.
 */
function scanRoofFields(source, sourceName) {
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

    // Support label/value formatted Spark fields.
    const label =
      node.Name ||
      node.name ||
      node.Label ||
      node.label ||
      node.FieldName ||
      node.fieldName;

    if (
      typeof label === "string" &&
      ROOF_PATTERN.test(label)
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

      if (ROOF_PATTERN.test(key)) {
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
        visit(
          value,
          fieldPath,
          depth + 1
        );
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

  return Array.from(unique.values()).slice(0, 100);
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

function extractRoofDetails(fields) {
  return {
    roofingMaterial: findField(fields, [
      /^roofing$/i,
      /^roofing material$/i,
      /^roof material$/i,
      /^roof type$/i,
      /^roof covering$/i,
      /^roofmaterial$/i,
      /^roofingmaterial$/i
    ]),

    roofYearUpdated: findField(fields, [
      /^roof yr updated$/i,
      /^roof year updated$/i,
      /^roof updated year$/i,
      /^roof_year$/i,
      /^roofyearupdated$/i
    ]),

    roofPartialOrFull: findField(fields, [
      /^roof partial\/full$/i,
      /^roof partial or full$/i,
      /^roof replacement scope$/i,
      /^roof scope$/i,
      /^roofpartialfull$/i
    ]),

    underlayment: findField(fields, [
      /underlay/i,
      /underlayment/i
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
        "Diagnostic restricted to MLS 7103560"
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
        error:
          "ARMLS Spark request failed",
        sparkStatus:
          sparkResponse.status
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

    const standardRoofFields =
      scanRoofFields(
        standard,
        "StandardFields"
      );

    const customRoofFields =
      scanRoofFields(
        custom,
        "CustomFields"
      );

    const allRoofFields = [
      ...standardRoofFields,
      ...customRoofFields
    ];

    const roofDetails =
      extractRoofDetails(allRoofFields);

    return res.status(200).json({
      success: true,

      diagnostic:
        "ARMLS ROOF DATA — FULL VALUES",

      mode: "READ_ONLY",

      mlsNumber: mls,

      property: {
        city:
          standard.City || null,

        state:
          standard.StateOrProvince ||
          standard.State ||
          null,

        zip:
          standard.PostalCode || null,

        yearBuiltFromMLS:
          standard.YearBuilt ?? null
      },

      roof: roofDetails,

      allRoofFields,

      fieldCounts: {
        standardRoofFields:
          standardRoofFields.length,

        customRoofFields:
          customRoofFields.length,

        totalRoofFields:
          allRoofFields.length
      },

      note:
        "Roofing values are displayed directly from the ARMLS Spark response. No property records were changed.",

      databaseUpdated: false,

      capitalExposureUpdated: false
    });

  } catch (error) {
    return res.status(502).json({
      success: false,
      error:
        error.name === "AbortError"
          ? "Spark request timed out"
          : "Unable to retrieve Spark roof data"
    });

  } finally {
    clearTimeout(timeout);
  }
}


/**
 * BLUEVERA — ARMLS WATER HEATER DIAGNOSTIC
 *
 * File:
 * api/armls-water-heater-diagnostic.js
 *
 * PURPOSE:
 * Read water heater information directly
 * from the existing ARMLS Spark connection.
 *
 * TEST:
 * https://bluevera.app/api/armls-water-heater-diagnostic?mls=7053552
 *
 * Uses existing environment variable:
 * SPARK_ACCESS_TOKEN
 *
 * READ ONLY:
 * - No Supabase writes
 * - No property updates
 * - No map changes
 * - No Full Report changes
 * - No Capital Exposure changes
 *
 * Temporary diagnostic restricted to one MLS.
 * Remove or secure after testing.
 */

const SPARK_BASE =
  "https://replication.sparkapi.com/v1";

const TEST_MLS = "7045718";

// Search for different names ARMLS may use
// for water heater information.

const WATER_HEATER_PATTERN =
  /water[\s_-]*heat|water[\s_-]*htr|wtr[\s_-]*htr|hot[\s_-]*water|tankless|heat[\s_-]*pump[\s_-]*water/i;

// Keep the full structure of relevant values,
// rather than replacing objects with
// "[structured value]".

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

    for (
      const [key, item]
      of Object.entries(value).slice(0, 50)
    ) {

      result[key] = compactValue(
        item,
        depth + 1
      );
    }

    return result;
  }

  return String(value);
}

// Find fields even when Spark returns
// nested CustomFields objects.

function scanWaterHeaterFields(
  source,
  sourceName
) {

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

      node.slice(0, 200).forEach(
        (item, index) => {

          visit(
            item,
            `${path}[${index}]`,
            depth + 1
          );
        }
      );

      return;
    }

    // Supports Spark fields formatted like:
    //
    // {
    //   Name: "Water Heater",
    //   Value: {...}
    // }

    const label =
      node.Name ||
      node.name ||
      node.Label ||
      node.label ||
      node.FieldName ||
      node.fieldName;

    if (
      typeof label === "string" &&
      WATER_HEATER_PATTERN.test(label)
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

      const fieldPath =
        `${path}.${key}`;

      if (WATER_HEATER_PATTERN.test(key)) {

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

  // Remove duplicate field/path entries.

  const unique = new Map();

  for (const item of found) {

    unique.set(
      `${item.source}|${item.path}|${item.field}`,
      item
    );
  }

  return Array.from(
    unique.values()
  ).slice(0, 150);
}

// Find a particular type of water heater
// information in the returned Spark fields.

function findField(fields, patterns) {

  return fields.find(entry =>

    patterns.some(pattern =>
      pattern.test(entry.field)
    ) &&

    entry.value !== null &&
    entry.value !== ""

  ) || null;
}

function extractWaterHeaterDetails(fields) {

  return {

    waterHeaterType: findField(fields, [
      /^water[\s_-]*heater$/i,
      /^water[\s_-]*heater[\s_-]*type$/i,
      /^water[\s_-]*heating$/i,
      /^hot[\s_-]*water[\s_-]*system$/i
    ]),

    waterHeaterYear: findField(fields, [
      /water.*heat.*year/i,
      /water.*heat.*yr/i,
      /wtr.*htr.*year/i,
      /water.*heat.*install/i,
      /water.*heat.*replac/i
    ]),

    tankless: findField(fields, [
      /tankless/i
    ]),

    fuelType: findField(fields, [
      /water.*heat.*fuel/i,
      /water.*heat.*energy/i
    ]),

    capacity: findField(fields, [
      /water.*heat.*capacity/i,
      /water.*heat.*gallon/i,
      /water.*heat.*size/i
    ]),

    partialOrFull: findField(fields, [
      /water.*heat.*partial.*full/i,
      /water.*heat.*scope/i
    ]),

    otherWaterHeaterDetails:
      fields
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

  // Restrict this temporary diagnostic
  // to the selected MLS number.

  const mls = String(
    req.query?.mls || ""
  ).trim();

  if (mls !== TEST_MLS) {

    return res.status(403).json({
      success: false,
      error:
        "Diagnostic restricted to MLS 7053552"
    });
  }

  // Use BlueVera's existing Spark token.

  const sparkToken =
    process.env.SPARK_ACCESS_TOKEN;

  if (!sparkToken) {

    return res.status(500).json({
      success: false,
      error:
        "SPARK_ACCESS_TOKEN is missing"
    });
  }

  const controller =
    new AbortController();

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

        Accept:
          "application/json"
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

    const listing =
      Array.isArray(results)
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

    // Read water heater fields from
    // both Spark field collections.

    const standardWaterHeaterFields =
      scanWaterHeaterFields(
        standard,
        "StandardFields"
      );

    const customWaterHeaterFields =
      scanWaterHeaterFields(
        custom,
        "CustomFields"
      );

    const allWaterHeaterFields = [
      ...standardWaterHeaterFields,
      ...customWaterHeaterFields
    ];

    const waterHeaterDetails =
      extractWaterHeaterDetails(
        allWaterHeaterFields
      );

    return res.status(200).json({

      success: true,

      diagnostic:
        "ARMLS WATER HEATER DATA",

      mode:
        "READ_ONLY",

      mlsNumber:
        mls,

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

      waterHeater:
        waterHeaterDetails,

      allWaterHeaterFields,

      fieldCounts: {

        standardWaterHeaterFields:
          standardWaterHeaterFields.length,

        customWaterHeaterFields:
          customWaterHeaterFields.length,

        totalWaterHeaterFields:
          allWaterHeaterFields.length

      },

      note:
        "Information is read directly from ARMLS Spark. A missing water heater field does not mean the property lacks a water heater or that it was never replaced.",

      databaseUpdated: false,

      capitalExposureUpdated: false

    });

  } catch (error) {

    return res.status(502).json({

      success: false,

      error:
        error.name === "AbortError"
          ? "Spark request timed out"
          : "Unable to retrieve Spark water heater data"

    });

  } finally {

    clearTimeout(timeout);
  }
}

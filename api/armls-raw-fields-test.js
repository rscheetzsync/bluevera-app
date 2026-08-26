export const config = {
  api: {
    bodyParser: {
      sizeLimit: "1mb"
    }
  }
};

const SPARK_BASE =
  "https://replication.sparkapi.com/v1";

const SPARK_TOKEN =
  process.env.SPARK_ACCESS_TOKEN || "";

function clean(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export default async function handler(req, res) {
  res.setHeader(
    "Content-Type",
    "application/json"
  );

  res.setHeader(
    "Cache-Control",
    "no-store, max-age=0"
  );

  try {
    if (!SPARK_TOKEN) {
      return res.status(500).json({
        success: false,
        error: "SPARK_ACCESS_TOKEN is missing"
      });
    }

    /*
      Accept either:

      GET:
      /api/armls-raw-fields-test?mls=7058478

      or POST:
      {
        "mlsNumber": "7058478"
      }
    */

    const mlsNumber =
      clean(
        req.query?.mls ||
        req.query?.mlsNumber ||
        req.body?.mlsNumber ||
        req.body?.mls ||
        ""
      );

    if (!/^\d+$/.test(mlsNumber)) {
      return res.status(400).json({
        success: false,
        error: "A valid numeric MLS number is required."
      });
    }

    const filter =
      `ListingId Eq '${mlsNumber}'`;

    const sparkUrl =
      `${SPARK_BASE}/listings` +
      `?_filter=${encodeURIComponent(filter)}` +
      "&_limit=1" +
      "&_expand=CustomFields";

    const sparkResponse =
      await fetch(
        sparkUrl,
        {
          method: "GET",

          headers: {
            Authorization:
              `Bearer ${SPARK_TOKEN}`,

            Accept:
              "application/json"
          }
        }
      );

    const sparkText =
      await sparkResponse.text();

    let sparkData;

    try {
      sparkData =
        JSON.parse(sparkText);

    } catch {
      return res.status(502).json({
        success: false,
        error: "Spark returned invalid JSON."
      });
    }

    if (!sparkResponse.ok) {
      return res.status(
        sparkResponse.status
      ).json({
        success: false,

        error:
          sparkData?.D?.Message ||
          sparkData?.message ||
          "Spark listing request failed."
      });
    }

    const listing =
      Array.isArray(
        sparkData?.D?.Results
      )
        ? sparkData.D.Results[0]
        : null;

    if (!listing) {
      return res.status(404).json({
        success: false,
        error:
          `MLS ${mlsNumber} was not found.`
      });
    }

    const standardFields =
      listing.StandardFields ||
      listing ||
      {};

    const customFields =
      listing.CustomFields ||
      standardFields.CustomFields ||
      {};

    /*
      READ-ONLY DIAGNOSTIC.

      This endpoint does NOT:
      - create properties
      - update properties
      - write property history
      - recalculate ratings
      - update the public map
    */

    return res.status(200).json({
      success: true,

      mode:
        "ARMLS_RAW_FIELDS_READ_ONLY",

      mlsNumber,

      armlsDebug: {
        standardFields,
        customFields
      }
    });

  } catch (error) {
    console.error(
      "ARMLS raw fields test failed:",
      error
    );

    return res.status(500).json({
      success: false,

      error:
        error?.message ||
        "ARMLS raw fields test failed."
    });
  }
}

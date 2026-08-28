const SPARK_BASE = "https://replication.sparkapi.com/v1";

const SPARK_TOKEN =
  process.env.SPARK_ACCESS_TOKEN || "";

function clean(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store, max-age=0");

  try {
    if (!SPARK_TOKEN) {
      return res.status(500).json({
        success: false,
        error: "SPARK_ACCESS_TOKEN is missing"
      });
    }

    const mlsId = clean(
      req.query?.mlsid ||
      req.query?.mlsId ||
      ""
    );

    if (!/^[A-Za-z0-9-]{2,30}$/.test(mlsId)) {
      return res.status(400).json({
        success: false,
        error: "A valid agent MLS ID is required."
      });
    }

    const filter = `MlsId Eq '${mlsId}'`;

    const sparkUrl =
      `${SPARK_BASE}/contacts` +
      `?_filter=${encodeURIComponent(filter)}` +
      `&_limit=5`;

    const sparkResponse = await fetch(sparkUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${SPARK_TOKEN}`,
        Accept: "application/json"
      }
    });

    const sparkText = await sparkResponse.text();

    let sparkData;

    try {
      sparkData = JSON.parse(sparkText);
    } catch {
      return res.status(502).json({
        success: false,
        error: "Spark returned invalid JSON.",
        raw: sparkText
      });
    }

    if (!sparkResponse.ok) {
      return res.status(sparkResponse.status).json({
        success: false,
        error:
          sparkData?.D?.Message ||
          sparkData?.message ||
          "Spark contact request failed.",
        sparkResponse: sparkData
      });
    }

    const results =
      Array.isArray(sparkData?.D?.Results)
        ? sparkData.D.Results
        : [];

    return res.status(200).json({
      success: true,
      mode: "ARMLS_MEMBER_READ_ONLY",
      mlsId,
      count: results.length,
      results
    });

  } catch (error) {
    console.error("ARMLS member test failed:", error);

    return res.status(500).json({
      success: false,
      error:
        error?.message ||
        "ARMLS member test failed."
    });
  }
}

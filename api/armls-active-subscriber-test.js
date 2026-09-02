const SPARK_BASE = "https://replication.sparkapi.com/v1";

const SPARK_TOKEN =
  process.env.SPARK_ACCESS_TOKEN || "";

function clean(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeSparkString(value) {
  return clean(value).replace(/'/g, "''");
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

    /*
      READ-ONLY ARMLS ACTIVE SUBSCRIBER TEST

      Examples:

      GET:
      /api/armls-active-subscriber-test?loginName=ABC123

      Also accepted for testing:
      /api/armls-active-subscriber-test?mlsid=ABC123

      POST:
      {
        "loginName": "ABC123"
      }

      This endpoint DOES NOT:
      - create or update BlueVera users
      - write to Supabase
      - modify ARMLS/Spark records
      - grant access by itself

      It only checks whether Spark returns an account
      whose Active field is explicitly true.
    */

    const loginName = clean(
      req.query?.loginName ||
      req.query?.login ||
      req.query?.mlsid ||
      req.query?.mlsId ||
      req.body?.loginName ||
      req.body?.login ||
      req.body?.mlsid ||
      req.body?.mlsId ||
      ""
    );

    if (!/^[A-Za-z0-9._@-]{2,80}$/.test(loginName)) {
      return res.status(400).json({
        success: false,
        active: false,
        allowed: false,
        error: "A valid ARMLS LoginName is required."
      });
    }

    const safeLoginName = escapeSparkString(loginName);

    /*
      ARMLS requires active subscriber verification.

      We query the Spark Accounts service and
      do not treat merely finding a contact/member record
      as proof of active subscriber status.
    */

    const filter =
      `LoginName Eq '${safeLoginName}'`;

    const sparkUrl =
      `${SPARK_BASE}/accounts` +
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
        active: false,
        allowed: false,
        error: "Spark returned invalid JSON.",
        raw: sparkText
      });
    }

    if (!sparkResponse.ok) {
      return res.status(sparkResponse.status).json({
        success: false,
        active: false,
        allowed: false,
        error:
          sparkData?.D?.Message ||
          sparkData?.message ||
          "Spark account request failed.",
        sparkResponse: sparkData
      });
    }

    const results =
      Array.isArray(sparkData?.D?.Results)
        ? sparkData.D.Results
        : [];

    /*
      Find the exact LoginName match if Spark returns
      several rows.

      If Spark returns only one record, use it for
      diagnostic testing.
    */

    const exactMatch =
      results.find((account) =>
        clean(account?.LoginName).toLowerCase() ===
        loginName.toLowerCase()
      ) ||
      (results.length === 1 ? results[0] : null);

    const active =
      exactMatch?.Active === true;

    /*
      allowed becomes true ONLY when Active is
      explicitly boolean true.

      false, null, missing, or unknown = blocked.
    */

    const allowed = active === true;

    return res.status(200).json({
      success: true,

      mode:
        "ARMLS_ACTIVE_SUBSCRIBER_READ_ONLY",

      loginName,

      found:
        Boolean(exactMatch),

      active,

      allowed,

      reason: allowed
        ? "ARMLS subscriber is active."
        : exactMatch
          ? "ARMLS account was found but Active is not true."
          : "No matching ARMLS account was found.",

      account: exactMatch
        ? {
            id:
              exactMatch.Id ?? null,

            loginName:
              exactMatch.LoginName ?? null,

            shortId:
              exactMatch.ShortId ?? null,

            firstName:
              exactMatch.FirstName ?? null,

            lastName:
              exactMatch.LastName ?? null,

            email:
              exactMatch.Email ??
              exactMatch.PrimaryEmail ??
              null,

            officeId:
              exactMatch.OfficeId ??
              exactMatch.Office?.Id ??
              null,

            officeShortId:
              exactMatch.Office?.ShortId ??
              exactMatch.OfficeShortId ??
              null,

            active:
              exactMatch.Active === true
          }
        : null
    });

  } catch (error) {
    console.error(
      "ARMLS active subscriber test failed:",
      error
    );

    return res.status(500).json({
      success: false,
      active: false,
      allowed: false,
      error:
        error?.message ||
        "ARMLS active subscriber test failed."
    });
  }
}

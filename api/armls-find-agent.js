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
        error:
          "SPARK_ACCESS_TOKEN is missing."
      });
    }

    /*
      READ-ONLY ARMLS AGENT FINDER

      Examples:

      /api/armls-find-agent?email=christy@phxdreamhome.com

      /api/armls-find-agent?firstName=Christy&lastName=Walker

      This endpoint does NOT:
      - write to Supabase
      - change any BlueVera agent
      - grant ARMLS access
      - modify Spark data
    */

    const email =
      clean(
        req.query?.email ||
        ""
      );

    const firstName =
      clean(
        req.query?.firstName ||
        req.query?.firstname ||
        ""
      );

    const lastName =
      clean(
        req.query?.lastName ||
        req.query?.lastname ||
        ""
      );

    if (
      !email &&
      !firstName &&
      !lastName
    ) {
      return res.status(400).json({
        success: false,
        error:
          "Provide email or agent first/last name."
      });
    }

    let filter = "";

    if (email) {
      const safeEmail =
        escapeSparkString(email);

      filter =
        `PrimaryEmail Eq '${safeEmail}'`;
    } else if (
      firstName &&
      lastName
    ) {
      const safeFirstName =
        escapeSparkString(firstName);

      const safeLastName =
        escapeSparkString(lastName);

      filter =
        `GivenName Eq '${safeFirstName}' And FamilyName Eq '${safeLastName}'`;
    } else if (lastName) {
      const safeLastName =
        escapeSparkString(lastName);

      filter =
        `FamilyName Eq '${safeLastName}'`;
    } else {
      const safeFirstName =
        escapeSparkString(firstName);

      filter =
        `GivenName Eq '${safeFirstName}'`;
    }

    const sparkUrl =
      `${SPARK_BASE}/contacts` +
      `?_filter=${encodeURIComponent(filter)}` +
      `&_limit=25`;

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
        error:
          "Spark returned invalid JSON.",
        raw:
          sparkText
      });
    }

    if (!sparkResponse.ok) {
      return res
        .status(sparkResponse.status)
        .json({
          success: false,

          error:
            sparkData?.D?.Message ||
            sparkData?.message ||
            "Spark contact request failed.",

          sparkResponse:
            sparkData
        });
    }

    const results =
      Array.isArray(
        sparkData?.D?.Results
      )
        ? sparkData.D.Results
        : [];

    const simplified =
      results.map((contact) => ({
        id:
          contact?.Id ?? null,

        shortId:
          contact?.MlsId ??
          contact?.ShortId ??
          null,

        firstName:
          contact?.GivenName ??
          contact?.FirstName ??
          null,

        lastName:
          contact?.FamilyName ??
          contact?.LastName ??
          null,

        displayName:
          contact?.DisplayName ??
          null,

        email:
          contact?.PrimaryEmail ??
          contact?.Email ??
          null,

        officeId:
          contact?.OfficeId ??
          contact?.Office?.Id ??
          null,

        officeName:
          contact?.OfficeName ??
          contact?.Office?.Name ??
          null,

        raw:
          contact
      }));

    return res.status(200).json({
      success: true,

      mode:
        "ARMLS_AGENT_FINDER_READ_ONLY",

      search: {
        email:
          email || null,

        firstName:
          firstName || null,

        lastName:
          lastName || null
      },

      count:
        simplified.length,

      results:
        simplified
    });

  } catch (error) {
    console.error(
      "ARMLS agent finder failed:",
      error
    );

    return res.status(500).json({
      success: false,

      error:
        error?.message ||
        "ARMLS agent finder failed."
    });
  }
}

const SPARK_BASE =
  "https://replication.sparkapi.com/v1";

const SPARK_TOKEN =
  process.env.SPARK_ACCESS_TOKEN || "";

function clean(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeSparkString(value) {
  return clean(value)
    .replace(/'/g, "''");
}

export default async function handler(
  req,
  res
) {
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
      READ-ONLY ARMLS MEMBER FINDER

      Examples:

      /api/armls-find-agent?email=christy@phxdreamhome.com

      /api/armls-find-agent?firstName=Christy&lastName=Walker

      /api/armls-find-agent?shortId=pm1070

      This endpoint does NOT:
      - write to Supabase
      - modify BlueVera agents
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

    const shortId =
      clean(
        req.query?.shortId ||
        req.query?.shortid ||
        req.query?.mlsId ||
        req.query?.mlsid ||
        ""
      );

    if (
      !email &&
      !firstName &&
      !lastName &&
      !shortId
    ) {
      return res.status(400).json({
        success: false,
        error:
          "Provide email, first/last name, or ARMLS ShortID."
      });
    }

    let filter = "";

    /*
      Spark Accounts API requires UserType
      in the filter.

      We are looking for ARMLS members,
      so UserType = Member.
    */

    if (shortId) {
      const safeShortId =
        escapeSparkString(shortId);

      filter =
        `UserType Eq 'Member' And ShortId Eq '${safeShortId}'`;

    } else if (email) {
      const safeEmail =
        escapeSparkString(email);

      filter =
        `UserType Eq 'Member' And Email Eq '${safeEmail}'`;

    } else if (
      firstName &&
      lastName
    ) {
      const safeFirstName =
        escapeSparkString(firstName);

      const safeLastName =
        escapeSparkString(lastName);

      filter =
        `UserType Eq 'Member' And FirstName Eq '${safeFirstName}' And LastName Eq '${safeLastName}'`;

    } else if (lastName) {
      const safeLastName =
        escapeSparkString(lastName);

      filter =
        `UserType Eq 'Member' And LastName Eq '${safeLastName}'`;

    } else {
      const safeFirstName =
        escapeSparkString(firstName);

      filter =
        `UserType Eq 'Member' And FirstName Eq '${safeFirstName}'`;
    }

    const sparkUrl =
      `${SPARK_BASE}/accounts` +
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
            "Spark account request failed.",

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
      results.map(
        (account) => ({
          id:
            account?.Id ??
            null,

          shortId:
            account?.ShortId ??
            null,

          firstName:
            account?.FirstName ??
            null,

          lastName:
            account?.LastName ??
            null,

          email:
            account?.Email ??
            account?.PrimaryEmail ??
            null,

          active:
            account?.Active === true,

          officeId:
            account?.OfficeId ??
            account?.Office?.Id ??
            null,

          officeShortId:
            account?.OfficeShortId ??
            account?.Office?.ShortId ??
            null,

          loginName:
            account?.LoginName ??
            null,

          userType:
            account?.UserType ??
            null
        })
      );

    return res.status(200).json({
      success: true,

      mode:
        "ARMLS_ACCOUNT_FINDER_READ_ONLY",

      search: {
        email:
          email || null,

        firstName:
          firstName || null,

        lastName:
          lastName || null,

        shortId:
          shortId || null
      },

      count:
        simplified.length,

      results:
        simplified
    });

  } catch (error) {
    console.error(
      "ARMLS account finder failed:",
      error
    );

    return res.status(500).json({
      success: false,

      error:
        error?.message ||
        "ARMLS account finder failed."
    });
  }
}

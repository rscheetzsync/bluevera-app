const SPARK_BASE =
  "https://replication.sparkapi.com/v1";

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

  if (
    req.method !== "GET"
  ) {
    res.setHeader(
      "Allow",
      "GET"
    );

    return res
      .status(405)
      .json({
        success: false,
        error: "Method not allowed."
      });
  }

  try {
    const token =
      process.env.SPARK_ACCESS_TOKEN;

    if (!token) {
      return res
        .status(500)
        .json({
          success: false,
          error:
            "SPARK_ACCESS_TOKEN is missing."
        });
    }

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
        ""
      );

    if (
      !shortId &&
      !firstName &&
      !lastName
    ) {
      return res
        .status(400)
        .json({
          success: false,
          error:
            "Provide a ShortID or agent first/last name."
        });
    }

    let filter = "";

    if (shortId) {
      const safeShortId =
        escapeSparkString(
          shortId
        );

      filter =
        `UserType Eq 'Member' ` +
        `And ShortId Eq '${safeShortId}'`;
    }

    else if (
      firstName &&
      lastName
    ) {
      const safeFirstName =
        escapeSparkString(
          firstName
        );

      const safeLastName =
        escapeSparkString(
          lastName
        );

      filter =
        `UserType Eq 'Member' ` +
        `And FirstName Eq '${safeFirstName}' ` +
        `And LastName Eq '${safeLastName}'`;
    }

    else if (lastName) {
      const safeLastName =
        escapeSparkString(
          lastName
        );

      filter =
        `UserType Eq 'Member' ` +
        `And LastName Eq '${safeLastName}'`;
    }

    else {
      const safeFirstName =
        escapeSparkString(
          firstName
        );

      filter =
        `UserType Eq 'Member' ` +
        `And FirstName Eq '${safeFirstName}'`;
    }

    /*
      IMPORTANT:

      Association is the Spark Member expansion
      we are testing.

      No records are written anywhere.
    */

    const url =
      `${SPARK_BASE}/accounts` +
      `?_filter=${encodeURIComponent(filter)}` +
      `&_limit=25` +
      `&_expand=Association`;

    console.log(
      "ARMLS association test URL:",
      url
    );

    const response =
      await fetch(
        url,
        {
          method: "GET",

          headers: {
            Authorization:
              `Bearer ${token}`,

            Accept:
              "application/json"
          }
        }
      );

    const text =
      await response.text();

    let data = null;

    try {
      data =
        text
          ? JSON.parse(text)
          : null;
    } catch {
      return res
        .status(502)
        .json({
          success: false,
          error:
            "Spark returned invalid JSON.",

          raw:
            text.slice(
              0,
              2000
            )
        });
    }

    if (!response.ok) {
      return res
        .status(response.status)
        .json({
          success: false,

          error:
            data?.D?.Message ||
            data?.message ||
            "Spark association request failed.",

          sparkResponse:
            data
        });
    }

    const results =
      Array.isArray(
        data?.D?.Results
      )
        ? data.D.Results
        : [];

    /*
      For this first test we deliberately return
      both a simplified view AND the raw account.

      That lets us see exactly how ARMLS/Spark
      exposes the Association expansion for your
      particular feed.
    */

    const agents =
      results.map(
        account => ({
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

          association:
            account?.Association ??
            null,

          raw:
            account
        })
      );

    return res
      .status(200)
      .json({
        success: true,

        mode:
          "ARMLS_MEMBER_ASSOCIATION_TEST",

        search: {
          firstName:
            firstName ||
            null,

          lastName:
            lastName ||
            null,

          shortId:
            shortId ||
            null
        },

        count:
          agents.length,

        agents,

        note:
          "Read-only test. No BlueVera, Supabase, or ARMLS records were changed."
      });

  } catch (error) {
    console.error(
      "ARMLS association test failed:",
      error
    );

    return res
      .status(500)
      .json({
        success: false,

        error:
          error?.message ||
          "ARMLS association test failed."
      });
  }
}

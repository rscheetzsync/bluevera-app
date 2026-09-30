const RESO_BASE =
  "https://replication.sparkapi.com/Version/3/Reso/OData";

function clean(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeODataString(value) {
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
      !firstName &&
      !lastName &&
      !shortId
    ) {
      return res
        .status(400)
        .json({
          success: false,
          error:
            "Provide firstName/lastName or shortId."
        });
    }

    /*
      RESO VERSION 3 MEMBER RESOURCE

      Spark documents Association as an expandable
      relationship on this Member endpoint.
    */

    let filter = "";

    if (shortId) {
      const safeShortId =
        escapeODataString(
          shortId
        );

      /*
        RESO Member uses MemberMlsId
        for the member's MLS ID / Short ID.
      */

      filter =
        `MemberMlsId eq '${safeShortId}'`;
    }

    else if (
      firstName &&
      lastName
    ) {
      const safeFirstName =
        escapeODataString(
          firstName
        );

      const safeLastName =
        escapeODataString(
          lastName
        );

      filter =
        `MemberFirstName eq '${safeFirstName}' ` +
        `and MemberLastName eq '${safeLastName}'`;
    }

    else if (lastName) {
      const safeLastName =
        escapeODataString(
          lastName
        );

      filter =
        `MemberLastName eq '${safeLastName}'`;
    }

    else {
      const safeFirstName =
        escapeODataString(
          firstName
        );

      filter =
        `MemberFirstName eq '${safeFirstName}'`;
    }

    const params =
      new URLSearchParams();

    params.set(
      "$filter",
      filter
    );

    params.set(
      "$top",
      "25"
    );

    params.set(
      "$expand",
      "Association"
    );

    const url =
      `${RESO_BASE}/Member?${params.toString()}`;

    console.log(
      "ARMLS RESO association test URL:",
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
            "Spark RESO returned invalid JSON.",

          raw:
            text.slice(
              0,
              3000
            )
        });
    }

    if (!response.ok) {
      return res
        .status(response.status)
        .json({
          success: false,

          error:
            data?.error?.message ||
            data?.message ||
            "Spark RESO Member request failed.",

          requestUrl:
            url,

          sparkResponse:
            data
        });
    }

    /*
      Standard OData responses normally use:
      {
        "@odata.context": "...",
        "value": [ ... ]
      }
    */

    const results =
      Array.isArray(
        data?.value
      )
        ? data.value
        : [];

    const agents =
      results.map(
        member => ({
          memberKey:
            member?.MemberKey ??
            null,

          memberMlsId:
            member?.MemberMlsId ??
            null,

          firstName:
            member?.MemberFirstName ??
            null,

          lastName:
            member?.MemberLastName ??
            null,

          fullName:
            member?.MemberFullName ??
            null,

          email:
            member?.MemberEmail ??
            null,

          status:
            member?.MemberStatus ??
            null,

          officeKey:
            member?.OfficeKey ??
            null,

          officeMlsId:
            member?.OfficeMlsId ??
            null,

          associations:
            member?.Association ??
            [],

          raw:
            member
        })
      );

    return res
      .status(200)
      .json({
        success: true,

        mode:
          "ARMLS_RESO_MEMBER_ASSOCIATION_TEST",

        endpoint:
          "Version 3 RESO Member",

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
          "Read-only RESO Member association test. No BlueVera, Supabase, or ARMLS records were changed."
      });

  } catch (error) {
    console.error(
      "ARMLS RESO association test failed:",
      error
    );

    return res
      .status(500)
      .json({
        success: false,

        error:
          error?.message ||
          "ARMLS RESO association test failed."
      });
  }
}

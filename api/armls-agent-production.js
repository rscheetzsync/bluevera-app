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

function safeInt(value, fallback, min, max) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  return Math.min(
    Math.max(parsed, min),
    max
  );
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(
    clean(value)
  );
}

async function sparkRequest(url, token) {
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
    throw new Error(
      `Spark returned invalid JSON: ${text.slice(0, 1200)}`
    );
  }

  if (!response.ok) {
    throw new Error(
      data?.D?.Message ||
      data?.message ||
      `Spark request failed (${response.status})`
    );
  }

  return data;
}

function sparkResults(data) {
  return Array.isArray(
    data?.D?.Results
  )
    ? data.D.Results
    : Array.isArray(
        data?.Results
      )
      ? data.Results
      : [];
}

async function fetchAgentAccount(
  agentId,
  token
) {
  const safeAgentId =
    escapeSparkString(agentId);

  const filter =
    `UserType Eq 'Member' And Id Eq '${safeAgentId}'`;

  const url =
    `${SPARK_BASE}/accounts` +
    `?_filter=${encodeURIComponent(filter)}` +
    `&_limit=1`;

  const data =
    await sparkRequest(
      url,
      token
    );

  const account =
    sparkResults(data)[0];

  if (!account) {
    return {
      id:
        agentId,

      found:
        false
    };
  }

  return {
    id:
      account?.Id ??
      agentId,

    found:
      true,

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

    officeName:
      account?.OfficeName ??
      account?.Office?.Name ??
      null,

    userType:
      account?.UserType ??
      null
  };
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
        success:
          false,

        error:
          "Method not allowed."
      });
  }

  try {
    const token =
      process.env.SPARK_ACCESS_TOKEN;

    if (!token) {
      return res
        .status(500)
        .json({
          success:
            false,

          error:
            "SPARK_ACCESS_TOKEN is missing."
        });
    }

    const mode =
      clean(
        req.query?.mode ||
        "listings"
      ).toLowerCase();


    /* ==========================================================
       MODE 1:
       LOOK UP ARMLS MEMBER ACCOUNTS BY AGENT ID

       This is deliberately separate from the listing pull so
       the browser can resolve qualified agents in small batches.
    ========================================================== */

    if (
      mode === "accounts"
    ) {
      const ids =
        clean(
          req.query?.ids
        )
          .split(",")
          .map(clean)
          .filter(Boolean)
          .slice(0, 25);

      if (!ids.length) {
        return res
          .status(400)
          .json({
            success:
              false,

            error:
              "Provide one or more agent IDs."
          });
      }

      const settled =
        await Promise.allSettled(
          ids.map(
            id =>
              fetchAgentAccount(
                id,
                token
              )
          )
        );

      const accounts =
        settled.map(
          (item, index) => {
            if (
              item.status ===
              "fulfilled"
            ) {
              return item.value;
            }

            return {
              id:
                ids[index],

              found:
                false,

              error:
                item.reason?.message ||
                "Account lookup failed."
            };
          }
        );

      return res
        .status(200)
        .json({
          success:
            true,

          mode:
            "ARMLS_AGENT_ACCOUNT_BATCH",

          count:
            accounts.length,

          accounts
        });
    }


    /* ==========================================================
       MODE 2:
       PAGE THROUGH CLOSED ARMLS LISTINGS

       Based on BlueVera's existing ARMLS ZIP retrieval pattern:
       /listings + _filter + _limit + _page

       Co-list and co-buyer agents are intentionally NOT counted.
    ========================================================== */

    const startDate =
      clean(
        req.query?.startDate
      );

    const endDate =
      clean(
        req.query?.endDate
      );

    if (
      !validDate(startDate) ||
      !validDate(endDate)
    ) {
      return res
        .status(400)
        .json({
          success:
            false,

          error:
            "startDate and endDate are required in YYYY-MM-DD format."
        });
    }

    const page =
      safeInt(
        req.query?.page,
        1,
        1,
        10000
      );

    const limit =
      safeInt(
        req.query?.limit,
        1000,
        1,
        1000
      );

    /*
      Keep the syntax consistent with the Spark-style filters
      already used by BlueVera.

      We request Closed listings and constrain by CloseDate.
    */

    const filter =
      `StandardStatus Eq 'Closed' ` +
      `And CloseDate Ge '${startDate}' ` +
      `And CloseDate Le '${endDate}'`;

    const url =
      `${SPARK_BASE}/listings` +
      `?_filter=${encodeURIComponent(filter)}` +
      `&_limit=${limit}` +
      `&_page=${page}`;

    const data =
      await sparkRequest(
        url,
        token
      );

    const results =
      sparkResults(data);

    const listings =
      results.map(
        listing => {
          const fields =
            listing?.StandardFields ||
            listing?.standardFields ||
            listing ||
            {};

          return {
            listingKey:
              clean(
                listing?.Id ||
                listing?.ListingKey ||
                fields?.ListingKey
              ) ||
              null,

            mlsNumber:
              clean(
                fields?.ListingId ||
                fields?.MlsId
              ) ||
              null,

            status:
              clean(
                fields?.StandardStatus
              ) ||
              null,

            closeDate:
              fields?.CloseDate ||
              null,

            listAgentId:
              clean(
                fields?.ListAgentId
              ) ||
              null,

            buyerAgentId:
              clean(
                fields?.BuyerAgentId
              ) ||
              null,

            listOfficeId:
              clean(
                fields?.ListOfficeId
              ) ||
              null,

            buyerOfficeId:
              clean(
                fields?.BuyerOfficeId
              ) ||
              null
          };
        }
      );

    return res
      .status(200)
      .json({
        success:
          true,

        mode:
          "ARMLS_AGENT_PRODUCTION_LISTING_PAGE",

        startDate,
        endDate,
        page,
        limit,

        count:
          listings.length,

        hasMore:
          listings.length >= limit,

        listings,

        note:
          "Read-only ARMLS production scan. No Supabase records were created or changed."
      });

  } catch (error) {
    console.error(
      "ARMLS agent production failed:",
      error
    );

    return res
      .status(500)
      .json({
        success:
          false,

        error:
          error?.message ||
          "ARMLS agent production failed."
      });
  }
}

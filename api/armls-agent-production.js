const SPARK_BASE =
  "https://replication.sparkapi.com/v1";

const RESO_BASE =
  "https://replication.sparkapi.com/Version/3/Reso/OData";

function clean(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeSparkString(value) {
  return clean(value)
    .replace(/'/g, "''");
}

function escapeODataString(value) {
  return clean(value)
    .replace(/'/g, "''");
}

function safeInt(value, fallback, min, max) {
  const parsed =
    Number(value);

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

function startTimestamp(date) {
  return `${date}T00:00:00Z`;
}

function endTimestamp(date) {
  return `${date}T23:59:59Z`;
}

async function fetchJson(
  url,
  token
) {
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
      data?.error?.message ||
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

function odataResults(data) {
  return Array.isArray(
    data?.value
  )
    ? data.value
    : [];
}

function associationNames(member) {
  const rows =
    Array.isArray(
      member?.Association
    )
      ? member.Association
      : [];

  return rows
    .map(
      item =>
        clean(
          item?.AssociationName ||
          item?.Name ||
          ""
        )
    )
    .filter(Boolean);
}

async function fetchLegacyAccount(
  agentId,
  token
) {
  const safeAgentId =
    escapeSparkString(
      agentId
    );

  const filter =
    `UserType Eq 'Member' And Id Eq '${safeAgentId}'`;

  const url =
    `${SPARK_BASE}/accounts` +
    `?_filter=${encodeURIComponent(filter)}` +
    `&_limit=1`;

  const data =
    await fetchJson(
      url,
      token
    );

  const account =
    sparkResults(
      data
    )[0];

  if (!account) {
    return null;
  }

  return {
    id:
      account?.Id ??
      agentId,

    shortId:
      account?.ShortId ??
      null,

    firstName:
      account?.FirstName ??
      null,

    lastName:
      account?.LastName ??
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
      account?.Office?.OfficeName ??
      null,

    userType:
      account?.UserType ??
      null
  };
}

async function fetchResoMemberByShortId(
  shortId,
  token
) {
  const safeShortId =
    escapeODataString(
      shortId
    );

  if (!safeShortId) {
    return null;
  }

  const params =
    new URLSearchParams();

  params.set(
    "$filter",
    `MemberMlsId eq '${safeShortId}'`
  );

  params.set(
    "$top",
    "1"
  );

  params.set(
    "$expand",
    "Association"
  );

  const url =
    `${RESO_BASE}/Member?${params.toString()}`;

  const data =
    await fetchJson(
      url,
      token
    );

  const member =
    odataResults(
      data
    )[0];

  if (!member) {
    return null;
  }

  return {
    memberKey:
      member?.MemberKey ??
      null,

    memberMlsId:
      member?.MemberMlsId ??
      shortId,

    status:
      member?.MemberStatus ??
      null,

    associations:
      associationNames(
        member
      )
  };
}

async function resolveAgent(
  agentId,
  token
) {
  const account =
    await fetchLegacyAccount(
      agentId,
      token
    );

  if (!account) {
    return {
      id:
        agentId,

      found:
        false,

      associations:
        [],

      phoenixRealtors:
        false
    };
  }

  let resoMember =
    null;

  if (
    account.shortId
  ) {
    try {
      resoMember =
        await fetchResoMemberByShortId(
          account.shortId,
          token
        );
    } catch (error) {
      console.warn(
        "RESO association lookup failed for",
        account.shortId,
        error?.message
      );
    }
  }

  const associations =
    Array.isArray(
      resoMember?.associations
    )
      ? resoMember.associations
      : [];

  const phoenixRealtors =
    associations.some(
      name =>
        clean(name)
          .toUpperCase() ===
        "PHOENIX REALTORS"
    );

  return {
    ...account,

    found:
      true,

    memberKey:
      resoMember?.memberKey ??
      null,

    memberStatus:
      resoMember?.status ??
      null,

    associations,

    phoenixRealtors
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
       RESOLVE AGENT NAME / BROKERAGE / ASSOCIATION
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
          .slice(
            0,
            25
          );

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
              resolveAgent(
                id,
                token
              )
          )
        );

      const accounts =
        settled.map(
          (
            item,
            index
          ) => {
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

              associations:
                [],

              phoenixRealtors:
                false,

              error:
                item.reason?.message ||
                "Agent resolution failed."
            };
          }
        );

      return res
        .status(200)
        .json({
          success:
            true,

          mode:
            "ARMLS_AGENT_NAME_BROKERAGE_ASSOCIATION_BATCH",

          count:
            accounts.length,

          accounts,

          note:
            "Read-only account and association lookup. No email data is returned."
        });
    }


    /* ==========================================================
       MODE 2:
       PAGE THROUGH CLOSED LISTINGS

       Only primary ListAgentId and BuyerAgentId are counted.
       Co-list and co-buyer agents are intentionally excluded.
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

    const start =
      startTimestamp(
        startDate
      );

    const end =
      endTimestamp(
        endDate
      );

    const filter =
      `StandardStatus Eq 'Closed' ` +
      `And CloseDate bt ${start},${end}`;

    /*
      Keep the listing response as small as possible.

      If Spark ignores _select, the endpoint still works because
      we only return the few fields BlueVera needs below.
    */

    const select =
      [
        "ListingId",
        "ListingKey",
        "StandardStatus",
        "CloseDate",
        "ListAgentId",
        "BuyerAgentId"
      ].join(",");

    const url =
      `${SPARK_BASE}/listings` +
      `?_filter=${encodeURIComponent(filter)}` +
      `&_limit=${limit}` +
      `&_page=${page}` +
      `&_select=${encodeURIComponent(select)}`;

    const data =
      await fetchJson(
        url,
        token
      );

    const results =
      sparkResults(
        data
      );

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
          "ARMLS_TOP_PRODUCER_LISTING_PAGE",

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
          "Read-only ARMLS top-producer scan. No Supabase records were created or changed."
      });

  } catch (error) {
    console.error(
      "ARMLS top producer scan failed:",
      error
    );

    return res
      .status(500)
      .json({
        success:
          false,

        error:
          error?.message ||
          "ARMLS top producer scan failed."
      });
  }
}

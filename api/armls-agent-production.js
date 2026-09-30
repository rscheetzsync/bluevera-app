const SPARK_BASE =
  "https://replication.sparkapi.com/v1";

const RESO_BASE =
  "https://replication.sparkapi.com/Version/3/Reso/OData";

function clean(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
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

function startTimestamp(date) {
  return `${date}T00:00:00Z`;
}

function endTimestamp(date) {
  return `${date}T23:59:59Z`;
}

function escapeSparkString(value) {
  return clean(value)
    .replace(/'/g, "''");
}

async function fetchJson(url, token) {
  const response = await fetch(
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

function isPhoenixRealtor(member) {
  return associationNames(member)
    .some(
      name =>
        name.toUpperCase() ===
        "PHOENIX REALTORS"
    );
}

function sparkCount(data) {
  const total =
    data?.D?.Pagination?.TotalRows ??
    data?.Pagination?.TotalRows ??
    0;

  const parsed =
    Number(total);

  return Number.isFinite(parsed)
    ? parsed
    : 0;
}

async function countClosedTransactions({
  memberKey,
  startDate,
  endDate,
  token
}) {
  const safeKey =
    escapeSparkString(
      memberKey
    );

  const start =
    startTimestamp(
      startDate
    );

  const end =
    endTimestamp(
      endDate
    );

  /*
    Count each CLOSED MLS listing once when this member is either
    the primary list agent OR the primary buyer agent.

    Co-list and co-buyer agents are intentionally excluded.

    _pagination=count returns only the number of matching rows,
    not the listing records themselves.
  */

  const filter =
    `StandardStatus Eq 'Closed' ` +
    `And CloseDate bt ${start},${end} ` +
    `And (ListAgentId Eq '${safeKey}' Or BuyerAgentId Eq '${safeKey}')`;

  const url =
    `${SPARK_BASE}/listings` +
    `?_filter=${encodeURIComponent(filter)}` +
    `&_pagination=count` +
    `&_limit=0`;

  const data =
    await fetchJson(
      url,
      token
    );

  return sparkCount(
    data
  );
}

async function fetchOfficeName(
  officeKey,
  token
) {
  const key =
    clean(
      officeKey
    );

  if (!key) {
    return null;
  }

  const url =
    `${RESO_BASE}/Office('${encodeURIComponent(key)}')` +
    `?$select=OfficeKey,OfficeName,OfficeMlsId`;

  try {
    const data =
      await fetchJson(
        url,
        token
      );

    return {
      officeKey:
        data?.OfficeKey ??
        key,

      officeName:
        data?.OfficeName ??
        data?.OfficeMlsId ??
        null
    };
  } catch {
    return {
      officeKey:
        key,

      officeName:
        null
    };
  }
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
        "member-count"
      ).toLowerCase();


    /* ==========================================================
       MODE 1:
       GET TOTAL VISIBLE ARMLS MEMBER COUNT

       The browser uses this only to choose random page offsets.
    ========================================================== */

    if (
      mode === "member-count"
    ) {
      const params =
        new URLSearchParams();

      params.set(
        "$top",
        "1"
      );

      params.set(
        "$count",
        "true"
      );

      params.set(
        "$select",
        "MemberKey"
      );

      const url =
        `${RESO_BASE}/Member?${params.toString()}`;

      const data =
        await fetchJson(
          url,
          token
        );

      const totalMembers =
        Number(
          data?.["@odata.count"] ??
          0
        );

      return res
        .status(200)
        .json({
          success:
            true,

          mode:
            "ARMLS_MEMBER_COUNT",

          totalMembers:
            Number.isFinite(totalMembers)
              ? totalMembers
              : 0
        });
    }


    /* ==========================================================
       MODE 2:
       RETURN ONE RANDOMIZABLE MEMBER PAGE,
       FILTERED LOCALLY TO PHOENIX REALTORS.

       The browser supplies a random $skip value.
    ========================================================== */

    if (
      mode === "member-page"
    ) {
      const skip =
        safeInt(
          req.query?.skip,
          0,
          0,
          2500000
        );

      const top =
        safeInt(
          req.query?.top,
          500,
          1,
          1000
        );

      const params =
        new URLSearchParams();

      params.set(
        "$top",
        String(top)
      );

      params.set(
        "$skip",
        String(skip)
      );

      params.set(
        "$select",
        [
          "MemberKey",
          "MemberMlsId",
          "MemberFirstName",
          "MemberLastName",
          "MemberFullName",
          "MemberStatus",
          "OfficeKey",
          "OfficeMlsId"
        ].join(",")
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

      const allMembers =
        odataResults(
          data
        );

      const members =
        allMembers
          .filter(
            member =>
              isPhoenixRealtor(
                member
              )
          )
          .map(
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
                [
                  member?.MemberFirstName,
                  member?.MemberLastName
                ]
                  .filter(Boolean)
                  .join(" ") ||
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

              association:
                "Phoenix REALTORS"
            })
          )
          .filter(
            member =>
              Boolean(
                member.memberKey
              )
          );

      return res
        .status(200)
        .json({
          success:
            true,

          mode:
            "PHOENIX_REALTORS_RANDOM_PAGE",

          skip,
          requested:
            top,

          scanned:
            allMembers.length,

          phoenixCount:
            members.length,

          members
        });
    }


    /* ==========================================================
       MODE 3:
       CHECK PRODUCTION FOR A SMALL BATCH OF MEMBERS.

       One count query per member.
       No listing records are downloaded.
    ========================================================== */

    if (
      mode === "production-batch"
    ) {
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

      const ids =
        clean(
          req.query?.ids
        )
          .split(",")
          .map(clean)
          .filter(Boolean)
          .slice(
            0,
            15
          );

      if (!ids.length) {
        return res
          .status(400)
          .json({
            success:
              false,

            error:
              "Provide one or more MemberKey values."
          });
      }

      const settled =
        await Promise.allSettled(
          ids.map(
            memberKey =>
              countClosedTransactions({
                memberKey,
                startDate,
                endDate,
                token
              })
          )
        );

      const production =
        settled.map(
          (
            result,
            index
          ) => ({
            memberKey:
              ids[index],

            closedTransactions:
              result.status ===
              "fulfilled"
                ? result.value
                : null,

            error:
              result.status ===
              "rejected"
                ? (
                    result.reason?.message ||
                    "Production count failed."
                  )
                : null
          })
        );

      return res
        .status(200)
        .json({
          success:
            true,

          mode:
            "ARMLS_MEMBER_PRODUCTION_BATCH",

          startDate,
          endDate,

          count:
            production.length,

          production
        });
    }


    /* ==========================================================
       MODE 4:
       RESOLVE BROKERAGE NAMES ONLY FOR FINAL DISPLAYED RESULTS.
    ========================================================== */

    if (
      mode === "office-batch"
    ) {
      const officeKeys =
        [
          ...new Set(
            clean(
              req.query?.ids
            )
              .split(",")
              .map(clean)
              .filter(Boolean)
          )
        ]
          .slice(
            0,
            25
          );

      if (!officeKeys.length) {
        return res
          .status(400)
          .json({
            success:
              false,

            error:
              "Provide one or more OfficeKey values."
          });
      }

      const settled =
        await Promise.allSettled(
          officeKeys.map(
            officeKey =>
              fetchOfficeName(
                officeKey,
                token
              )
          )
        );

      const offices =
        settled.map(
          (
            result,
            index
          ) => {
            if (
              result.status ===
              "fulfilled"
            ) {
              return result.value;
            }

            return {
              officeKey:
                officeKeys[index],

              officeName:
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
            "ARMLS_OFFICE_NAME_BATCH",

          count:
            offices.length,

          offices
        });
    }


    return res
      .status(400)
      .json({
        success:
          false,

        error:
          "Unknown mode."
      });

  } catch (error) {
    console.error(
      "ARMLS random production tool failed:",
      error
    );

    return res
      .status(500)
      .json({
        success:
          false,

        error:
          error?.message ||
          "ARMLS random production tool failed."
      });
  }
}

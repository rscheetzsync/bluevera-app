const SPARK_BASE =
  "https://replication.sparkapi.com/v1";

const RESO_BASE =
  "https://replication.sparkapi.com/Version/3/Reso/OData";

const SUPABASE_URL =
  process.env.SUPABASE_URL;

const SUPABASE_SECRET_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY;

const POOL_TABLE =
  "armls_agent_production_pool";

const clean = value =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

const safeInt = (
  value,
  fallback,
  min,
  max
) => {
  const parsed =
    Number(value);

  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  return Math.min(
    Math.max(
      parsed,
      min
    ),
    max
  );
};

const validDate = value =>
  /^\d{4}-\d{2}-\d{2}$/.test(
    clean(value)
  );

const escapeSparkString = value =>
  clean(value)
    .replace(
      /'/g,
      "''"
    );


function supabaseHeaders(
  extra = {}
) {
  return {
    "Content-Type":
      "application/json",

    apikey:
      SUPABASE_SECRET_KEY,

    Authorization:
      `Bearer ${SUPABASE_SECRET_KEY}`,

    ...extra
  };
}


async function supabaseRequest(
  path,
  options = {}
) {
  if (
    !SUPABASE_URL ||
    !SUPABASE_SECRET_KEY
  ) {
    throw new Error(
      "Missing Supabase environment variables."
    );
  }

  const response =
    await fetch(
      `${SUPABASE_URL}/rest/v1/${path}`,
      {
        ...options,

        headers:
          supabaseHeaders(
            options.headers ||
            {}
          )
      }
    );

  const text =
    await response.text();

  let data =
    null;

  if (text) {
    try {
      data =
        JSON.parse(
          text
        );
    } catch {
      data =
        text;
    }
  }

  if (
    !response.ok
  ) {
    throw new Error(
      `Supabase ${response.status}: ${
        typeof data ===
        "string"
          ? data
          : JSON.stringify(
              data
            )
      }`
    );
  }

  return data;
}


async function fetchJson(
  url,
  token
) {
  const response =
    await fetch(
      url,
      {
        method:
          "GET",

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

  let data =
    null;

  try {
    data =
      text
        ? JSON.parse(
            text
          )
        : null;
  } catch {
    throw new Error(
      `Upstream returned non-JSON: ${text.slice(
        0,
        300
      )}`
    );
  }

  if (
    !response.ok
  ) {
    throw new Error(
      data?.D?.Message ||
      data?.error?.message ||
      data?.message ||
      `Upstream request failed (${response.status})`
    );
  }

  return data;
}


function odataResults(
  data
) {
  return Array.isArray(
    data?.value
  )
    ? data.value
    : [];
}


function associationNames(
  member
) {
  return (
    Array.isArray(
      member?.Association
    )
      ? member.Association
      : []
  )
    .map(
      item =>
        clean(
          item?.AssociationName ||
          item?.Name ||
          ""
        )
    )
    .filter(
      Boolean
    );
}


function isPhoenixRealtor(
  member
) {
  return associationNames(
    member
  )
    .some(
      name =>
        name.toUpperCase() ===
        "PHOENIX REALTORS"
    );
}


function sparkCount(
  data
) {
  const total =
    data?.D?.Pagination
      ?.TotalRows ??
    data?.Pagination
      ?.TotalRows ??
    data?.D?.TotalRows ??
    data?.TotalRows ??
    0;

  const parsed =
    Number(
      total
    );

  return Number.isFinite(
    parsed
  )
    ? parsed
    : 0;
}


async function fetchOfficeName(
  officeKey,
  officeMlsId,
  token
) {
  const key =
    clean(
      officeKey
    );

  if (!key) {
    return (
      clean(
        officeMlsId
      ) ||
      null
    );
  }

  const params =
    new URLSearchParams();

  params.set(
    "$select",
    "OfficeKey,OfficeName,OfficeMlsId"
  );

  const url =
    `${RESO_BASE}/Office('${encodeURIComponent(
      key
    )}')?${params.toString()}`;

  try {
    const data =
      await fetchJson(
        url,
        token
      );

    return (
      clean(
        data?.OfficeName
      ) ||
      clean(
        data?.OfficeMlsId
      ) ||
      clean(
        officeMlsId
      ) ||
      null
    );

  } catch {
    return (
      clean(
        officeMlsId
      ) ||
      null
    );
  }
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
    `${startDate}T00:00:00Z`;

  const end =
    `${endDate}T23:59:59Z`;

  const filter =
    `StandardStatus Eq 'Closed' ` +
    `And CloseDate bt ${start},${end} ` +
    `And (ListAgentId Eq '${safeKey}' Or BuyerAgentId Eq '${safeKey}')`;

  const url =
    `${SPARK_BASE}/listings` +
    `?_filter=${encodeURIComponent(
      filter
    )}` +
    `&_pagination=count`;

  return sparkCount(
    await fetchJson(
      url,
      token
    )
  );
}


async function readJsonBody(
  req
) {
  if (
    req.body &&
    typeof req.body ===
    "object"
  ) {
    return req.body;
  }

  if (
    typeof req.body ===
    "string" &&
    req.body
  ) {
    try {
      return JSON.parse(
        req.body
      );
    } catch {
      return {};
    }
  }

  return {};
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
    const token =
      process.env.SPARK_ACCESS_TOKEN;

    if (!token) {
      return res
        .status(
          500
        )
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
        ""
      )
        .toLowerCase();


    /* ==========================================================
       GET: SMALL RESO MEMBER PAGE

       Does not save anything.
       Browser walks member pages and only sends
       verified Phoenix REALTORS members to save-members.
    ========================================================== */

    if (
      req.method ===
        "GET" &&
      mode ===
        "member-page"
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
          25,
          1,
          50
        );

      const params =
        new URLSearchParams();

      params.set(
        "$top",
        String(
          top
        )
      );

      params.set(
        "$skip",
        String(
          skip
        )
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
        ].join(
          ","
        )
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
            isPhoenixRealtor
          )
          .map(
            member => ({
              memberKey:
                member?.MemberKey ??
                null,

              memberMlsId:
                member?.MemberMlsId ??
                null,

              fullName:
                member?.MemberFullName ??
                [
                  member?.MemberFirstName,
                  member?.MemberLastName
                ]
                  .filter(
                    Boolean
                  )
                  .join(
                    " "
                  ) ||
                null,

              memberStatus:
                member?.MemberStatus ??
                null,

              officeKey:
                member?.OfficeKey ??
                null,

              officeMlsId:
                member?.OfficeMlsId ??
                null,

              associationName:
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
        .status(
          200
        )
        .json({
          success:
            true,

          mode:
            "PHOENIX_REALTORS_MEMBER_PAGE",

          skip,

          requested:
            top,

          scanned:
            allMembers.length,

          phoenixCount:
            members.length,

          endReached:
            allMembers.length <
            top,

          nextSkip:
            skip +
            allMembers.length,

          members
        });
    }


    /* ==========================================================
       POST: SAVE VERIFIED PHOENIX REALTORS

       Duplicate-safe by member_key.
    ========================================================== */

    if (
      req.method ===
        "POST" &&
      mode ===
        "save-members"
    ) {
      const body =
        await readJsonBody(
          req
        );

      const members =
        (
          Array.isArray(
            body?.members
          )
            ? body.members
            : []
        )
          .filter(
            member =>
              clean(
                member?.memberKey
              )
          )
          .slice(
            0,
            25
          );

      if (
        !members.length
      ) {
        return res
          .status(
            400
          )
          .json({
            success:
              false,

            error:
              "No members supplied."
          });
      }

      const officeResults =
        await Promise.allSettled(
          members.map(
            member =>
              fetchOfficeName(
                member.officeKey,
                member.officeMlsId,
                token
              )
          )
        );

      const now =
        new Date()
          .toISOString();

      const payload =
        members.map(
          (
            member,
            index
          ) => ({
            member_key:
              clean(
                member.memberKey
              ),

            member_mls_id:
              clean(
                member.memberMlsId
              ) ||
              null,

            full_name:
              clean(
                member.fullName
              ) ||
              null,

            office_key:
              clean(
                member.officeKey
              ) ||
              null,

            office_mls_id:
              clean(
                member.officeMlsId
              ) ||
              null,

            office_name:
              officeResults[
                index
              ]?.status ===
              "fulfilled"
                ? (
                    officeResults[
                      index
                    ].value ||
                    null
                  )
                : (
                    clean(
                      member.officeMlsId
                    ) ||
                    null
                  ),

            association_name:
              "Phoenix REALTORS",

            member_status:
              clean(
                member.memberStatus
              ) ||
              null,

            production_status:
              "pending",

            updated_at:
              now
          })
        );

      const rows =
        await supabaseRequest(
          `${POOL_TABLE}?on_conflict=member_key`,
          {
            method:
              "POST",

            headers: {
              Prefer:
                "resolution=merge-duplicates,return=representation"
            },

            body:
              JSON.stringify(
                payload
              )
          }
        );

      return res
        .status(
          200
        )
        .json({
          success:
            true,

          mode:
            "SAVE_PHOENIX_REALTORS_MEMBERS",

          received:
            members.length,

          saved:
            Array.isArray(
              rows
            )
              ? rows.length
              : 0,

          rows:
            Array.isArray(
              rows
            )
              ? rows
              : []
        });
    }


    /* ==========================================================
       GET: SUMMARY
    ========================================================== */

    if (
      req.method ===
        "GET" &&
      mode ===
        "summary"
    ) {
      const rows =
        await supabaseRequest(
          `${POOL_TABLE}?select=member_key,production_status`,
          {
            method:
              "GET"
          }
        );

      const list =
        Array.isArray(
          rows
        )
          ? rows
          : [];

      const completed =
        list.filter(
          row =>
            row.production_status ===
            "complete"
        ).length;

      return res
        .status(
          200
        )
        .json({
          success:
            true,

          mode:
            "POOL_SUMMARY",

          total:
            list.length,

          completed,

          pending:
            list.length -
            completed
        });
    }


    /* ==========================================================
       POST: CALCULATE PRODUCTION

       Works only from saved BlueVera pool.
       Runs a small batch and stores results.
    ========================================================== */

    if (
      req.method ===
        "POST" &&
      mode ===
        "calculate-production"
    ) {
      const body =
        await readJsonBody(
          req
        );

      const startDate =
        clean(
          body?.startDate
        );

      const endDate =
        clean(
          body?.endDate
        );

      const batchSize =
        safeInt(
          body?.batchSize,
          5,
          1,
          10
        );

      if (
        !validDate(
          startDate
        ) ||
        !validDate(
          endDate
        )
      ) {
        return res
          .status(
            400
          )
          .json({
            success:
              false,

            error:
              "startDate and endDate are required in YYYY-MM-DD format."
          });
      }

      const pendingRows =
        await supabaseRequest(
          `${POOL_TABLE}` +
          `?select=*` +
          `&production_status=neq.complete` +
          `&order=created_at.asc` +
          `&limit=${batchSize}`,
          {
            method:
              "GET"
          }
        );

      const pending =
        Array.isArray(
          pendingRows
        )
          ? pendingRows
          : [];

      if (
        !pending.length
      ) {
        return res
          .status(
            200
          )
          .json({
            success:
              true,

            mode:
              "CALCULATE_PRODUCTION",

            processed:
              0,

            done:
              true,

            results:
              []
          });
      }

      const settled =
        await Promise.allSettled(
          pending.map(
            row =>
              countClosedTransactions({
                memberKey:
                  row.member_key,

                startDate,

                endDate,

                token
              })
          )
        );

      const results =
        [];

      for (
        let index = 0;
        index <
        pending.length;
        index += 1
      ) {
        const row =
          pending[
            index
          ];

        const result =
          settled[
            index
          ];

        const now =
          new Date()
            .toISOString();

        if (
          result.status ===
          "fulfilled"
        ) {
          const count =
            Number(
              result.value
            ) ||
            0;

          await supabaseRequest(
            `${POOL_TABLE}` +
            `?member_key=eq.${encodeURIComponent(
              row.member_key
            )}`,
            {
              method:
                "PATCH",

              headers: {
                Prefer:
                  "return=representation"
              },

              body:
                JSON.stringify({
                  closed_transactions_12mo:
                    count,

                  production_status:
                    "complete",

                  production_checked_at:
                    now,

                  production_start_date:
                    startDate,

                  production_end_date:
                    endDate,

                  production_error:
                    null,

                  updated_at:
                    now
                })
            }
          );

          results.push({
            memberKey:
              row.member_key,

            closedTransactions:
              count,

            status:
              "complete"
          });

        } else {
          const errorText =
            result.reason
              ?.message ||
            "Production count failed.";

          await supabaseRequest(
            `${POOL_TABLE}` +
            `?member_key=eq.${encodeURIComponent(
              row.member_key
            )}`,
            {
              method:
                "PATCH",

              headers: {
                Prefer:
                  "return=representation"
              },

              body:
                JSON.stringify({
                  production_status:
                    "error",

                  production_error:
                    errorText,

                  production_checked_at:
                    now,

                  updated_at:
                    now
                })
            }
          );

          results.push({
            memberKey:
              row.member_key,

            closedTransactions:
              null,

            status:
              "error",

            error:
              errorText
          });
        }
      }

      return res
        .status(
          200
        )
        .json({
          success:
            true,

          mode:
            "CALCULATE_PRODUCTION",

          processed:
            results.length,

          done:
            false,

          results
        });
    }


    /* ==========================================================
       GET: LIST SAVED AGENTS
    ========================================================== */

    if (
      req.method ===
        "GET" &&
      mode ===
        "list"
    ) {
      const limit =
        safeInt(
          req.query?.limit,
          500,
          1,
          1000
        );

      const rows =
        await supabaseRequest(
          `${POOL_TABLE}` +
          `?select=*` +
          `&order=closed_transactions_12mo.desc.nullslast,full_name.asc` +
          `&limit=${limit}`,
          {
            method:
              "GET"
          }
        );

      return res
        .status(
          200
        )
        .json({
          success:
            true,

          mode:
            "POOL_LIST",

          count:
            Array.isArray(
              rows
            )
              ? rows.length
              : 0,

          rows:
            Array.isArray(
              rows
            )
              ? rows
              : []
        });
    }


    return res
      .status(
        400
      )
      .json({
        success:
          false,

        error:
          "Unknown mode."
      });

  } catch (
    error
  ) {
    console.error(
      "ARMLS production pool failed:",
      error
    );

    return res
      .status(
        500
      )
      .json({
        success:
          false,

        error:
          error?.message ||
          "ARMLS production pool failed."
      });
  }
}

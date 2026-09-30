const SPARK_BASE =
  "https://replication.sparkapi.com/v1";

const RESO_BASE =
  "https://replication.sparkapi.com/Version/3/Reso/OData";

const SUPABASE_URL =
  process.env.SUPABASE_URL;

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const TABLE =
  "armls_agent_production_pool";


function clean(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}


function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(
    clean(value)
  );
}


function safeInteger(
  value,
  fallback,
  minimum,
  maximum
) {
  const number =
    Number(value);

  if (
    !Number.isInteger(number)
  ) {
    return fallback;
  }

  return Math.min(
    Math.max(
      number,
      minimum
    ),
    maximum
  );
}


function sparkEscape(value) {
  return clean(value)
    .replace(
      /'/g,
      "''"
    );
}


/* ============================================================
   GENERIC JSON FETCH
============================================================ */

async function fetchJson(
  url,
  options = {}
) {
  const response =
    await fetch(
      url,
      options
    );

  const text =
    await response.text();

  let data =
    null;

  try {
    data =
      text
        ? JSON.parse(text)
        : null;
  } catch {
    throw new Error(
      `Non-JSON response: ${text.slice(
        0,
        250
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
      `Request failed (${response.status})`
    );
  }

  return data;
}


/* ============================================================
   SUPABASE
============================================================ */

async function supabaseRequest(
  path,
  options = {}
) {
  if (
    !SUPABASE_URL
  ) {
    throw new Error(
      "SUPABASE_URL is missing."
    );
  }

  if (
    !SUPABASE_KEY
  ) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is missing."
    );
  }

  const response =
    await fetch(
      `${SUPABASE_URL}/rest/v1/${path}`,
      {
        ...options,

        headers: {
          apikey:
            SUPABASE_KEY,

          Authorization:
            `Bearer ${SUPABASE_KEY}`,

          "Content-Type":
            "application/json",

          ...(options.headers || {})
        }
      }
    );

  const text =
    await response.text();

  let data =
    null;

  if (text) {
    try {
      data =
        JSON.parse(text);
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
        typeof data === "string"
          ? data
          : JSON.stringify(data)
      }`
    );
  }

  return data;
}


/* ============================================================
   SPARK / ARMLS REQUEST
============================================================ */

async function sparkRequest(
  url
) {
  const token =
    process.env.SPARK_ACCESS_TOKEN;

  if (!token) {
    throw new Error(
      "SPARK_ACCESS_TOKEN is missing."
    );
  }

  return fetchJson(
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
}


/* ============================================================
   PHOENIX REALTORS ASSOCIATION CHECK
============================================================ */

function getAssociationNames(
  member
) {
  const associations =
    Array.isArray(
      member?.Association
    )
      ? member.Association
      : [];

  return associations
    .map(
      association =>
        clean(
          association
            ?.AssociationName ||
          association
            ?.Name ||
          ""
        )
    )
    .filter(Boolean);
}


function isPhoenixRealtor(
  member
) {
  return getAssociationNames(
    member
  ).some(
    name =>
      name.toUpperCase() ===
      "PHOENIX REALTORS"
  );
}


/* ============================================================
   READ REQUEST BODY
============================================================ */

async function getBody(
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


/* ============================================================
   COUNT CLOSED TRANSACTIONS
============================================================ */

function extractCount(
  data
) {
  const possible =
    data?.D?.Pagination
      ?.TotalRows ??
    data?.Pagination
      ?.TotalRows ??
    data?.D?.TotalRows ??
    data?.TotalRows ??
    0;

  const number =
    Number(possible);

  return Number.isFinite(
    number
  )
    ? number
    : 0;
}


async function countAgentTransactions(
  memberKey,
  startDate,
  endDate
) {
  const key =
    sparkEscape(
      memberKey
    );

  const start =
    `${startDate}T00:00:00Z`;

  const end =
    `${endDate}T23:59:59Z`;

  const filter =
    `StandardStatus Eq 'Closed' ` +
    `And CloseDate bt ${start},${end} ` +
    `And (` +
    `ListAgentId Eq '${key}' ` +
    `Or BuyerAgentId Eq '${key}'` +
    `)`;

  const url =
    `${SPARK_BASE}/listings` +
    `?_filter=${encodeURIComponent(
      filter
    )}` +
    `&_pagination=count`;

  const data =
    await sparkRequest(
      url
    );

  return extractCount(
    data
  );
}


/* ============================================================
   MAIN HANDLER
============================================================ */

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

    const mode =
      clean(
        req.query?.mode ||
        ""
      )
        .toLowerCase();


    /* ========================================================
       HEALTH CHECK
    ======================================================== */

    if (
      !mode ||
      mode === "health"
    ) {
      return res
        .status(200)
        .json({
          success:
            true,

          message:
            "ARMLS Agent Production API is running.",

          environment: {
            spark:
              Boolean(
                process.env
                  .SPARK_ACCESS_TOKEN
              ),

            supabaseUrl:
              Boolean(
                SUPABASE_URL
              ),

            serviceRoleKey:
              Boolean(
                SUPABASE_KEY
              )
          }
        });
    }


    /* ========================================================
       SUMMARY

       DOES NOT CALL ARMLS.
       ONLY CHECKS SUPABASE.
    ======================================================== */

    if (
      req.method === "GET" &&
      mode === "summary"
    ) {
      const rows =
        await supabaseRequest(
          `${TABLE}` +
          `?select=member_key,production_status`,
          {
            method:
              "GET"
          }
        );

      const agents =
        Array.isArray(rows)
          ? rows
          : [];

      const completed =
        agents.filter(
          row =>
            row.production_status ===
            "complete"
        ).length;

      const pending =
        agents.length -
        completed;

      return res
        .status(200)
        .json({
          success:
            true,

          mode:
            "POOL_SUMMARY",

          total:
            agents.length,

          completed,

          pending
        });
    }


    /* ========================================================
       LIST SAVED AGENTS

       DOES NOT CALL ARMLS.
    ======================================================== */

    if (
      req.method === "GET" &&
      mode === "list"
    ) {
      const limit =
        safeInteger(
          req.query?.limit,
          500,
          1,
          1000
        );

      const rows =
        await supabaseRequest(
          `${TABLE}` +
          `?select=*` +
          `&order=closed_transactions_12mo.desc.nullslast,full_name.asc` +
          `&limit=${limit}`,
          {
            method:
              "GET"
          }
        );

      return res
        .status(200)
        .json({
          success:
            true,

          mode:
            "POOL_LIST",

          count:
            Array.isArray(rows)
              ? rows.length
              : 0,

          rows:
            Array.isArray(rows)
              ? rows
              : []
        });
    }


    /* ========================================================
       MEMBER PAGE

       SMALL 25-MEMBER ARMLS/RESO REQUEST.

       RETURNS ONLY PHOENIX REALTORS MEMBERS.
       DOES NOT WRITE TO SUPABASE.
    ======================================================== */

    if (
      req.method === "GET" &&
      mode === "member-page"
    ) {
      const skip =
        safeInteger(
          req.query?.skip,
          0,
          0,
          2000000
        );

      const top =
        safeInteger(
          req.query?.top,
          25,
          1,
          25
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
        await sparkRequest(
          url
        );

      const rawMembers =
        Array.isArray(
          data?.value
        )
          ? data.value
          : [];

      const phoenixMembers =
        rawMembers
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

              fullName:
                member?.MemberFullName ??
                [
                  member
                    ?.MemberFirstName,
                  member
                    ?.MemberLastName
                ]
                  .filter(Boolean)
                  .join(" ") ||
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
        .status(200)
        .json({
          success:
            true,

          mode:
            "PHOENIX_REALTORS_MEMBER_PAGE",

          skip,

          requested:
            top,

          scanned:
            rawMembers.length,

          phoenixCount:
            phoenixMembers.length,

          nextSkip:
            skip +
            rawMembers.length,

          endReached:
            rawMembers.length <
            top,

          members:
            phoenixMembers
        });
    }


    /* ========================================================
       SAVE MEMBERS

       SAVES ONLY MEMBERS ALREADY VERIFIED AS
       PHOENIX REALTORS BY MEMBER-PAGE.

       NO ARMLS REQUEST IS MADE HERE.
    ======================================================== */

    if (
      req.method === "POST" &&
      mode === "save-members"
    ) {
      const body =
        await getBody(
          req
        );

      const incoming =
        Array.isArray(
          body?.members
        )
          ? body.members
          : [];

      const members =
        incoming
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
          .status(400)
          .json({
            success:
              false,

            error:
              "No members supplied."
          });
      }

      const now =
        new Date()
          .toISOString();

      const records =
        members.map(
          member => ({
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

            /*
              For now we use OfficeMlsId as the brokerage
              display value.

              We can resolve full brokerage names later.
            */

            office_name:
              clean(
                member.officeMlsId
              ) ||
              null,

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

      const saved =
        await supabaseRequest(
          `${TABLE}` +
          `?on_conflict=member_key`,
          {
            method:
              "POST",

            headers: {
              Prefer:
                "resolution=merge-duplicates,return=representation"
            },

            body:
              JSON.stringify(
                records
              )
          }
        );

      return res
        .status(200)
        .json({
          success:
            true,

          mode:
            "SAVE_MEMBERS",

          received:
            records.length,

          saved:
            Array.isArray(saved)
              ? saved.length
              : 0,

          rows:
            Array.isArray(saved)
              ? saved
              : []
        });
    }


    /* ========================================================
       CALCULATE PRODUCTION

       READS A SMALL BATCH FROM SUPABASE,
       CALCULATES TRANSACTIONS,
       THEN SAVES EACH RESULT.
    ======================================================== */

    if (
      req.method === "POST" &&
      mode ===
        "calculate-production"
    ) {
      const body =
        await getBody(
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
        safeInteger(
          body?.batchSize,
          3,
          1,
          5
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
          .status(400)
          .json({
            success:
              false,

            error:
              "Valid startDate and endDate are required."
          });
      }

      const pending =
        await supabaseRequest(
          `${TABLE}` +
          `?select=*` +
          `&production_status=neq.complete` +
          `&order=created_at.asc` +
          `&limit=${batchSize}`,
          {
            method:
              "GET"
          }
        );

      const rows =
        Array.isArray(
          pending
        )
          ? pending
          : [];

      if (
        !rows.length
      ) {
        return res
          .status(200)
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

      const results =
        [];

      /*
        Do these sequentially on purpose.

        That is slower, but much safer for ARMLS/Vercel
        than firing several count requests simultaneously.
      */

      for (
        const agent of rows
      ) {
        const now =
          new Date()
            .toISOString();

        try {
          const count =
            await countAgentTransactions(
              agent.member_key,
              startDate,
              endDate
            );

          await supabaseRequest(
            `${TABLE}` +
            `?member_key=eq.${encodeURIComponent(
              agent.member_key
            )}`,
            {
              method:
                "PATCH",

              headers: {
                Prefer:
                  "return=minimal"
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
              agent.member_key,

            closedTransactions:
              count,

            status:
              "complete"
          });

        } catch (
          error
        ) {
          const message =
            error?.message ||
            "Production count failed.";

          await supabaseRequest(
            `${TABLE}` +
            `?member_key=eq.${encodeURIComponent(
              agent.member_key
            )}`,
            {
              method:
                "PATCH",

              headers: {
                Prefer:
                  "return=minimal"
              },

              body:
                JSON.stringify({
                  production_status:
                    "error",

                  production_error:
                    message,

                  production_checked_at:
                    now,

                  updated_at:
                    now
                })
            }
          );

          results.push({
            memberKey:
              agent.member_key,

            closedTransactions:
              null,

            status:
              "error",

            error:
              message
          });
        }
      }

      return res
        .status(200)
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


    /* ========================================================
       UNKNOWN MODE
    ======================================================== */

    return res
      .status(400)
      .json({
        success:
          false,

        error:
          `Unknown mode: ${mode}`
      });

  } catch (
    error
  ) {
    console.error(
      "ARMLS agent production API error:",
      error
    );

    /*
      Important:
      Even errors return JSON now.
    */

    return res
      .status(500)
      .json({
        success:
          false,

        error:
          error?.message ||
          "ARMLS agent production API failed."
      });
  }
}

const APP_BASE_URL =
  process.env.APP_BASE_URL ||
  "https://www.bluevera.app";

const CRON_SECRET =
  process.env.CRON_SECRET || "";

function clean(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
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
    if (!CRON_SECRET) {
      return res.status(500).json({
        success: false,
        error:
          "CRON_SECRET is missing."
      });
    }

    /*
      Vercel Cron can send:

      Authorization: Bearer <CRON_SECRET>

      Only allow the scheduled request
      when that secret matches.
    */

    const authHeader =
      clean(
        req.headers?.authorization ||
        ""
      );

    const expected =
      `Bearer ${CRON_SECRET}`;

    if (authHeader !== expected) {
      return res.status(401).json({
        success: false,
        error:
          "Unauthorized cron request."
      });
    }

    /*
      Call the same working ARMLS
      New / Changed verification endpoint.

      That endpoint already decides who
      actually needs checking based on
      armls_last_checked_at.
    */

    const response =
      await fetch(
        `${APP_BASE_URL}/api/admin-armls-agent-standing-run`,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              mode:
                "changed"
            })
        }
      );

    const text =
      await response.text();

    let data;

    try {
      data =
        JSON.parse(text);
    } catch {
      return res.status(502).json({
        success: false,
        error:
          "ARMLS verification endpoint returned invalid JSON.",
        raw:
          text
      });
    }

    if (!response.ok) {
      return res.status(
        response.status
      ).json({
        success: false,

        error:
          data?.error ||
          "Daily ARMLS re-check failed.",

        verificationResponse:
          data
      });
    }

    return res.status(200).json({
      success: true,

      mode:
        "ARMLS_DAILY_RECHECK",

      ranAt:
        new Date().toISOString(),

      verification:
        data
    });

  } catch (error) {
    console.error(
      "ARMLS daily re-check failed:",
      error
    );

    return res.status(500).json({
      success: false,

      error:
        error?.message ||
        "ARMLS daily re-check failed."
    });
  }
}

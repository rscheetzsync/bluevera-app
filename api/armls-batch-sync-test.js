export const config = {
  api: {
    bodyParser: {
      sizeLimit: "1mb"
    }
  }
};

/*
  CONTROLLED ARMLS BATCH TEST

  These are the five MLS numbers we are testing.

  This file deliberately calls the already-tested
  single-listing sync endpoint one listing at a time.

  It does NOT:
  - recalculate ratings
  - update map.html
  - scan all ARMLS listings
  - create uncontrolled batches
*/

const TEST_MLS_NUMBERS = [
  "7064603",
  "7064231",
  "7047308",
  "7032217",
  "7066453"
];


/* ============================================================
   BASIC HELPERS
============================================================ */

function clean(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}


/* ============================================================
   GET BLUEVERA APP BASE URL
============================================================ */

function getBaseUrl(req) {
  /*
    Production should normally resolve to:

    https://www.bluevera.app
  */

  const forwardedProto =
    clean(
      req.headers["x-forwarded-proto"]
    );

  const protocol =
    forwardedProto ||
    "https";

  const forwardedHost =
    clean(
      req.headers["x-forwarded-host"]
    );

  const host =
    forwardedHost ||
    clean(req.headers.host) ||
    "www.bluevera.app";

  return `${protocol}://${host}`;
}


/* ============================================================
   SYNC ONE MLS NUMBER
============================================================ */

async function syncOneListing({
  baseUrl,
  mlsNumber
}) {
  const url =
    `${baseUrl}/api/armls-sync-listing-test` +
    `?mls=${encodeURIComponent(mlsNumber)}`;

  const response =
    await fetch(
      url,
      {
        method:
          "GET",

        headers: {
          Accept:
            "application/json",

          "Cache-Control":
            "no-cache"
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
    data = {
      success:
        false,

      error:
        "Single-listing endpoint returned invalid JSON.",

      rawResponse:
        text
    };
  }

  if (
    !response.ok ||
    !data?.success
  ) {
    return {
      success:
        false,

      mlsNumber,

      statusCode:
        response.status,

      error:
        data?.error ||
        `MLS ${mlsNumber} sync failed.`,

      raw:
        data
    };
  }

  return {
    success:
      true,

    mlsNumber,

    propertyId:
      data?.property?.id ||
      null,

    propertyAction:
      data?.property?.action ||
      null,

    matchType:
      data?.property?.matchType ||
      null,

    address:
      data?.property?.address ||
      null,

    apn:
      data?.property?.apn ||
      null,

    propertyListingId:
      data?.propertyListing?.id ||
      null,

    listingStatus:
      data?.propertyListing?.status ||
      null,

    listPrice:
      data?.propertyListing?.listPrice ??
      null,

    modificationTimestamp:
      data?.propertyListing
        ?.modificationTimestamp ||
      null,

    updatesFound:
      Number(
        data?.updatesFound ||
        0
      ),

    historyResults:
      Array.isArray(
        data?.historyResults
      )
        ? data.historyResults
        : [],

    ratingRecalculated:
      data?.ratingRecalculated === true,

    mapUpdated:
      data?.mapUpdated === true,

    protections:
      data?.protections ||
      null
  };
}


/* ============================================================
   MAIN
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
    const baseUrl =
      getBaseUrl(req);

    const results =
      [];


    /*
      IMPORTANT:

      Run these SEQUENTIALLY rather than all five
      simultaneously.

      This makes the first controlled batch easier
      to inspect and reduces unnecessary concurrency
      while we are still testing.
    */

    for (
      const mlsNumber
      of TEST_MLS_NUMBERS
    ) {
      console.log(
        `Starting controlled ARMLS sync for MLS ${mlsNumber}`
      );

      const result =
        await syncOneListing({
          baseUrl,
          mlsNumber
        });

      results.push(
        result
      );

      console.log(
        `Finished MLS ${mlsNumber}:`,
        result.success
          ? "SUCCESS"
          : "FAILED"
      );
    }


    /* --------------------------------------------------------
       BUILD SUMMARY
    -------------------------------------------------------- */

    const successful =
      results.filter(
        item =>
          item.success
      );

    const failed =
      results.filter(
        item =>
          !item.success
      );

    const createdProperties =
      successful.filter(
        item =>
          item.propertyAction ===
          "created_new_property"
      );

    const matchedProperties =
      successful.filter(
        item =>
          item.propertyAction ===
          "matched_existing"
      );

    const raceRecovered =
      successful.filter(
        item =>
          item.propertyAction ===
          "matched_existing_after_insert_conflict"
      );

    const totalUpdatesFound =
      successful.reduce(
        (
          total,
          item
        ) =>
          total +
          Number(
            item.updatesFound ||
            0
          ),
        0
      );

    const totalHistoryResults =
      successful.reduce(
        (
          total,
          item
        ) =>
          total +
          (
            Array.isArray(
              item.historyResults
            )
              ? item.historyResults.length
              : 0
          ),
        0
      );


    /* --------------------------------------------------------
       SAFETY VERIFICATION

       These should remain FALSE during this test.
    -------------------------------------------------------- */

    const anyRatingRecalculated =
      successful.some(
        item =>
          item.ratingRecalculated === true
      );

    const anyMapUpdated =
      successful.some(
        item =>
          item.mapUpdated === true
      );


    /* --------------------------------------------------------
       RESPONSE
    -------------------------------------------------------- */

    return res
      .status(
        failed.length > 0
          ? 207
          : 200
      )
      .json({
        success:
          failed.length === 0,

        mode:
          "CONTROLLED_FIVE_LISTING_BATCH_TEST",

        requestedMlsNumbers:
          TEST_MLS_NUMBERS,

        summary: {
          requested:
            TEST_MLS_NUMBERS.length,

          successful:
            successful.length,

          failed:
            failed.length,

          propertiesCreated:
            createdProperties.length,

          propertiesMatched:
            matchedProperties.length,

          propertyInsertConflictsRecovered:
            raceRecovered.length,

          totalUpdatesFound,

          totalHistoryResults,

          ratingRecalculated:
            anyRatingRecalculated,

          mapUpdated:
            anyMapUpdated
        },

        results,

        note:
          "Controlled ARMLS batch completed by using the existing single-listing sync sequentially. No rating recalculation or map update should occur."
      });

  } catch (error) {
    console.error(
      "Controlled ARMLS batch test failed:",
      error
    );

    return res
      .status(500)
      .json({
        success:
          false,

        mode:
          "CONTROLLED_FIVE_LISTING_BATCH_TEST",

        error:
          error?.message ||
          "Controlled ARMLS batch test failed."
      });
  }
}

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "1mb"
    }
  }
};

const SPARK_BASE =
  "https://replication.sparkapi.com/v1";

function clean(value) {
  return String(value ?? "").trim();
}

function validYear(value) {
  const year = Number(clean(value));

  const currentYear =
    new Date().getFullYear();

  return (
    Number.isInteger(year) &&
    year >= 1800 &&
    year <= currentYear + 1
  );
}

/*
  ARMLS CustomFields are nested several levels deep.

  This searches recursively for an exact field label such as:
  "Roof Yr Updated"
*/
function findCustomField(
  customFields,
  label
) {
  function search(value) {
    if (
      value === null ||
      value === undefined
    ) {
      return null;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const found =
          search(item);

        if (found !== null) {
          return found;
        }
      }

      return null;
    }

    if (typeof value === "object") {
      if (
        Object.prototype
          .hasOwnProperty.call(
            value,
            label
          )
      ) {
        return value[label];
      }

      for (
        const child
        of Object.values(value)
      ) {
        const found =
          search(child);

        if (found !== null) {
          return found;
        }
      }
    }

    return null;
  }

  return search(customFields);
}

function getUpdateFields(customFields) {
  return {
    floor: {
      year:
        findCustomField(
          customFields,
          "Floor Yr Updated"
        ),

      scope:
        findCustomField(
          customFields,
          "Floor Partial/Full"
        )
    },

    wiring: {
      year:
        findCustomField(
          customFields,
          "Wiring Yr Updated"
        ),

      scope:
        findCustomField(
          customFields,
          "Wiring Partial/Full"
        )
    },

    plumbing: {
      year:
        findCustomField(
          customFields,
          "Plmbg Yr Updated"
        ),

      scope:
        findCustomField(
          customFields,
          "Plmbg Partial/Full"
        )
    },

    hvac: {
      year:
        findCustomField(
          customFields,
          "Ht/Cool Yr Updated"
        ),

      scope:
        findCustomField(
          customFields,
          "Ht/Cool Partial/Full"
        )
    },

    roof: {
      year:
        findCustomField(
          customFields,
          "Roof Yr Updated"
        ),

      scope:
        findCustomField(
          customFields,
          "Roof Partial/Full"
        )
    },

    kitchen: {
      year:
        findCustomField(
          customFields,
          "Kitchen Yr Updated"
        ),

      scope:
        findCustomField(
          customFields,
          "Kitchen Partial/Full"
        )
    },

    baths: {
      year:
        findCustomField(
          customFields,
          "Bath(s) Yr Updated"
        ),

      scope:
        findCustomField(
          customFields,
          "Bath(s) Partial/Full"
        )
    },

    roomAddition: {
      year:
        findCustomField(
          customFields,
          "Rm Adtn Yr Updated"
        ),

      scope:
        findCustomField(
          customFields,
          "Rm Adtn Partial/Full"
        )
    },

    pool: {
      year:
        findCustomField(
          customFields,
          "Pool Yr Updated"
        ),

      scope:
        findCustomField(
          customFields,
          "Pool Partial/Full"
        )
    }
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

  try {
    const token =
      process.env.SPARK_ACCESS_TOKEN;

    if (!token) {
      return res.status(500).json({
        success: false,
        error:
          "SPARK_ACCESS_TOKEN is missing"
      });
    }

    /*
      Start with 1000 listings.

      This is intentionally NOT all 38,076 yet.
      First we verify that the ARMLS update
      fields are coming through correctly.
    */
    const limit = 1000;

    const filter =
      "StandardStatus Eq 'Active'";

    const url =
      `${SPARK_BASE}/listings` +
      `?_filter=${encodeURIComponent(
        filter
      )}` +
      `&_limit=${limit}` +
      `&_page=1` +
      `&_expand=CustomFields`;

    const response =
      await fetch(url, {
        method: "GET",

        headers: {
          Authorization:
            `Bearer ${token}`,

          Accept:
            "application/json"
        }
      });

    const text =
      await response.text();

    let data = null;

    try {
      data =
        text
          ? JSON.parse(text)
          : null;
    } catch {
      return res.status(502).json({
        success: false,
        error:
          "Spark returned invalid JSON",
        raw:
          text.slice(0, 2000)
      });
    }

    if (!response.ok) {
      return res.status(502).json({
        success: false,
        error:
          data?.D?.Message ||
          data?.message ||
          "Spark request failed",
        sparkResponse:
          data
      });
    }

    const listings =
      Array.isArray(
        data?.D?.Results
      )
        ? data.D.Results
        : [];

    const categoryCounts = {
      floor: 0,
      wiring: 0,
      plumbing: 0,
      hvac: 0,
      roof: 0,
      kitchen: 0,
      baths: 0,
      roomAddition: 0,
      pool: 0
    };

    let listingsWithAnyUpdate = 0;
    let totalValidUpdateYears = 0;

    const samples = [];

    for (const listing of listings) {
      const fields =
        listing?.StandardFields ||
        listing ||
        {};

      const customFields =
        listing?.CustomFields ||
        fields?.CustomFields ||
        {};

      const updates =
        getUpdateFields(
          customFields
        );

      const validUpdates = {};

      for (
        const [
          category,
          update
        ]
        of Object.entries(updates)
      ) {
        if (
          validYear(update?.year)
        ) {
          categoryCounts[
            category
          ] += 1;

          totalValidUpdateYears += 1;

          validUpdates[
            category
          ] = {
            year:
              Number(update.year),

            scope:
              clean(update.scope) ||
              null
          };
        }
      }

      const updateCount =
        Object.keys(
          validUpdates
        ).length;

      if (updateCount > 0) {
        listingsWithAnyUpdate += 1;

        /*
          Keep only a few examples so
          the browser response stays small.
        */
        if (samples.length < 15) {
          samples.push({
            mlsNumber:
              fields.ListingId ||
              fields.MlsId ||
              null,

            address:
              fields.UnparsedAddress ||
              [
                fields.StreetNumber,
                fields.StreetDirPrefix,
                fields.StreetName,
                fields.StreetSuffix,
                fields.City
              ]
                .filter(Boolean)
                .join(" ") ||
              null,

            updateCount,

            updates:
              validUpdates
          });
        }
      }
    }

    const percentage =
      listings.length
        ? Number(
            (
              (
                listingsWithAnyUpdate /
                listings.length
              ) * 100
            ).toFixed(2)
          )
        : 0;

    return res
      .status(200)
      .json({
        success: true,

        testType:
          "ARMLS active listing update-year scan",

        activeListingsKnown:
          38076,

        listingsScanned:
          listings.length,

        listingsWithAnyUpdate,

        percentWithAnyUpdate:
          percentage,

        totalValidUpdateYears,

        categoryCounts,

        samples,

        note:
          "This test scans only the first 1,000 Active ARMLS listings. No data is written to Supabase."
      });

  } catch (error) {
    console.error(
      "ARMLS listing update test failed:",
      error
    );

    return res
      .status(500)
      .json({
        success: false,
        error:
          error?.message ||
          "ARMLS listing update test failed"
      });
  }
}

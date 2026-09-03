const SPARK_BASE =
  "https://replication.sparkapi.com/v1";

function clean(value) {
  return String(value ?? "").trim();
}

function validZip(value) {
  return /^\d{5}$/.test(clean(value));
}

function safeLimit(value) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed)) {
    return 250;
  }

  return Math.min(
    Math.max(parsed, 1),
    1000
  );
}

function listingAddress(fields) {
  return (
    clean(fields?.UnparsedAddress) ||
    [
      fields?.StreetNumber,
      fields?.StreetDirPrefix,
      fields?.StreetName,
      fields?.StreetSuffix,
      fields?.City,
      fields?.StateOrProvince,
      fields?.PostalCode
    ]
      .map(clean)
      .filter(Boolean)
      .join(" ")
  );
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

  if (req.method !== "GET") {
    res.setHeader(
      "Allow",
      "GET"
    );

    return res.status(405).json({
      success: false,
      error:
        "Method not allowed."
    });
  }

  try {
    const token =
      process.env.SPARK_ACCESS_TOKEN;

    if (!token) {
      return res.status(500).json({
        success: false,
        error:
          "SPARK_ACCESS_TOKEN is missing."
      });
    }

    const zip =
      clean(req.query?.zip);

    if (!validZip(zip)) {
      return res.status(400).json({
        success: false,
        error:
          "A valid 5-digit ZIP code is required."
      });
    }

    const limit =
      safeLimit(req.query?.limit);

    /*
      Preview-only discovery call.

      No Supabase writes happen here.
      The returned MLS numbers can be
      deliberately loaded into the
      controlled intake batch afterward.
    */

    const filter =
      `StandardStatus Eq 'Active' And PostalCode Eq '${zip}'`;

    const url =
      `${SPARK_BASE}/listings` +
      `?_filter=${encodeURIComponent(filter)}` +
      `&_limit=${limit}` +
      `&_page=1`;

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
      return res.status(502).json({
        success: false,
        error:
          "Spark returned invalid JSON.",
        raw:
          text.slice(0, 1500)
      });
    }

    if (!response.ok) {
      return res.status(502).json({
        success: false,
        error:
          data?.D?.Message ||
          data?.message ||
          "Spark ZIP-code listing request failed.",
        sparkResponse:
          data
      });
    }

    const results =
      Array.isArray(data?.D?.Results)
        ? data.D.Results
        : [];

    const listings =
      results
        .map((listing) => {
          const fields =
            listing?.StandardFields ||
            listing ||
            {};

          return {
            mlsNumber:
              clean(
                fields?.ListingId ||
                fields?.MlsId
              ) || null,

            listingKey:
              clean(
                fields?.ListingKey
              ) || null,

            status:
              clean(
                fields?.StandardStatus
              ) || "Active",

            address:
              listingAddress(fields) || null,

            city:
              clean(fields?.City) || null,

            state:
              clean(
                fields?.StateOrProvince
              ) || null,

            zip:
              clean(
                fields?.PostalCode
              ) || zip,

            modificationTimestamp:
              fields?.ModificationTimestamp ||
              null
          };
        })
        .filter(
          (listing) =>
            Boolean(listing.mlsNumber)
        );

    return res.status(200).json({
      success: true,

      zip,

      requestedLimit:
        limit,

      count:
        listings.length,

      truncated:
        listings.length >= limit,

      listings,

      note:
        "Preview only. No Supabase records were created or changed."
    });

  } catch (error) {
    console.error(
      "ARMLS ZIP listing lookup failed:",
      error
    );

    return res.status(500).json({
      success: false,

      error:
        error?.message ||
        "ARMLS ZIP listing lookup failed."
    });
  }
}

export default async function handler(req, res) {
  try {
    const sparkToken = process.env.SPARK_ACCESS_TOKEN;

    if (!sparkToken) {
      return res.status(500).json({
        success: false,
        error: "SPARK_ACCESS_TOKEN is missing"
      });
    }

    const filter = "StandardStatus Eq 'Active'";

    const url =
      "https://replication.sparkapi.com/v1/listings?_filter=" +
      encodeURIComponent(filter) +
      "&_limit=1";

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${sparkToken}`,
        Accept: "application/json"
      }
    });

    const text = await response.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      return res.status(502).json({
        success: false,
        error: "Spark returned invalid JSON",
        raw: text
      });
    }

    if (!response.ok) {
      return res.status(502).json({
        success: false,
        error:
          data?.D?.Message ||
          "Spark listing request failed",
        response: data
      });
    }

    return res.status(200).json({
      success: true,
      filter,
      sparkResponse: data
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error:
        error?.message ||
        "Active listing count test failed"
    });
  }
}

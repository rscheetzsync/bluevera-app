export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Authentication required"
      });
    }

    const mlsNumber = String(req.body?.mlsNumber || "").trim();

    if (!/^[A-Za-z0-9-]{3,30}$/.test(mlsNumber)) {
      return res.status(400).json({
        success: false,
        error: "Enter a valid MLS number"
      });
    }

    const upstream = await fetch(
      "https://bluevera.org/api/armls-listing",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": authHeader,
          "Accept": "application/json"
        },
        body: JSON.stringify({
          mlsNumber
        })
      }
    );

    const text = await upstream.text();

    res.status(upstream.status);
    res.setHeader(
      "Content-Type",
      "application/json; charset=utf-8"
    );

    return res.send(text);

  } catch (error) {
    console.error(
      "ARMLS debug proxy error:",
      error
    );

    return res.status(500).json({
      success: false,
      error: "ARMLS debug proxy failed"
    });
  }
}

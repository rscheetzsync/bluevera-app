export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      stage: "proxy",
      error: "Method not allowed"
    });
  }

  try {
    const mlsNumber = String(req.body?.mlsNumber || "").trim();
    const token = String(req.body?.token || "").trim();

    if (!token) {
      return res.status(401).json({
        success: false,
        stage: "bluevera-app-proxy",
        error: "Token did not reach proxy"
      });
    }

    if (!/^[A-Za-z0-9-]{3,30}$/.test(mlsNumber)) {
      return res.status(400).json({
        success: false,
        stage: "bluevera-app-proxy",
        error: "Enter a valid MLS number"
      });
    }

    const upstream = await fetch(
      "https://bluevera.org/api/armls-listing",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
          "Accept": "application/json"
        },
        body: JSON.stringify({
          mlsNumber
        })
      }
    );

    const text = await upstream.text();

    let upstreamData;

    try {
      upstreamData = JSON.parse(text);
    } catch {
      upstreamData = {
        rawResponse: text
      };
    }

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        success: false,
        stage: "bluevera-org-armls-listing",
        upstreamStatus: upstream.status,
        upstreamResponse: upstreamData
      });
    }

    return res.status(200).json(upstreamData);

  } catch (error) {
    console.error("ARMLS debug proxy error:", error);

    return res.status(500).json({
      success: false,
      stage: "proxy-exception",
      error: "ARMLS debug proxy failed"
    });
  }
}

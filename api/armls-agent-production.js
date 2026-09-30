export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store, max-age=0");

  return res.status(200).json({
    success: true,
    message: "Agent Production API is running",
    environment: {
      spark: Boolean(process.env.SPARK_ACCESS_TOKEN),
      supabaseUrl: Boolean(process.env.SUPABASE_URL),
      serviceRoleKey: Boolean(
        process.env.SUPABASE_SERVICE_ROLE_KEY
      ),
      supabaseSecretKey: Boolean(
        process.env.SUPABASE_SECRET_KEY
      )
    }
  });
}

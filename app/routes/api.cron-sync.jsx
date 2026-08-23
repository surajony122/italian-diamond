// Using standard Response objects for React Router V7
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { runBulkSync } from "../services/syncEngine";
import { fetchLiveGoldRate } from "../services/goldApi";

// This endpoint is intended to be called by an external cron service (e.g. Render Cron Job,
// GitHub Actions schedule, cron-job.org) to trigger a bulk price sync for every installed shop.
// It is unauthenticated Shopify-wise (no admin session), so it MUST be protected by CRON_SECRET.
export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  if (!process.env.CRON_SECRET) {
    console.error("CRON_SECRET is not set - refusing to run /api/cron-sync. Set CRON_SECRET in your environment.");
    return Response.json({ error: "Cron sync is not configured" }, { status: 500 });
  }

  const url = new URL(request.url);
  const secret = url.searchParams.get("secret");

  if (secret !== process.env.CRON_SECRET) {
    return Response.json({ error: "Unauthorized cron execution" }, { status: 401 });
  }

  // Find all configured shops
  const allSettings = await prisma.appSettings.findMany();

  let totalSynced = 0;
  const results = [];

  for (const settings of allSettings) {
    try {
      // Load an offline (background) admin session for this shop, stored the first time
      // the merchant installed/authenticated the app.
      const { admin } = await unauthenticated.admin(settings.shop);

      // Auto fetch live rate if mode is "auto"
      if (settings.goldApiMode === "auto") {
        const liveRate = await fetchLiveGoldRate(settings.goldApiKey);
        settings.goldRate = liveRate;
        await prisma.appSettings.update({
          where: { shop: settings.shop },
          data: { goldRate: liveRate }
        });
      }

      // Run bulk sync
      const count = await runBulkSync(admin, settings);

      await prisma.appSettings.update({
        where: { shop: settings.shop },
        data: { lastSyncTime: new Date() }
      });

      totalSynced += count;
      results.push({ shop: settings.shop, success: true, count });

    } catch (e) {
      console.error(`Cron sync failed for ${settings.shop}:`, e);
      results.push({ shop: settings.shop, success: false, error: e.message });
    }
  }

  return Response.json({ success: true, totalSynced, results });
};

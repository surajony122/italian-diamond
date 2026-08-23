import cron from "node-cron";
import prisma from "./db.server";
import { runBulkSync } from "./services/syncEngine";
import shopify from "./shopify.server";

// Ensure this only runs once by using the global object in development
if (!global.__schedulerInitialized) {
  global.__schedulerInitialized = true;

  console.log("Starting Nightly Sync Scheduler...");

  // Run at Midnight (00:00) every day
  cron.schedule("0 0 * * *", async () => {
    console.log("[Scheduler] Running Nightly Bulk Sync...");
    try {
      const shops = await prisma.session.findMany({
        where: { isOnline: false }, // Use offline sessions for background tasks
        select: { shop: true }
      });

      // Get unique shops
      const uniqueShops = [...new Set(shops.map(s => s.shop))];

      for (const shop of uniqueShops) {
        const appSettings = await prisma.appSettings.findUnique({ where: { shop } });
        if (!appSettings) continue;

        // Load an offline session to instantiate the GraphQL client
        const offlineSessionId = shopify.session.getOfflineId(shop);
        const session = await shopify.config.sessionStorage.loadSession(offlineSessionId);
        
        if (session) {
          const client = new shopify.clients.Graphql({ session });
          console.log(`[Scheduler] Syncing for ${shop}...`);
          
          // Note: runBulkSync expects `admin` object with a `graphql` method
          // We can mock it to use the Graphql client directly
          const mockAdmin = {
            graphql: async (query, { variables }) => {
              const res = await client.request(query, { variables });
              // Mock response format expected by runBulkSync
              return { json: async () => ({ data: res.data || res }) }; 
            }
          };

          await runBulkSync(mockAdmin, appSettings);
          console.log(`[Scheduler] Sync completed for ${shop}`);
        }
      }
    } catch (error) {
      console.error("[Scheduler] Error running nightly sync:", error);
    }
  });
}

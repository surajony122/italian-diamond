import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { syncVariantPage, syncProductIdBatch } from "../services/syncEngine";

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const cursor = formData.get("cursor") || null;
  const onlyUnsynced = formData.get("onlyUnsynced") === "true";
  const productIdsParam = formData.get("productIds"); // JSON array - present for a scoped (active/collection) sync batch

  try {
    const appSettings = await prisma.appSettings.findUnique({ where: { shop: session.shop } });
    if (!appSettings) {
      return new Response(JSON.stringify({ success: false, error: "Settings not found" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }

    // Scoped sync: the frontend already resolved the full product ID list up front
    // (via /api/resolve-sync-scope) and is sending us one batch at a time. There's no
    // Shopify cursor to manage here - hasNextPage is decided by the frontend based on
    // whether it has more of its own batches left.
    if (productIdsParam) {
      let productIds;
      try {
        productIds = JSON.parse(productIdsParam);
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: "Invalid productIds" }), { status: 400, headers: { "Content-Type": "application/json" } });
      }

      const result = await syncProductIdBatch(admin, appSettings, productIds, session.shop, "Scoped Sync");
      return new Response(JSON.stringify({
        success: true,
        variantsProcessed: result.variantsProcessed,
        productIds: result.productIds,
      }), { headers: { "Content-Type": "application/json" } });
    }

    // 25 was very conservative and meant 1,676+ sequential page requests on a large
    // catalog (confirmed: this store has ~41,906 variants). 250 is Shopify's hard cap
    // for `first` on this connection (confirmed directly against this store: costs
    // only ~101 of the 2000-point budget per page, and pageSize 500 is flatly
    // rejected by Shopify itself with "first cannot exceed 250") - cuts total requests
    // by ~10x with real evidence it's safe, not just an educated guess.
    const result = await syncVariantPage(admin, appSettings, {
      cursor,
      pageSize: 250,
      shop: session.shop,
      reason: "Bulk API Chunk",
      onlyUnsynced
    });

    // Only fetch the total on the first call (cursor null) - the frontend caches it for
    // the rest of the run so the real-time progress bar has an actual denominator
    // ("X of Y products") instead of guessing at a fake percentage.
    let totalProducts = null;
    if (!cursor) {
      try {
        const countRes = await admin.graphql(`query { productsCount { count } }`);
        const countData = await countRes.json();
        totalProducts = countData.data.productsCount.count;
      } catch (e) {
        console.error("Failed to fetch productsCount:", e);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      hasNextPage: result.hasNextPage,
      nextCursor: result.nextCursor,
      variantsProcessed: result.variantsProcessed,
      productIds: result.productIds,
      totalProducts
    }), { headers: { "Content-Type": "application/json" } });

  } catch (error) {
    console.error("SYNC CHUNK ERROR:", error);
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
};

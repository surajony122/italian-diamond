import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { syncVariantPage } from "../services/syncEngine";

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const cursor = formData.get("cursor") || null;

  try {
    const appSettings = await prisma.appSettings.findUnique({ where: { shop: session.shop } });
    if (!appSettings) {
      return new Response(JSON.stringify({ success: false, error: "Settings not found" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }

    const result = await syncVariantPage(admin, appSettings, {
      cursor,
      pageSize: 25,
      shop: session.shop,
      reason: "Bulk API Chunk"
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

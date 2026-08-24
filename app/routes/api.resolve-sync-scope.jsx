import { authenticate } from "../shopify.server";
import { resolveScopeToProductIds } from "../services/syncEngine";

// Resolves a sync scope (status filter and/or collection) into the full list of
// numeric product IDs it matches. The frontend calls this ONCE at the start of a
// scoped sync, then slices the returned list into batches itself, calling
// /api/sync-chunk with a productIds batch per call (see app.products.jsx).
export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const statusFilter = formData.get("statusFilter") || null;
  const collectionId = formData.get("collectionId") || null;

  try {
    const productIds = await resolveScopeToProductIds(admin, { statusFilter, collectionId });
    return new Response(JSON.stringify({ success: true, productIds, totalProducts: productIds.length }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    console.error("RESOLVE SYNC SCOPE ERROR:", error);
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
};

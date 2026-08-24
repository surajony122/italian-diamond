import { calculateFinalPrice, parseDiamondText } from "./pricing";
import prisma from "../db.server";

const BULK_UPDATE_MUTATION = `
  mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      userErrors { field message }
    }
  }
`;

/**
 * Runs admin.graphql(query, variables) with retry-with-backoff, correctly distinguishing
 * "genuinely rate-limited, needs real time to recover" from "random transient blip" -
 * confirmed from production logs that admin.graphql() THROWS an exception whose message
 * contains "Throttled" for the rate-limit case (not a normal response with an in-body
 * error), so a fixed short backoff treating both cases the same way wasn't enough: under
 * this store's sustained sync load, Shopify's bucket needs real seconds to refill, not
 * milliseconds. Also handles the in-body THROTTLED case and raw network failures
 * (fetch failed / connection reset), for whichever shape a given failure comes back as.
 */
async function graphqlWithRetry(admin, query, variables, label, { maxAttempts = 6 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let json;
    try {
      const res = await admin.graphql(query, { variables });
      json = await res.json();
    } catch (e) {
      const isThrottled = /throttled/i.test(e.message || "");
      if (attempt < maxAttempts) {
        // Exponential backoff with a real ceiling for genuine throttling (up to ~16s),
        // shorter for plain network blips - a fixed 500ms*attempt was too short for
        // Shopify's bucket to actually recover under sustained concurrent load.
        const delay = isThrottled
          ? Math.min(2000 * 2 ** (attempt - 1), 16000)
          : Math.min(500 * attempt, 4000);
        await new Promise(resolve => setTimeout(resolve, delay + Math.random() * 300));
        continue;
      }
      throw new Error(`${label}: failed after ${maxAttempts} attempts: ${e.message}`);
    }

    const isThrottled = json.errors?.some(e => e.extensions?.code === "THROTTLED");
    if (isThrottled && attempt < maxAttempts) {
      const delay = Math.min(2000 * 2 ** (attempt - 1), 16000);
      await new Promise(resolve => setTimeout(resolve, delay + Math.random() * 300));
      continue;
    }

    return json;
  }
}

/**
 * Runs productVariantsBulkUpdate for one product via graphqlWithRetry.
 */
async function bulkUpdateProductVariants(admin, productId, variantsChunk, errorPrefix) {
  const mutData = await graphqlWithRetry(admin, BULK_UPDATE_MUTATION, { productId, variants: variantsChunk }, errorPrefix);

  const result = mutData.data?.productVariantsBulkUpdate;
  if (!result) {
    throw new Error(`${errorPrefix}: no data returned for product ${productId} (${JSON.stringify(mutData.errors || mutData)})`);
  }
  if (result.userErrors.length > 0) {
    console.error(`${errorPrefix.toUpperCase()} ERRORS:`, JSON.stringify(result.userErrors, null, 2));
    throw new Error(`${errorPrefix}: ` + result.userErrors[0].message);
  }
}

/**
 * Runs async fn over items with at most `limit` concurrent in flight, instead of firing
 * everything at once. A single sync page can span dozens of distinct products (up to
 * 250 variants/page); unbounded Promise.all fired that many simultaneous outbound
 * connections from one Render instance and caused raw network-level "fetch failed"
 * errors under load - confirmed directly from production logs.
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

const GET_VARIANTS_FOR_SYNC_QUERY = `
  query GetVariants($cursor: String, $pageSize: Int!, $query: String) {
    productVariants(first: $pageSize, after: $cursor, query: $query) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          price
          title
          product {
            id
            title
            status
            diamondInfo1: metafield(namespace: "custom", key: "diamond") { value }
            diamondInfo2: metafield(namespace: "custom", key: "diamond_info") { value }
          }
          selectedOptions {
            name
            value
          }
          inventoryItem {
            measurement {
              weight {
                value
              }
            }
          }
          goldWeight: metafield(namespace: "custom", key: "gold_weight") { value }
          diamondPrice: metafield(namespace: "custom", key: "diamond_price") { value }
          originalPrice: metafield(namespace: "custom", key: "original_price") { value }
          priceBreakdown: metafield(namespace: "custom", key: "price_breakdown") { value }
        }
      }
    }
  }
`;

/**
 * Fetches and reprices a single page of variants, then writes the results back
 * to Shopify (price, compareAtPrice, and metafields) and the audit log.
 *
 * This is the single shared core used by BOTH:
 *  - the UI-driven chunked sync (`/api/sync-chunk`, pageSize 25, one page per HTTP call)
 *  - the unattended bulk sync (`runBulkSync` below, pageSize 250, loops internally)
 * so pricing/backup logic can never drift between the two entry points again.
 *
 * Safety net: any variant that doesn't yet have a `custom.original_price` backup
 * gets one written in the SAME mutation that changes its price, so a price is
 * never overwritten without a recoverable original on file.
 */
export async function syncVariantPage(admin, appSettings, { cursor = null, pageSize = 25, shop, reason = "Bulk Sync", query = null, onlyUnsynced = false } = {}) {
  const data = await graphqlWithRetry(admin, GET_VARIANTS_FOR_SYNC_QUERY, { cursor, pageSize, query }, "Sync page query");

  // Defensive check: a query that costs more than Shopify's per-request cap gets
  // rejected outright (data: null, a top-level error) - this is a hard cost-cap
  // rejection, not something retrying helps with, so graphqlWithRetry doesn't retry
  // it, but we still want a clear, actionable message rather than a null-property crash.
  if (!data.data?.productVariants) {
    const isCostError = data.errors?.some(e => /cost/i.test(e.message || ""));
    throw new Error(
      isCostError
        ? `Sync page query (pageSize ${pageSize}) exceeded Shopify's per-request cost limit - try a smaller pageSize.`
        : `Sync page query failed: ${JSON.stringify(data.errors || data)}`
    );
  }

  const variants = data.data.productVariants.edges;

  let variantsToUpdate = [];
  let auditLogs = [];
  let variantsProcessed = 0;

  for (const edge of variants) {
    const variant = edge.node;
    variantsProcessed++;

    // ONLY process ACTIVE products
    if (variant.product.status !== "ACTIVE") continue;

    // "Not Yet Synced" scope: skip anything that already has a real price_breakdown -
    // no metafield presence check isn't quite enough since a corrupt/unparseable value
    // shouldn't count as "already synced".
    if (onlyUnsynced && variant.priceBreakdown?.value) {
      try {
        JSON.parse(variant.priceBreakdown.value);
        continue; // parses fine - genuinely already synced, skip it
      } catch (e) {
        // falls through and gets (re)synced below
      }
    }

    let effectiveGoldWeight = null;
    if (variant.goldWeight && variant.goldWeight.value) {
      effectiveGoldWeight = variant.goldWeight.value;
    } else if (variant.inventoryItem?.measurement?.weight?.value) {
      effectiveGoldWeight = variant.inventoryItem.measurement.weight.value.toString();
    }

    if (!effectiveGoldWeight) continue;

    let rawDiamondPrice = variant.price;
    let needsDiamondPriceBackup = false;

    if (variant.diamondPrice && variant.diamondPrice.value) {
      rawDiamondPrice = variant.diamondPrice.value;
    } else {
      // If it has NO diamond price backed up (like a newly created product), we trigger auto-backup
      needsDiamondPriceBackup = true;
    }

    // Ignore manual backend price and strictly use 0 as the default.
    let diamondPrice = 0;
    const goldWeight = parseFloat(effectiveGoldWeight);

    // -- SMART TEXT PARSER LOGIC --
    const diamondInfoText = variant.product.diamondInfo1?.value || variant.product.diamondInfo2?.value || "";

    const parserResult = parseDiamondText(
      diamondInfoText,
      appSettings.diamondBasePrice || 26000,
      appSettings.shapeMarkups || {},
      appSettings.defaultShapeMarkupPercent ?? 25
    );
    let parsedDiamonds = parserResult.parsedDiamonds;
    let diamondParsingError = parserResult.diamondParsingError;

    if (parsedDiamonds.length > 0 && !diamondParsingError) {
      diamondPrice = parserResult.calculatedDiamondPrice;
    }
    // -- END SMART PARSER --

    if ((isNaN(diamondPrice) && !parsedDiamonds.length) || isNaN(goldWeight) || goldWeight === 0) continue;

    // Karat Multiplier Logic
    let karatMultiplier = 1.0;
    let detectedKarat = "24K"; // Default

    const optionValues = variant.selectedOptions.map(o => o.value.toUpperCase());
    if (optionValues.some(v => v.includes("9K") || v.includes("9 KT"))) { karatMultiplier = 0.375; detectedKarat = "9K"; }
    else if (optionValues.some(v => v.includes("10K") || v.includes("10 KT"))) { karatMultiplier = 0.4167; detectedKarat = "10K"; }
    else if (optionValues.some(v => v.includes("14K") || v.includes("14 KT"))) { karatMultiplier = 0.5833; detectedKarat = "14K"; }
    else if (optionValues.some(v => v.includes("18K") || v.includes("18 KT"))) { karatMultiplier = 0.7500; detectedKarat = "18K"; }
    else if (optionValues.some(v => v.includes("22K") || v.includes("22 KT"))) { karatMultiplier = 0.9167; detectedKarat = "22K"; }
    else if (optionValues.some(v => v.includes("24K") || v.includes("24 KT"))) { karatMultiplier = 1.0; detectedKarat = "24K"; }

    const variantGoldRate = appSettings.goldRate * karatMultiplier;

    const calculated = calculateFinalPrice({
      diamondPrice,
      goldWeight,
      goldRate: variantGoldRate, // Use karat-adjusted rate
      makingChargePerGram: appSettings.makingChargePerGram,
      gstPercentage: appSettings.gstPercentage
    });

    // Add raw settings into the calculated object for the frontend block to display
    calculated.settings = {
      goldRate: variantGoldRate.toFixed(2),
      makingChargePerGram: appSettings.makingChargePerGram,
      gstPercentage: appSettings.gstPercentage,
      goldWeight: goldWeight,
      karat: detectedKarat
    };

    if (parsedDiamonds.length > 0) {
      calculated.parsedDiamonds = parsedDiamonds;
    }
    if (diamondParsingError) {
      calculated.diamondParsingError = true;
    }

    const metafieldsToSave = [
      {
        namespace: "custom",
        key: "price_breakdown",
        type: "json",
        value: JSON.stringify(calculated)
      }
    ];

    // Perform auto-backup of the cached diamond price if necessary
    if (needsDiamondPriceBackup) {
      metafieldsToSave.push({
        namespace: "custom",
        key: "diamond_price",
        type: "number_decimal",
        value: rawDiamondPrice.toString()
      });
    }

    // Guaranteed safety net: back up the ORIGINAL price before we ever overwrite it.
    // Runs on every sync entry point (UI chunk sync, dashboard sync, cron) since they
    // all now go through this one function.
    if (!variant.originalPrice || !variant.originalPrice.value) {
      metafieldsToSave.push({
        namespace: "custom",
        key: "original_price",
        type: "number_decimal",
        value: variant.price.toString()
      });
    }

    variantsToUpdate.push({
      id: variant.id,
      productId: variant.product.id,
      price: calculated.finalPrice.toString(),
      compareAtPrice: calculated.compareAtPrice.toString(),
      metafields: metafieldsToSave
    });

    // Push to audit log
    auditLogs.push({
      shop: shop || appSettings.shop,
      productId: variant.product.id,
      variantId: variant.id,
      title: `${variant.product.title} - ${variant.title}`,
      oldPrice: parseFloat(variant.price),
      newPrice: calculated.finalPrice,
      reason
    });
  }

  if (variantsToUpdate.length > 0) {
    const grouped = {};
    for (const update of variantsToUpdate) {
      if (!grouped[update.productId]) grouped[update.productId] = [];
      grouped[update.productId].push({
        id: update.id,
        price: update.price,
        compareAtPrice: update.compareAtPrice,
        metafields: update.metafields
      });
    }

    // Run the per-product mutations concurrently (capped, not unbounded - a single
    // 250-variant page can span dozens of distinct products, and firing all of them at
    // once caused raw network-level failures in production) instead of one-at-a-time,
    // which was the dominant cost of a sync (N sequential round-trips per page).
    await mapWithConcurrency(
      Object.entries(grouped),
      10,
      ([productId, variantsChunk]) => bulkUpdateProductVariants(admin, productId, variantsChunk, "Failed to sync variants")
    );
  }

  if (auditLogs.length > 0) {
    await prisma.auditLog.createMany({ data: auditLogs });
  }

  // Distinct product IDs seen in this page (not just the ones that changed price) - lets
  // the caller track "N of M products scanned" across the whole paginated sync, since
  // the pagination itself walks variants, not products.
  const productIds = [...new Set(variants.map(edge => edge.node.product.id))];

  return {
    hasNextPage: data.data.productVariants.pageInfo.hasNextPage,
    nextCursor: data.data.productVariants.pageInfo.endCursor,
    variantsProcessed,
    syncedCount: variantsToUpdate.length,
    productIds
  };
}

/**
 * Resolves a sync scope (status filter and/or a specific collection) into a concrete
 * list of numeric product IDs. `status`/`collection_id` are NOT valid search fields on
 * the productVariants connection (confirmed directly against the live store - Shopify
 * returns an "Invalid search field" warning), only on the products connection, so
 * scoped syncs go through this two-step resolve-then-sync path rather than filtering
 * productVariants directly.
 *
 * @param statusFilter "active" | null/"all" (no status restriction)
 * @param collectionId numeric collection id, or null for no collection restriction
 * @returns array of numeric product id strings (empty array if the scope matches nothing)
 */
export async function resolveScopeToProductIds(admin, { statusFilter = null, collectionId = null } = {}) {
  const filters = [];
  if (statusFilter && statusFilter !== "all") filters.push(`status:${statusFilter}`);
  if (collectionId) filters.push(`collection_id:${collectionId}`);
  const queryStr = filters.length > 0 ? filters.join(" AND ") : null;

  const QUERY = `
    query GetProductIds($q: String, $cursor: String) {
      products(first: 250, query: $q, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges { node { id } }
      }
    }
  `;

  let ids = [];
  let hasNextPage = true;
  let cursor = null;
  while (hasNextPage) {
    const res = await admin.graphql(QUERY, { variables: { q: queryStr, cursor } });
    const data = await res.json();
    if (!data.data?.products) {
      throw new Error(`Scope resolution query failed: ${JSON.stringify(data.errors || data)}`);
    }
    ids.push(...data.data.products.edges.map(e => e.node.id.split("/").pop()));
    hasNextPage = data.data.products.pageInfo.hasNextPage;
    cursor = data.data.products.pageInfo.endCursor;
  }
  return ids;
}

/**
 * Syncs every variant belonging to one batch of specific product IDs (built as an
 * OR'd `product_id:` query, confirmed working directly against the live store), rather
 * than the whole catalog. Used to sync a "page" of a resolved scope's product list.
 */
export async function syncProductIdBatch(admin, appSettings, productIds, shop, reason = "Bulk Sync") {
  if (productIds.length === 0) {
    return { syncedCount: 0, variantsProcessed: 0, productIds: [] };
  }
  const queryStr = productIds.map(id => `product_id:${id}`).join(" OR ");

  let hasNextPage = true;
  let cursor = null;
  let syncedCount = 0;
  let variantsProcessed = 0;
  const productIdsSeen = new Set();

  while (hasNextPage) {
    const result = await syncVariantPage(admin, appSettings, { cursor, pageSize: 250, shop, reason, query: queryStr });
    syncedCount += result.syncedCount;
    variantsProcessed += result.variantsProcessed;
    result.productIds.forEach(id => productIdsSeen.add(id));
    hasNextPage = result.hasNextPage;
    cursor = result.nextCursor;
  }

  return { syncedCount, variantsProcessed, productIds: [...productIdsSeen] };
}

/**
 * Loops `syncVariantPage` over the whole catalog. Used by the nightly cron
 * scheduler and the "Update All Prices" / "global_sync" dashboard actions,
 * where there's no frontend progress bar driving the pagination.
 */
export async function runBulkSync(admin, appSettings, { pageSize = 250, reason = "Bulk Sync" } = {}) {
  let hasNextPage = true;
  let cursor = null;
  let syncedCount = 0;

  while (hasNextPage) {
    const result = await syncVariantPage(admin, appSettings, { cursor, pageSize, shop: appSettings.shop, reason });
    syncedCount += result.syncedCount;
    hasNextPage = result.hasNextPage;
    cursor = result.nextCursor;
  }

  return syncedCount;
}

/**
 * Syncs every variant of exactly one product, immediately, without touching the rest
 * of the catalog or waiting on a full-catalog run. Reuses syncVariantPage as-is (via
 * Shopify's `product_id:` query filter on the variants connection) rather than
 * reimplementing the pricing/backup logic a third time - same math, same safety net,
 * same audit log, just scoped to one product.
 */
export async function syncSingleProduct(admin, appSettings, productId, shop) {
  // productId may be a full GID (gid://shopify/Product/123) or a bare numeric id
  const numericId = productId.toString().split("/").pop();

  let hasNextPage = true;
  let cursor = null;
  let syncedCount = 0;
  let variantsProcessed = 0;

  while (hasNextPage) {
    const result = await syncVariantPage(admin, appSettings, {
      cursor,
      pageSize: 250, // a single product will never realistically have more variants than this
      shop,
      reason: "Single Product Sync",
      query: `product_id:${numericId}`,
    });
    syncedCount += result.syncedCount;
    variantsProcessed += result.variantsProcessed;
    hasNextPage = result.hasNextPage;
    cursor = result.nextCursor;
  }

  return { syncedCount, variantsProcessed };
}

/**
 * The proper counterpart to the `custom.original_price` backup that `syncVariantPage`
 * now guarantees on every sync: restores each ACTIVE variant's price back to whatever
 * was captured in `custom.original_price` before dynamic pricing ever touched it, and
 * clears `compareAtPrice` (there's nothing to "compare against" once pricing is manual
 * again). Every restore is written to the audit log so it shows up in the sync history
 * alongside regular syncs.
 *
 * This is the only revert path now - the earlier `custom.diamond_price`-based
 * backup/revert functions were removed since they duplicated this in a separate,
 * confusingly-named metafield.
 */
export async function restoreOriginalPrices(admin, shop) {
  const GET_VARIANTS = `
    query GetVariants($cursor: String) {
      productVariants(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            price
            title
            product { id title status }
            originalPrice: metafield(namespace: "custom", key: "original_price") { value }
          }
        }
      }
    }
  `;

  let hasNextPage = true;
  let cursor = null;
  let restoredCount = 0;

  while (hasNextPage) {
    const response = await admin.graphql(GET_VARIANTS, { variables: { cursor } });
    const data = await response.json();
    const variants = data.data.productVariants.edges;

    const variantsToUpdate = [];
    const auditLogs = [];

    for (const edge of variants) {
      const variant = edge.node;

      // ONLY process ACTIVE products, consistent with the sync engine's own scope
      if (variant.product.status !== "ACTIVE") continue;

      // Restore ONLY if an original_price backup actually exists
      if (!variant.originalPrice || !variant.originalPrice.value) continue;

      variantsToUpdate.push({
        id: variant.id,
        productId: variant.product.id,
        price: variant.originalPrice.value
      });

      auditLogs.push({
        shop,
        productId: variant.product.id,
        variantId: variant.id,
        title: `${variant.product.title} - ${variant.title}`,
        oldPrice: parseFloat(variant.price),
        newPrice: parseFloat(variant.originalPrice.value),
        reason: "Restore Original Price"
      });
    }

    if (variantsToUpdate.length > 0) {
      const grouped = {};
      for (const update of variantsToUpdate) {
        if (!grouped[update.productId]) grouped[update.productId] = [];
        // Clear compareAtPrice too - a manually-priced variant shouldn't keep showing
        // a "compare at" discount that was only ever meaningful for dynamic pricing.
        grouped[update.productId].push({ id: update.id, price: update.price, compareAtPrice: null });
      }

      await mapWithConcurrency(
        Object.entries(grouped),
        10,
        ([productId, variantsChunk]) => bulkUpdateProductVariants(admin, productId, variantsChunk, "Failed to restore variants")
      );
      restoredCount += variantsToUpdate.length;
    }

    if (auditLogs.length > 0) {
      await prisma.auditLog.createMany({ data: auditLogs });
    }

    hasNextPage = data.data.productVariants.pageInfo.hasNextPage;
    cursor = data.data.productVariants.pageInfo.endCursor;
  }

  return restoredCount;
}

const GET_VARIANTS_FOR_HEALTH_QUERY = `
  query GetVariantsForHealth($cursor: String) {
    productVariants(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          product { status }
          priceBreakdown: metafield(namespace: "custom", key: "price_breakdown") { value }
        }
      }
    }
  }
`;

/**
 * Scans the whole ACTIVE catalog (cheap - one metafield per variant, not the full sync
 * query) to answer "where does my catalog actually stand right now":
 *  - pricedOk: has a price_breakdown and no diamond-parsing error
 *  - hasComparison: has a price_breakdown with compareAtPrice (i.e. synced under the
 *    current pricing logic, not a stale pre-compareAtPrice sync)
 *  - failed: has a price_breakdown but diamondParsingError is true - it WAS priced (and
 *    the live price WAS updated), just with the diamond cost likely wrong because the
 *    shape/carat/quantity lines in the description didn't line up
 *  - notYetPriced: no price_breakdown at all - never been through a sync
 */
export async function getCatalogHealthStats(admin) {
  let hasNextPage = true;
  let cursor = null;

  let totalActiveVariants = 0;
  let pricedOk = 0;
  let hasComparison = 0;
  let failed = 0;

  while (hasNextPage) {
    const response = await admin.graphql(GET_VARIANTS_FOR_HEALTH_QUERY, { variables: { cursor } });
    const data = await response.json();
    const variants = data.data.productVariants.edges;

    for (const edge of variants) {
      const variant = edge.node;
      if (variant.product.status !== "ACTIVE") continue;
      totalActiveVariants++;

      const raw = variant.priceBreakdown?.value;
      if (!raw) continue; // not yet priced

      let breakdown = null;
      try {
        breakdown = JSON.parse(raw);
      } catch (e) {
        continue; // corrupt/unexpected value - treat like not-yet-priced rather than guess
      }

      if (breakdown.diamondParsingError) {
        failed++;
        continue;
      }

      pricedOk++;
      if (breakdown.compareAtPrice != null) hasComparison++;
    }

    hasNextPage = data.data.productVariants.pageInfo.hasNextPage;
    cursor = data.data.productVariants.pageInfo.endCursor;
  }

  const notYetPriced = totalActiveVariants - pricedOk - failed;

  return { totalActiveVariants, pricedOk, hasComparison, failed, notYetPriced };
}

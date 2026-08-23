import { calculateFinalPrice, parseDiamondText } from "./pricing";
import prisma from "../db.server";
const GET_VARIANTS_FOR_SYNC_QUERY = `
  query GetVariants($cursor: String, $pageSize: Int!) {
    productVariants(first: $pageSize, after: $cursor) {
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
export async function syncVariantPage(admin, appSettings, { cursor = null, pageSize = 25, shop, reason = "Bulk Sync" } = {}) {
  const response = await admin.graphql(GET_VARIANTS_FOR_SYNC_QUERY, { variables: { cursor, pageSize } });
  const data = await response.json();
  const variants = data.data.productVariants.edges;

  let variantsToUpdate = [];
  let auditLogs = [];
  let variantsProcessed = 0;

  for (const edge of variants) {
    const variant = edge.node;
    variantsProcessed++;

    // ONLY process ACTIVE products
    if (variant.product.status !== "ACTIVE") continue;

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

    for (const [productId, variantsChunk] of Object.entries(grouped)) {
      const mutRes = await admin.graphql(`
        mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            userErrors { field message }
          }
        }
      `, { variables: { productId, variants: variantsChunk } });

      const mutData = await mutRes.json();
      if (mutData.data.productVariantsBulkUpdate.userErrors.length > 0) {
        console.error("BULK UPDATE ERRORS:", JSON.stringify(mutData.data.productVariantsBulkUpdate.userErrors, null, 2));
        throw new Error("Failed to sync variants: " + mutData.data.productVariantsBulkUpdate.userErrors[0].message);
      }
    }
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

      for (const [productId, variantsChunk] of Object.entries(grouped)) {
        const mutRes = await admin.graphql(`
          mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
              userErrors { field message }
            }
          }
        `, { variables: { productId, variants: variantsChunk } });

        const mutData = await mutRes.json();
        if (mutData.data.productVariantsBulkUpdate.userErrors.length > 0) {
          console.error("RESTORE ERRORS:", JSON.stringify(mutData.data.productVariantsBulkUpdate.userErrors, null, 2));
          throw new Error("Failed to restore variants: " + mutData.data.productVariantsBulkUpdate.userErrors[0].message);
        }
        restoredCount += variantsChunk.length;
      }
    }

    if (auditLogs.length > 0) {
      await prisma.auditLog.createMany({ data: auditLogs });
    }

    hasNextPage = data.data.productVariants.pageInfo.hasNextPage;
    cursor = data.data.productVariants.pageInfo.endCursor;
  }

  return restoredCount;
}

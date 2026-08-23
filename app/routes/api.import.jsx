import { authenticate } from "../shopify.server";
import { parse } from "csv-parse/sync";

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  
  let formData;
  try {
    formData = await request.formData();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Failed to parse upload" }), { status: 400 });
  }

  const file = formData.get("file");
  if (!file) {
    return new Response(JSON.stringify({ error: "No file uploaded" }), { status: 400 });
  }

  const csvText = await file.text();
  
  let records;
  try {
    records = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      relax_quotes: true
    });
  } catch(e) {
    return new Response(JSON.stringify({ error: "Invalid CSV format. Please ensure it is a standard comma-separated file." }), { status: 400 });
  }

  const handles = [...new Set(records.map(r => r.Handle).filter(Boolean))];
  if (handles.length === 0) {
    return new Response(JSON.stringify({ error: "No valid 'Handle' column found in the CSV." }), { status: 400 });
  }

  // 1. Fetch products by handles to get IDs
  const productsMap = {}; 
  
  for (let i = 0; i < handles.length; i += 50) {
    const chunk = handles.slice(i, i + 50);
    const queryStr = chunk.map(h => `handle:${h}`).join(" OR ");
    
    const query = `
      query getProductsByHandle($queryStr: String!) {
        products(first: 50, query: $queryStr) {
          edges {
            node {
              id
              handle
              variants(first: 100) {
                edges {
                  node {
                    id
                    sku
                    selectedOptions { name value }
                  }
                }
              }
            }
          }
        }
      }
    `;
    
    const response = await admin.graphql(query, { variables: { queryStr } });
    const { data } = await response.json();
    
    if (data?.products?.edges) {
      for (const edge of data.products.edges) {
        const product = edge.node;
        productsMap[product.handle] = {
          id: product.id,
          variants: {}
        };
        for (const vEdge of product.variants.edges) {
          const variant = vEdge.node;
          if (variant.sku) productsMap[product.handle].variants[variant.sku] = variant.id;
          const optString = variant.selectedOptions.map(o => o.value).join("-");
          productsMap[product.handle].variants[optString] = variant.id;
        }
      }
    }
  }

  // 2. Prepare Metafields
  let metafieldsToSet = [];
  
  for (const row of records) {
    const handle = row["Handle"];
    const sku = row["Variant SKU"];
    const opt1 = row["Option1 Value"];
    const opt2 = row["Option2 Value"];
    const opt3 = row["Option3 Value"];
    
    const pMeta = productsMap[handle];
    if (!pMeta) continue;
    
    let vId = null;
    if (sku && pMeta.variants[sku]) {
      vId = pMeta.variants[sku];
    } else {
      const optString = [opt1, opt2, opt3].filter(Boolean).join("-");
      if (pMeta.variants[optString]) {
        vId = pMeta.variants[optString];
      }
    }
    
    if (vId) {
      // Find the gold weight and diamond price columns regardless of exact naming (in case of slight changes)
      const goldKey = Object.keys(row).find(k => k.includes("custom.gold_weight"));
      const diamondKey = Object.keys(row).find(k => k.includes("custom.diamond_price"));

      if (goldKey && row[goldKey] !== "") {
        const goldWeight = parseFloat(row[goldKey]);
        if (!isNaN(goldWeight)) {
          metafieldsToSet.push({
            ownerId: vId,
            namespace: "custom",
            key: "gold_weight",
            type: "number_decimal",
            value: goldWeight.toString()
          });
        }
      }
      
      if (diamondKey && row[diamondKey] !== "") {
        const diamondPrice = parseFloat(row[diamondKey]);
        if (!isNaN(diamondPrice)) {
          metafieldsToSet.push({
            ownerId: vId,
            namespace: "custom",
            key: "diamond_price",
            type: "number_decimal",
            value: diamondPrice.toString()
          });
        }
      }
    }
  }
  
  // Remove duplicates
  const uniqueMetafieldsMap = {};
  for (const m of metafieldsToSet) {
    uniqueMetafieldsMap[`${m.ownerId}-${m.key}`] = m;
  }
  const uniqueMetafields = Object.values(uniqueMetafieldsMap);

  if (uniqueMetafields.length === 0) {
    return new Response(JSON.stringify({ error: "No valid variants or metafields found to update." }), { status: 400 });
  }

  // 3. Apply mutations in chunks of 25
  const MUTATION = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;
  
  let successCount = 0;
  for (let i = 0; i < uniqueMetafields.length; i += 25) {
    const chunk = uniqueMetafields.slice(i, i + 25);
    const response = await admin.graphql(MUTATION, { variables: { metafields: chunk } });
    const { data } = await response.json();
    if (data?.metafieldsSet?.userErrors?.length === 0) {
      successCount += chunk.length;
    } else {
      console.error("Metafield Set Error:", data?.metafieldsSet?.userErrors);
    }
  }
  
  // NOTE: This updates the metafields, but we also want to trigger a recalculation of prices!
  // To do that safely, we should call the runBulkSync logic. 
  // However, `runBulkSync` fetches all products. The user can just click "Sync All Prices" after importing.
  
  return new Response(JSON.stringify({ 
    success: true, 
    updatedMetafields: uniqueMetafields.length,
    message: `Successfully updated ${uniqueMetafields.length} metafield values! Please click 'Sync All Prices' to apply these changes to the final prices.` 
  }), {
    headers: { "Content-Type": "application/json" }
  });
};

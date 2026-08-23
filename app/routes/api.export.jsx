import { authenticate } from "../shopify.server";
import { extractTextFromRichText } from "../services/pricing";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  
  const url = new URL(request.url);
  const variantIdsParam = url.searchParams.get("variantIds");
  let targetVariantIds = [];
  if (variantIdsParam && variantIdsParam !== "all") {
    try {
      targetVariantIds = JSON.parse(variantIdsParam);
    } catch(e) {}
  }
  
  let hasNextPage = true;
  let cursor = null;
  const allVariants = [];

  const GET_PRODUCTS_QUERY = `
    query GetProductsForExport($cursor: String) {
      products(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            handle
            title
            status
            vendor
            productType
            diamondInfo1: metafield(namespace: "custom", key: "diamond") { value }
            diamondInfo2: metafield(namespace: "custom", key: "diamond_info") { value }
            variants(first: 100) {
              edges {
                node {
                  id
                  sku
                  title
                  price
                  compareAtPrice
                  selectedOptions {
                    name
                    value
                  }
                  goldWeight: metafield(namespace: "custom", key: "gold_weight") { value }
                  diamondPrice: metafield(namespace: "custom", key: "diamond_price") { value }
                }
              }
            }
          }
        }
      }
    }
  `;

  try {
    if (targetVariantIds.length > 0) {
      const GET_SPECIFIC_VARIANTS_QUERY = `
        query getSelectedVariants($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on ProductVariant {
              id
              sku
              title
              price
              compareAtPrice
              selectedOptions { name value }
              goldWeight: metafield(namespace: "custom", key: "gold_weight") { value }
              diamondPrice: metafield(namespace: "custom", key: "diamond_price") { value }
              originalPrice: metafield(namespace: "custom", key: "original_price") { value }
              product {
                id
                handle
                title
                status
                vendor
                productType
                diamondInfo1: metafield(namespace: "custom", key: "diamond") { value }
                diamondInfo2: metafield(namespace: "custom", key: "diamond_info") { value }
              }
            }
          }
        }
      `;
      // We chunk the IDs in case there are many, GraphQL nodes query usually accepts up to 250
      for (let i = 0; i < targetVariantIds.length; i += 50) {
        const chunk = targetVariantIds.slice(i, i + 50);
        const response = await admin.graphql(GET_SPECIFIC_VARIANTS_QUERY, { variables: { ids: chunk } });
        const { data } = await response.json();
        
        for (const variant of data.nodes) {
          if (!variant || !variant.product) continue;
          const product = variant.product;
          let pDiamondInfo = product.diamondInfo1?.value || product.diamondInfo2?.value || "";
          if (pDiamondInfo.trim().startsWith('{')) {
            try { pDiamondInfo = extractTextFromRichText(JSON.parse(pDiamondInfo)); } catch(e) {}
          } else {
            pDiamondInfo = pDiamondInfo.replace(/<[^>]*>?/gm, '\n').replace(/&nbsp;/g, ' ');
          }
          
          const opt1 = variant.selectedOptions[0] || { name: "", value: "" };
          const opt2 = variant.selectedOptions[1] || { name: "", value: "" };
          const opt3 = variant.selectedOptions[2] || { name: "", value: "" };
          
          allVariants.push({
            "Handle": product.handle,
            "Title": product.title,
            "Body (HTML)": "",
            "Vendor": product.vendor,
            "Type": product.productType,
            "Tags": "",
            "Published": "",
            "Option1 Name": opt1.name,
            "Option1 Value": opt1.value,
            "Option2 Name": opt2.name,
            "Option2 Value": opt2.value,
            "Option3 Name": opt3.name,
            "Option3 Value": opt3.value,
            "Variant SKU": variant.sku || "",
            "Variant Grams": "",
            "Variant Inventory Tracker": "",
            "Variant Inventory Qty": "",
            "Variant Inventory Policy": "",
            "Variant Fulfillment Service": "",
            "Variant Price": variant.price,
            "Variant Compare At Price": variant.compareAtPrice || "",
            "Variant Requires Shipping": "",
            "Variant Taxable": "",
            "Variant Barcode": "",
            "Image Src": "",
            "Image Position": "",
            "Image Alt Text": "",
            "Gift Card": "",
            "SEO Title": "",
            "SEO Description": "",
            "Google Shopping / Google Product Category": "",
            "Google Shopping / Gender": "",
            "Google Shopping / Age Group": "",
            "Google Shopping / MPN": "",
            "Google Shopping / AdWords Grouping": "",
            "Google Shopping / AdWords Labels": "",
            "Google Shopping / Condition": "",
            "Google Shopping / Custom Product": "",
            "Google Shopping / Custom Label 0": "",
            "Google Shopping / Custom Label 1": "",
            "Google Shopping / Custom Label 2": "",
            "Google Shopping / Custom Label 3": "",
            "Google Shopping / Custom Label 4": "",
            "Variant Image": "",
            "Variant Weight Unit": "",
            "Variant Tax Code": "",
            "Cost per item": "",
            "Status": product.status,
            "Product Metafield: custom.diamond [single_line_text_field]": pDiamondInfo,
            "Variant Metafield: custom.original_price [number_decimal]": variant.originalPrice?.value || "",
            "Variant Metafield: custom.gold_weight [number_decimal]": variant.goldWeight?.value || "",
            "Variant Metafield: custom.diamond_price [number_decimal]": variant.diamondPrice?.value || ""
          });
        }
      }
    } else {
      // Fetch all products
      while (hasNextPage) {
        const response = await admin.graphql(GET_PRODUCTS_QUERY, { variables: { cursor } });
        const { data } = await response.json();
        
        const products = data.products.edges;
        
        for (const pEdge of products) {
          const product = pEdge.node;
          let pDiamondInfo = product.diamondInfo1?.value || product.diamondInfo2?.value || "";
          
          if (pDiamondInfo.trim().startsWith('{')) {
            try {
              const jsonObj = JSON.parse(pDiamondInfo);
              pDiamondInfo = extractTextFromRichText(jsonObj);
            } catch(e) {
              // fallback to original if parsing fails
            }
          } else {
            pDiamondInfo = pDiamondInfo.replace(/<[^>]*>?/gm, '\n').replace(/&nbsp;/g, ' ');
          }
          
          let isFirstVariant = true;
          for (const vEdge of product.variants.edges) {
            const variant = vEdge.node;
            
            const opt1 = variant.selectedOptions[0] || { name: "", value: "" };
            const opt2 = variant.selectedOptions[1] || { name: "", value: "" };
            const opt3 = variant.selectedOptions[2] || { name: "", value: "" };
            
            allVariants.push({
              "Handle": product.handle,
              "Title": isFirstVariant ? product.title : "",
              "Body (HTML)": "",
              "Vendor": isFirstVariant ? product.vendor : "",
              "Type": isFirstVariant ? product.productType : "",
              "Tags": "",
              "Published": "",
              "Option1 Name": opt1.name,
              "Option1 Value": opt1.value,
              "Option2 Name": opt2.name,
              "Option2 Value": opt2.value,
              "Option3 Name": opt3.name,
              "Option3 Value": opt3.value,
              "Variant SKU": variant.sku || "",
              "Variant Grams": "",
              "Variant Inventory Tracker": "",
              "Variant Inventory Qty": "",
              "Variant Inventory Policy": "",
              "Variant Fulfillment Service": "",
              "Variant Price": variant.price,
              "Variant Compare At Price": variant.compareAtPrice || "",
              "Variant Requires Shipping": "",
              "Variant Taxable": "",
              "Variant Barcode": "",
              "Image Src": "",
              "Image Position": "",
              "Image Alt Text": "",
              "Gift Card": "",
              "SEO Title": "",
              "SEO Description": "",
              "Google Shopping / Google Product Category": "",
              "Google Shopping / Gender": "",
              "Google Shopping / Age Group": "",
              "Google Shopping / MPN": "",
              "Google Shopping / AdWords Grouping": "",
              "Google Shopping / AdWords Labels": "",
              "Google Shopping / Condition": "",
              "Google Shopping / Custom Product": "",
              "Google Shopping / Custom Label 0": "",
              "Google Shopping / Custom Label 1": "",
              "Google Shopping / Custom Label 2": "",
              "Google Shopping / Custom Label 3": "",
              "Google Shopping / Custom Label 4": "",
              "Variant Image": "",
              "Variant Weight Unit": "",
              "Variant Tax Code": "",
              "Cost per item": "",
              "Status": isFirstVariant ? product.status : "",
              "Product Metafield: custom.diamond [single_line_text_field]": isFirstVariant ? pDiamondInfo : "",
              "Variant Metafield: custom.original_price [number_decimal]": variant.originalPrice?.value || "",
              "Variant Metafield: custom.gold_weight [number_decimal]": variant.goldWeight?.value || "",
              "Variant Metafield: custom.diamond_price [number_decimal]": variant.diamondPrice?.value || ""
            });
            isFirstVariant = false;
          }
        }
        
        hasNextPage = data.products.pageInfo.hasNextPage;
        cursor = data.products.pageInfo.endCursor;
      }
    }

    if (allVariants.length === 0) {
      return new Response("No products found", { status: 404 });
    }

    // Convert array of objects to CSV string
    const headers = Object.keys(allVariants[0]);
    const csvRows = [];
    
    // Add headers
    csvRows.push(headers.map(h => `"${h}"`).join(','));
    
    // Add data rows
    for (const row of allVariants) {
      const values = headers.map(header => {
        let val = row[header];
        if (val === null || val === undefined) val = "";
        // Escape quotes
        val = val.toString().replace(/"/g, '""');
        return `"${val}"`;
      });
      csvRows.push(values.join(','));
    }
    
    const csvString = csvRows.join('\n');
    const filename = `products_export_${new Date().toISOString().split('T')[0]}.csv`;

    return new Response(csvString, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });

  } catch (error) {
    console.error("Export Error:", error);
    return new Response("Failed to generate export", { status: 500 });
  }
};

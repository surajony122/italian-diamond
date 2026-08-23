import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const cursor = formData.get("cursor") || null;

  try {
    if (!cursor || cursor === "null") {
      // First chunk: ensure Metafield Definition exists
      const DEF_MUTATION = `
        mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
          metafieldDefinitionCreate(definition: $definition) {
            createdDefinition { id name }
            userErrors { field message }
          }
        }
      `;
      await admin.graphql(DEF_MUTATION, {
        variables: {
          definition: {
            name: "Original Price Backup",
            namespace: "custom",
            key: "original_price",
            type: "number_decimal",
            ownerType: "PRODUCTVARIANT"
          }
        }
      });
      // Ignore user errors here since it will return an error if it already exists, which is fine.
    }

    const query = `
      query getProducts($cursor: String) {
        products(first: 20, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              variants(first: 50) {
                edges {
                  node {
                    id
                    price
                  }
                }
              }
            }
          }
        }
      }
    `;
    const response = await admin.graphql(query, { variables: { cursor } });
    const { data } = await response.json();
    
    let metafieldsToSet = [];
    let variantsProcessed = 0;

    for (const pEdge of data.products.edges) {
      for (const vEdge of pEdge.node.variants.edges) {
        const variant = vEdge.node;
        variantsProcessed++;
        metafieldsToSet.push({
          ownerId: variant.id,
          namespace: "custom",
          key: "original_price",
          type: "number_decimal",
          value: variant.price
        });
      }
    }
    
    const MUTATION = `
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }
    `;
    for (let i = 0; i < metafieldsToSet.length; i += 25) {
      const chunk = metafieldsToSet.slice(i, i + 25);
      const mRes = await admin.graphql(MUTATION, { variables: { metafields: chunk } });
      const mData = await mRes.json();
      if (mData.data.metafieldsSet.userErrors.length > 0) {
        console.error("METAFIELD SET ERRORS:", JSON.stringify(mData.data.metafieldsSet.userErrors, null, 2));
        throw new Error("Failed to set metafields: " + mData.data.metafieldsSet.userErrors[0].message);
      }
    }
    
    return new Response(JSON.stringify({ 
      success: true, 
      hasNextPage: data.products.pageInfo.hasNextPage,
      nextCursor: data.products.pageInfo.endCursor,
      variantsProcessed
    }), { headers: { "Content-Type": "application/json" } });

  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
};

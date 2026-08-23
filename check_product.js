import { PrismaClient } from '@prisma/client';
import { shopifyApi, LATEST_API_VERSION } from '@shopify/shopify-api';

const prisma = new PrismaClient();

async function main() {
  const session = await prisma.session.findFirst({
    where: { shop: 'ravistore-shop.myshopify.com' }
  });

  const shopify = shopifyApi({
    apiKey: 'dummy',
    apiSecretKey: 'dummy',
    apiVersion: LATEST_API_VERSION,
    scopes: ['read_products'],
    hostName: 'dummy',
    isEmbeddedApp: false
  });

  const client = new shopify.clients.Graphql({ session });

  const query = `
    {
      products(first: 10, query: "title:*Royal Bloom Blue Sapphire*") {
        edges {
          node {
            id
            title
            diamondInfo1: metafield(namespace: "custom", key: "diamond") { value }
            diamondInfo2: metafield(namespace: "custom", key: "diamond_info") { value }
            variants(first: 5) {
              edges {
                node {
                  id
                  title
                  price
                  goldWeight: metafield(namespace: "custom", key: "gold_weight") { value }
                  diamondPrice: metafield(namespace: "custom", key: "diamond_price") { value }
                  priceBreakdown: metafield(namespace: "custom", key: "price_breakdown") { value }
                }
              }
            }
          }
        }
      }
    }
  `;

  try {
    const response = await client.request(query);
    console.log(JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error(error);
  }
}

main();

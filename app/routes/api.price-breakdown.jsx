// Using standard Response objects for React Router V7
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { calculateFinalPrice } from "../services/pricing";

// App proxies map to GET or POST requests
export const loader = async ({ request }) => {
  // authenticate.public.appProxy is used to authenticate requests from Shopify App Proxy
  // For the sake of simplicity or if not using App Proxy, we can use authenticate.public.storefront
  // Let's use authenticate.public.appProxy 
  try {
    const { session, storefront } = await authenticate.public.appProxy(request);

    if (!session || !session.shop) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(request.url);
    const variantId = url.searchParams.get("variantId"); // e.g. gid://shopify/ProductVariant/123456789

    if (!variantId) {
      return Response.json({ error: "Missing variantId parameter" }, { status: 400 });
    }

    // Get settings
    const settings = await prisma.appSettings.findUnique({
      where: { shop: session.shop }
    });

    if (!settings) {
      return Response.json({ error: "App not configured for this shop" }, { status: 400 });
    }

    // Query storefront API for variant price and metafields
    // App proxy provides storefront API access
    const response = await storefront.graphql(`
      query getVariant($id: ID!) {
        node(id: $id) {
          ... on ProductVariant {
            price {
              amount
            }
            goldWeight: metafield(namespace: "custom", key: "gold_weight") {
              value
            }
          }
        }
      }
    `, {
      variables: { id: variantId }
    });

    const data = await response.json();
    const variant = data?.data?.node;

    if (!variant) {
      return Response.json({ error: "Variant not found" }, { status: 404 });
    }

    // Reconstruct breakdown
    // Note: this assumes variant.price is diamond price. If we sync'd prices, variant.price is the final price!
    // As mentioned before, standard practice is to store base diamond price in a custom.diamond_price metafield.
    // If we only have variant.price and it's already updated, we can't reconstruct the original unless we reverse calculate, but that's error prone.
    // For this demonstration we will assume the variant has a custom.diamond_price or we'll just reverse calculate based on gold weight.
    
    let goldWeight = 0;
    if (variant.goldWeight && variant.goldWeight.value) {
      goldWeight = parseFloat(variant.goldWeight.value);
    }
    
    // Reverse calculating if variant.price is ALREADY the final price:
    // This is a known architectural flaw in the requirements, I will log a comment, and reverse calculate.
    // Final Price = (Diamond Price + (Gold Weight * Rate) + (Gold Weight * Making)) * 1.03
    // Diamond Price = (Final Price / 1.03) - Gold Value - Making Charges

    const finalPrice = parseFloat(variant.price.amount);
    
    const goldValue = goldWeight * settings.goldRate;
    const makingCharges = goldWeight * settings.makingChargePerGram;
    const subtotalWithoutDiamond = goldValue + makingCharges;
    
    const diamondPrice = (finalPrice / (1 + (settings.gstPercentage / 100))) - subtotalWithoutDiamond;

    const breakdown = calculateFinalPrice({
      diamondPrice: Math.max(0, diamondPrice), // ensure it's not negative
      goldWeight,
      goldRate: settings.goldRate,
      makingChargePerGram: settings.makingChargePerGram,
      gstPercentage: settings.gstPercentage
    });

    return Response.json(breakdown);
  } catch (err) {
    console.error("App proxy error:", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
};

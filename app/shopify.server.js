import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  // This app is privately installed via Custom Distribution, not listed on the
  // Shopify App Store - AppDistribution.AppStore was the template default and
  // doesn't match, which changes how the library redirects/validates the OAuth
  // install flow (see redirect-to-install-page.js) and can break first-install
  // on a store that has never had this app before.
  distribution: AppDistribution.SingleMerchant,
  // expiringOfflineAccessTokens was on (template default) but nothing in this app ever
  // implements the refresh-token exchange it requires - so once the offline token
  // expired (~24h), every background/server-side API call started failing with
  // "Invalid API key or access token" (confirmed directly against the live store).
  // Off = Shopify's classic non-expiring offline token, matching what the rest of this
  // app (cron sync, background jobs) already assumes.
  future: {
    expiringOfflineAccessTokens: false,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;

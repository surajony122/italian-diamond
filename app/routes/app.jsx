import { Link, Outlet, useLoaderData, useNavigation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider, ProgressBar } from "@shopify/polaris";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { authenticate } from "../shopify.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();
  const navigation = useNavigation();
  const isNavigating = navigation.state !== "idle";

  return (
    <PolarisAppProvider i18n={{}}>
      <AppProvider embedded apiKey={apiKey}>
        <ui-nav-menu>
          <Link to="/app" rel="home">Dashboard</Link>
          <Link to="/app/products">Products</Link>
          <Link to="/app/pricing">Pricing Rules</Link>
          <Link to="/app/history">Audit History</Link>
          <Link to="/app/info">Diagnostics & Help</Link>
        </ui-nav-menu>
        {/* Thin top-of-page loading bar for ANY page navigation, on top of whatever
            page-specific skeleton (if any) that page also shows while its own loader
            data (e.g. the Dashboard's catalog scan) is still resolving. */}
        {isNavigating && (
          <div style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 512 }}>
            <ProgressBar progress={85} size="small" tone="primary" animated />
          </div>
        )}
        <Outlet />
      </AppProvider>
    </PolarisAppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};

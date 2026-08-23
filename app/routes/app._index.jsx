import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { Page, Layout, Card, BlockStack, InlineStack, Text, Button, Select, TextField, Banner, Badge, ProgressBar, DataTable, Link } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { fetchLiveGoldRate } from "../services/goldApi";
import { runBulkSync, restoreOriginalPrices } from "../services/syncEngine";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  let settings = await prisma.appSettings.findUnique({
    where: { shop: session.shop },
  });

  if (!settings) {
    settings = await prisma.appSettings.create({
      data: { shop: session.shop },
    });
  }

  return { settings };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  let settings = await prisma.appSettings.findUnique({
    where: { shop: session.shop },
  });

  if (!settings) {
    settings = await prisma.appSettings.create({
      data: { shop: session.shop },
    });
  }

  if (intent === "save_settings") {
    const goldRateRaw = formData.get("goldRate");
    const goldRate = goldRateRaw ? parseFloat(goldRateRaw) : NaN;

    const goldApiMode = formData.get("goldApiMode");
    const goldApiKey = formData.get("goldApiKey") || "";

    const dataToUpdate = { goldApiMode, goldApiKey };
    if (!isNaN(goldRate)) dataToUpdate.goldRate = goldRate;

    settings = await prisma.appSettings.update({
      where: { shop: session.shop },
      data: dataToUpdate,
    });

    return { success: true, settings, message: "Settings saved successfully" };
  }

  if (intent === "fetch_rate") {
    try {
      const liveRate = await fetchLiveGoldRate(settings.goldApiKey);
      settings = await prisma.appSettings.update({
        where: { shop: session.shop },
        data: { goldRate: liveRate },
      });
      return { success: true, settings, message: "Live gold rate fetched successfully" };
    } catch (e) {
      return { success: false, message: "Failed to fetch live rate. Using fallback." };
    }
  }

  if (intent === "sync_prices") {
    try {
      if (settings.goldApiMode === 'auto' && settings.goldApiKey) {
        try {
          const liveRate = await fetchLiveGoldRate(settings.goldApiKey);
          settings = await prisma.appSettings.update({
            where: { shop: session.shop },
            data: { goldRate: liveRate },
          });
        } catch (e) {
          console.error("Failed to fetch live rate before sync:", e);
        }
      }

      // Run asynchronously so Cloudflare doesn't timeout (524)
      runBulkSync(admin, settings).then((count) => {
        prisma.appSettings.update({
          where: { shop: session.shop },
          data: { lastSyncTime: new Date() },
        }).catch(console.error);
        console.log(`Sync complete: ${count} products`);
      }).catch(console.error);
      
      return { success: true, settings, message: `Sync started in the background! Please wait a few minutes depending on catalog size.` };
    } catch (e) {
      return { success: false, message: `Sync failed to start: ${e.message}` };
    }
  }

  if (intent === "restore_original_prices") {
    try {
      restoreOriginalPrices(admin, session.shop).catch(console.error);
      return { success: true, message: `Restore started in the background! Please wait a few minutes.` };
    } catch (e) {
      return { success: false, message: `Restore failed to start: ${e.message}` };
    }
  }

  return null;
};

export default function Index() {
  const { settings: initialSettings } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const settings = fetcher.data?.settings || initialSettings;
  const isLoading = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.message) {
      shopify.toast.show(fetcher.data.message);
    }
  }, [fetcher.data, shopify]);

  const [goldApiKey, setGoldApiKey] = useState(settings.goldApiKey || "");
  const [goldRate, setGoldRate] = useState(settings.goldRate?.toString() || "");
  const [goldApiMode, setGoldApiMode] = useState(settings.goldApiMode || "manual");

  useEffect(() => {
    setGoldApiKey(settings.goldApiKey || "");
    setGoldRate(settings.goldRate?.toString() || "");
    setGoldApiMode(settings.goldApiMode || "manual");
  }, [settings.goldApiKey, settings.goldRate, settings.goldApiMode]);

  return (
    <Page title="Gold Price Sync Dashboard" fullWidth>
      {isLoading && <div style={{marginBottom: '16px'}}><ProgressBar progress={100} size="small" tone="primary" /></div>}
      <Layout>
        
        {/* Dashboard Status */}
        <Layout.Section>
          <Card padding="400">
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <Text variant="headingMd" as="h2">Sync Status</Text>
                {settings.goldApiMode === 'auto' ? (
                  <Badge tone="success" progress="complete">Live API Active</Badge>
                ) : (
                  <Badge tone="info">Manual Mode</Badge>
                )}
              </InlineStack>
              <BlockStack gap="200">
                <Text as="p"><strong>Current Gold Rate:</strong> ₹{settings.goldRate} / gm</Text>
                <Text as="p"><strong>Making Charges:</strong> ₹{settings.makingChargePerGram} / gm</Text>
                <Text as="p"><strong>GST:</strong> {settings.gstPercentage}%</Text>
                <Text as="p"><strong>Diamond Base Price:</strong> ₹{settings.diamondBasePrice}/ct</Text>
                <Text as="p" tone="subdued">
                  Manage making charges, GST, and diamond pricing (including per-shape markup) on the{" "}
                  <Link url="/app/pricing">Pricing Rules</Link> page.
                </Text>
                <Text as="p"><strong>Last Sync Time:</strong> {settings.lastSyncTime ? new Date(settings.lastSyncTime).toLocaleString() : "Never"}</Text>
              </BlockStack>

              {settings.goldApiMode === 'auto' && settings.goldRate && (
                <div style={{marginTop: '16px'}}>
                  <Text variant="headingSm" as="h3">Calculated Live Prices</Text>
                  <div style={{marginTop: '8px', border: '1px solid #dfe3e8', borderRadius: '8px', overflow: 'hidden'}}>
                    <DataTable
                      columnContentTypes={['text', 'numeric']}
                      headings={['Purity (Karat)', 'Price (₹ / gm)']}
                      rows={[
                        ['24K (99.9%)', `₹${(settings.goldRate * 1).toFixed(2)}`],
                        ['22K (91.6%)', `₹${(settings.goldRate * 0.9167).toFixed(2)}`],
                        ['18K (75.0%)', `₹${(settings.goldRate * 0.7500).toFixed(2)}`],
                        ['14K (58.3%)', `₹${(settings.goldRate * 0.5833).toFixed(2)}`],
                        ['10K (41.6%)', `₹${(settings.goldRate * 0.4167).toFixed(2)}`]
                      ]}
                    />
                  </div>
                </div>
              )}
              
              <InlineStack gap="300">
                <Button 
                  variant="primary" 
                  onClick={() => fetcher.submit({ intent: "sync_prices" }, { method: "POST" })}
                  loading={isLoading && fetcher.formData?.get("intent") === "sync_prices"}
                >
                  Update All Prices
                </Button>
                <Button 
                  onClick={() => fetcher.submit({ intent: "fetch_rate" }, { method: "POST" })}
                  loading={isLoading && fetcher.formData?.get("intent") === "fetch_rate"}
                >
                  Fetch Latest Gold Rate
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Price Data Management */}
        <Layout.Section>
          <Card padding="400" background="bg-surface-critical">
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2" tone="critical">Data Safety</Text>

              <Text as="p">
                <strong>Restore Original Prices:</strong> Every sync (manual, bulk, or nightly) automatically backs up each variant's pre-sync price into <code>custom.original_price</code> before ever changing it. Click this to restore every variant's price from that guaranteed backup and clear its "Compare at" price — the safe way to stop dynamic pricing.
              </Text>
              <InlineStack>
                <Button
                  tone="critical"
                  onClick={() => {
                    if (confirm("Are you sure you want to restore all product prices from their original_price backup? This cannot be undone from here.")) {
                      fetcher.submit({ intent: "restore_original_prices" }, { method: "POST" });
                    }
                  }}
                  loading={isLoading && fetcher.formData?.get("intent") === "restore_original_prices"}
                >
                  Restore Original Prices
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Configuration Settings */}
        <Layout.Section>
          <Card padding="400">
            <form onSubmit={(e) => {
              e.preventDefault();
              const formData = new FormData(e.currentTarget);
              formData.append("intent", "save_settings");
              fetcher.submit(formData, { method: "POST" });
            }}>
              <BlockStack gap="400">
                <Text variant="headingMd" as="h2">App Configuration</Text>
                
                <Select
                  label="Gold API Mode"
                  name="goldApiMode"
                  options={[
                    {label: 'Manual', value: 'manual'},
                    {label: 'Auto Fetch (API)', value: 'auto'}
                  ]}
                  value={goldApiMode}
                  onChange={setGoldApiMode}
                />
                
                <TextField
                  label="GoldAPI.io Key (if Auto Fetch)"
                  name="goldApiKey"
                  value={goldApiKey}
                  onChange={setGoldApiKey}
                  placeholder="goldapi-xxxxxxxxxxxxxx-io"
                  autoComplete="off"
                />

                {goldApiMode === 'manual' && (
                  <div style={{maxWidth: '260px'}}>
                    <TextField
                      label="Gold Rate (₹ per gm)"
                      name="goldRate"
                      type="number"
                      step="0.01"
                      value={goldRate}
                      onChange={setGoldRate}
                      autoComplete="off"
                    />
                  </div>
                )}
                <Text as="p" tone="subdued">
                  Making charges, GST, and diamond pricing have moved to the{" "}
                  <Link url="/app/pricing">Pricing Rules</Link> page.
                </Text>

                <div style={{marginTop: '10px'}}>
                  <Button submit variant="primary" loading={isLoading && fetcher.formData?.get("intent") === "save_settings"}>
                    Save Settings
                  </Button>
                </div>
              </BlockStack>
            </form>
          </Card>
        </Layout.Section>

      </Layout>
    </Page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};

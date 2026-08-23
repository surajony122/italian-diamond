import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useNavigation } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { Page, Layout, Card, BlockStack, InlineStack, Text, Button, Select, TextField, Banner, Badge, ProgressBar, DataTable, Link, Box, Icon, SkeletonPage, SkeletonBodyText } from "@shopify/polaris";
import { RefreshIcon, CashDollarIcon, SaveIcon, ShieldCheckMarkIcon, ClockIcon, ChartVerticalIcon, CheckCircleIcon, AlertTriangleIcon, AlertDiamondIcon, PageClockIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { fetchLiveGoldRate } from "../services/goldApi";
import { runBulkSync, restoreOriginalPrices, getCatalogHealthStats } from "../services/syncEngine";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  let settings = await prisma.appSettings.findUnique({
    where: { shop: session.shop },
  });

  if (!settings) {
    settings = await prisma.appSettings.create({
      data: { shop: session.shop },
    });
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [totalSyncs, syncsLast7Days, dailyRows, catalogHealth] = await Promise.all([
    prisma.auditLog.count({ where: { shop: session.shop } }),
    prisma.auditLog.count({ where: { shop: session.shop, createdAt: { gt: sevenDaysAgo } } }),
    prisma.$queryRaw`
      SELECT date_trunc('day', "createdAt") as day, count(*)::int as count
      FROM "AuditLog"
      WHERE shop = ${session.shop} AND "createdAt" > now() - interval '14 days'
      GROUP BY day ORDER BY day
    `,
    getCatalogHealthStats(admin),
  ]);

  // Zero-fill the last 14 days so the chart always has a full, evenly-spaced axis
  // instead of only showing whichever days happened to have activity.
  const countsByDay = new Map(
    dailyRows.map(r => [new Date(r.day).toISOString().slice(0, 10), r.count])
  );
  const dailyActivity = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    dailyActivity.push({
      label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      count: countsByDay.get(key) || 0,
    });
  }

  return { settings, totalSyncs, syncsLast7Days, dailyActivity, catalogHealth };
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

// Small dependency-free bar chart (inline SVG) - deliberately not pulling in a charting
// library for one chart; keeps this SSR-safe with zero added risk of breakage.
function ActivityBarChart({ data }) {
  const width = 700;
  const height = 160;
  const barGap = 6;
  const barWidth = (width / data.length) - barGap;
  const max = Math.max(1, ...data.map(d => d.count));

  return (
    <svg viewBox={`0 0 ${width} ${height + 24}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="Price syncs over the last 14 days">
      {data.map((d, i) => {
        const barHeight = (d.count / max) * height;
        const x = i * (barWidth + barGap);
        const y = height - barHeight;
        return (
          <g key={i}>
            <rect x={x} y={y} width={barWidth} height={Math.max(barHeight, d.count > 0 ? 3 : 0)} rx="3" fill={d.count > 0 ? "#8c5a4f" : "#e1e3e5"} />
            <text x={x + barWidth / 2} y={height + 16} textAnchor="middle" fontSize="10" fill="#637381">
              {d.label}
            </text>
            {d.count > 0 && (
              <text x={x + barWidth / 2} y={y - 4} textAnchor="middle" fontSize="10" fill="#202223">
                {d.count}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function StatTile({ icon, label, value, tone = "info" }) {
  const toneBg = {
    info: "#eaf2fb",
    success: "#e3f5e9",
    warning: "#fff4e4",
    critical: "#fbeae5",
  }[tone] || "#f1f2f3";
  const toneColor = {
    info: "#1f5199",
    success: "#1a7a3d",
    warning: "#8a5a00",
    critical: "#8c2e1a",
  }[tone] || "#454f5b";

  return (
    <Box background="bg-surface-secondary" padding="300" borderRadius="200" minWidth="160px">
      <InlineStack gap="300" blockAlign="center" wrap={false}>
        <div style={{ background: toneBg, color: toneColor, borderRadius: '8px', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon source={icon} />
        </div>
        <BlockStack gap="0">
          <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
          <Text as="span" variant="headingLg">{value}</Text>
        </BlockStack>
      </InlineStack>
    </Box>
  );
}

export default function Index() {
  const { settings: initialSettings, totalSyncs, syncsLast7Days, dailyActivity, catalogHealth } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const navigation = useNavigation();

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

  // Loading this page runs a full catalog scan (getCatalogHealthStats), which takes a
  // few seconds on a large store - show a skeleton while navigating here instead of a
  // blank/frozen screen.
  if (navigation.state === "loading" && navigation.location.pathname === "/app") {
    return (
      <SkeletonPage fullWidth>
        <Layout>
          <Layout.Section>
            <InlineStack gap="300" wrap>
              {[1, 2, 3].map(i => (
                <Box key={i} background="bg-surface-secondary" padding="300" borderRadius="200" minWidth="160px">
                  <SkeletonBodyText lines={2} />
                </Box>
              ))}
            </InlineStack>
          </Layout.Section>
          <Layout.Section>
            <Card><SkeletonBodyText lines={4} /></Card>
          </Layout.Section>
          <Layout.Section>
            <Card><SkeletonBodyText lines={6} /></Card>
          </Layout.Section>
        </Layout>
      </SkeletonPage>
    );
  }

  return (
    <Page title="Gold Price Sync Dashboard" fullWidth>
      {isLoading && <div style={{marginBottom: '16px'}}><ProgressBar progress={100} size="small" tone="primary" /></div>}
      <Layout>

        {/* At-a-glance activity */}
        <Layout.Section>
          <InlineStack gap="300" wrap>
            <StatTile icon={CashDollarIcon} label="Total Price Syncs" value={totalSyncs.toLocaleString()} tone="info" />
            <StatTile icon={RefreshIcon} label="Syncs (Last 7 Days)" value={syncsLast7Days.toLocaleString()} tone="success" />
            <StatTile
              icon={ClockIcon}
              label="Last Sync"
              value={settings.lastSyncTime ? new Date(settings.lastSyncTime).toLocaleDateString() : "Never"}
              tone={settings.lastSyncTime ? "success" : "warning"}
            />
          </InlineStack>
        </Layout.Section>

        {/* Catalog health - real counts across the whole ACTIVE catalog, not just
            whatever's loaded on the Products page */}
        <Layout.Section>
          <Card padding="400">
            <BlockStack gap="300">
              <InlineStack align="space-between">
                <Text variant="headingMd" as="h2">Catalog Health</Text>
                <Text as="span" variant="bodySm" tone="subdued">
                  {catalogHealth.totalActiveVariants.toLocaleString()} active variants scanned
                </Text>
              </InlineStack>
              <InlineStack gap="300" wrap>
                <StatTile
                  icon={CheckCircleIcon}
                  label="Priced Correctly"
                  value={catalogHealth.pricedOk.toLocaleString()}
                  tone="success"
                />
                <StatTile
                  icon={AlertDiamondIcon}
                  label="Has Price Comparison"
                  value={catalogHealth.hasComparison.toLocaleString()}
                  tone="info"
                />
                <StatTile
                  icon={AlertTriangleIcon}
                  label="Calculation Failures"
                  value={catalogHealth.failed.toLocaleString()}
                  tone={catalogHealth.failed > 0 ? "critical" : "success"}
                />
                <StatTile
                  icon={PageClockIcon}
                  label="Not Yet Priced"
                  value={catalogHealth.notYetPriced.toLocaleString()}
                  tone={catalogHealth.notYetPriced > 0 ? "warning" : "success"}
                />
              </InlineStack>
              {catalogHealth.failed > 0 && (
                <Text as="p" tone="subdued" variant="bodySm">
                  "Calculation Failures" means the diamond description's Shape/Carat/Quantity lines didn't line
                  up during parsing - the variant still got priced (diamond cost likely $0), but its description
                  is worth checking on the Products page.
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card padding="400">
            <BlockStack gap="300">
              <InlineStack gap="150" blockAlign="center">
                <Icon source={ChartVerticalIcon} tone="subdued" />
                <Text variant="headingMd" as="h2">Price Syncs - Last 14 Days</Text>
              </InlineStack>
              <ActivityBarChart data={dailyActivity} />
            </BlockStack>
          </Card>
        </Layout.Section>

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
              <InlineStack gap="300" wrap>
                <Box background="bg-surface-secondary" padding="300" borderRadius="200" minWidth="140px">
                  <BlockStack gap="050">
                    <Text as="span" variant="bodySm" tone="subdued">Gold Rate</Text>
                    <Text as="span" variant="headingLg">₹{settings.goldRate}</Text>
                    <Text as="span" variant="bodySm" tone="subdued">per gram</Text>
                  </BlockStack>
                </Box>
                <Box background="bg-surface-secondary" padding="300" borderRadius="200" minWidth="140px">
                  <BlockStack gap="050">
                    <Text as="span" variant="bodySm" tone="subdued">Making Charges</Text>
                    <Text as="span" variant="headingLg">₹{settings.makingChargePerGram}</Text>
                    <Text as="span" variant="bodySm" tone="subdued">per gram</Text>
                  </BlockStack>
                </Box>
                <Box background="bg-surface-secondary" padding="300" borderRadius="200" minWidth="140px">
                  <BlockStack gap="050">
                    <Text as="span" variant="bodySm" tone="subdued">Diamond Base</Text>
                    <Text as="span" variant="headingLg">₹{settings.diamondBasePrice}</Text>
                    <Text as="span" variant="bodySm" tone="subdued">per carat</Text>
                  </BlockStack>
                </Box>
                <Box background="bg-surface-secondary" padding="300" borderRadius="200" minWidth="140px">
                  <BlockStack gap="050">
                    <Text as="span" variant="bodySm" tone="subdued">GST</Text>
                    <Text as="span" variant="headingLg">{settings.gstPercentage}%</Text>
                    <Text as="span" variant="bodySm" tone="subdued">&nbsp;</Text>
                  </BlockStack>
                </Box>
              </InlineStack>

              <BlockStack gap="100">
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
                  icon={CashDollarIcon}
                  onClick={() => fetcher.submit({ intent: "sync_prices" }, { method: "POST" })}
                  loading={isLoading && fetcher.formData?.get("intent") === "sync_prices"}
                >
                  Update All Prices
                </Button>
                <Button
                  icon={RefreshIcon}
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
              <InlineStack gap="150" blockAlign="center">
                <Icon source={ShieldCheckMarkIcon} tone="critical" />
                <Text variant="headingMd" as="h2" tone="critical">Data Safety</Text>
              </InlineStack>

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
                  <Button submit variant="primary" icon={SaveIcon} loading={isLoading && fetcher.formData?.get("intent") === "save_settings"}>
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

import {
  Page,
  Layout,
  Card,
  DataTable,
  Text,
  Badge,
} from "@shopify/polaris";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const logs = await prisma.auditLog.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    take: 100
  });

  return { logs };
};

// Maps each audit log reason to a distinct badge tone so the history reads at a
// glance instead of lumping everything that isn't "Bulk Sync" into "success" -
// a restore/revert is not the same kind of event as a routine price increase.
const REASON_TONE = {
  "Bulk Sync": "info",
  "Bulk API Chunk": "info",
  "Manual Save": "success",
  "Restore Original Price": "attention",
};

function reasonTone(reason) {
  return REASON_TONE[reason] || "new";
}

export default function HistoryPage() {
  const { logs } = useLoaderData();

  const rows = logs.map((log) => [
    new Date(log.createdAt).toLocaleString(),
    <Text variant="bodyMd" fontWeight="bold">{log.title}</Text>,
    log.oldPrice ? `₹${log.oldPrice.toFixed(2)}` : "-",
    `₹${log.newPrice.toFixed(2)}`,
    <Badge tone={reasonTone(log.reason)}>{log.reason}</Badge>
  ]);

  return (
    <Page title="Audit History" fullWidth>
      <Layout>
        <Layout.Section>
          <Card padding="0">
            <div style={{ padding: "16px" }}>
              <Text variant="headingMd" as="h2">Price Change Logs</Text>
              <Text variant="bodySm" tone="subdued">Showing the last 100 price updates</Text>
            </div>
            {logs.length === 0 ? (
              <div style={{ padding: "20px", textAlign: "center" }}>
                <Text variant="bodyMd">No audit logs found yet. Save a variant or run a sync to generate logs.</Text>
              </div>
            ) : (
              <DataTable
                columnContentTypes={[
                  'text',
                  'text',
                  'numeric',
                  'numeric',
                  'text'
                ]}
                headings={[
                  'Date',
                  'Product Variant',
                  'Old Price',
                  'New Price',
                  'Trigger'
                ]}
                rows={rows}
              />
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  List,
  DataTable,
  Badge,
  Banner,
  InlineStack
} from "@shopify/polaris";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  
  const appSettings = await prisma.appSettings.findFirst();
  
  const response = await admin.graphql(`
    query getProducts {
      products(first: 250) {
        edges {
          node {
            id
            title
            variants(first: 50) {
              edges {
                node {
                  id
                  title
                  goldWeight: metafield(namespace: "custom", key: "gold_weight") { value }
                  originalPrice: metafield(namespace: "custom", key: "original_price") { value }
                  inventoryItem { measurement { weight { value } } }
                }
              }
            }
          }
        }
      }
    }
  `);

  const { data } = await response.json();
  const products = data.products.edges.map(e => e.node);

  return { appSettings, products };
};

export default function InfoPage() {
  const { appSettings, products } = useLoaderData();

  const missingWeights = [];
  const missingBackups = [];

  products.forEach(p => {
    p.variants.edges.forEach(vEdge => {
      const v = vEdge.node;
      const weight = v.goldWeight?.value || v.inventoryItem?.measurement?.weight?.value;
      if (!weight || parseFloat(weight) === 0) {
        missingWeights.push([p.title, v.title]);
      }
      if (!v.originalPrice?.value) {
        missingBackups.push([p.title, v.title]);
      }
    });
  });

  return (
    <Page title="Diagnostics & Documentation" fullWidth>
      <Layout>
        <Layout.Section>
          
          <BlockStack gap="400">
            <Text variant="headingLg" as="h2">System Health Check</Text>
            
            <Card>
              <BlockStack gap="400">
                <Text variant="headingMd" as="h3">Global Configuration</Text>
                {appSettings && appSettings.goldRate > 0 ? (
                  <Banner title="App Settings Configured" tone="success">
                    <p>Live Gold Rate: ₹{appSettings.goldRate} | Making Charge: ₹{appSettings.makingChargePerGram}/g</p>
                  </Banner>
                ) : (
                  <Banner title="App Settings Missing" tone="critical">
                    <p>You have not configured your global Live Gold Rate or Making Charges yet on the Home page.</p>
                  </Banner>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between">
                  <Text variant="headingMd" as="h3">Missing Gold Weights</Text>
                  <Badge tone={missingWeights.length === 0 ? "success" : "critical"}>
                    {missingWeights.length} Variants
                  </Badge>
                </InlineStack>
                {missingWeights.length > 0 ? (
                  <DataTable
                    columnContentTypes={['text', 'text']}
                    headings={['Product Title', 'Variant']}
                    rows={missingWeights}
                  />
                ) : (
                  <Text as="p" tone="success">Perfect! All products have their gold weights entered.</Text>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between">
                  <Text variant="headingMd" as="h3">Missing Original Price Backups</Text>
                  <Badge tone={missingBackups.length === 0 ? "success" : "warning"}>
                    {missingBackups.length} Variants
                  </Badge>
                </InlineStack>
                {missingBackups.length > 0 ? (
                  <>
                    <Text as="p" tone="subdued">These variants have not been backed up yet. You should run the "Backup Original Prices" action on the Products page.</Text>
                    <DataTable
                      columnContentTypes={['text', 'text']}
                      headings={['Product Title', 'Variant']}
                      rows={missingBackups}
                    />
                  </>
                ) : (
                  <Text as="p" tone="success">Perfect! All original prices are safely backed up.</Text>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
          
          <br /><br />
          
          <BlockStack gap="400">
            <Text variant="headingLg" as="h2">How it Works (Documentation)</Text>
            <Card>
              <BlockStack gap="400">
                <Text variant="headingMd" as="h2">The Pricing Formula</Text>
                <Text as="p">
                  The final live price of every product on your store is dynamically calculated based on the global Live Gold Rate, the making charges, and the diamonds used. 
                </Text>
                
                <Text variant="headingSm" as="h3">1. Gold Rate Calculation</Text>
                <Text as="p">
                  The app takes your global <strong>24K Base Gold Rate</strong> (configured in Settings) and automatically adjusts it based on the Karat of the variant. The Karat is determined by checking if the variant name contains keywords like "14K", "18K", etc.
                </Text>
                
                <DataTable
                  columnContentTypes={['text', 'numeric', 'text']}
                  headings={['Karat', 'Multiplier', 'Formula']}
                  rows={[
                    ['9K', '0.375', 'Base Rate × 0.375'],
                    ['10K', '0.4167', 'Base Rate × 0.4167'],
                    ['14K', '0.5833', 'Base Rate × 0.5833'],
                    ['18K', '0.7500', 'Base Rate × 0.7500'],
                    ['22K', '0.9167', 'Base Rate × 0.9167'],
                    ['24K', '1.000', 'Base Rate × 1.000']
                  ]}
                />

                <Text variant="headingSm" as="h3">2. Diamond Smart Parser</Text>
                <Text as="p">
                  The app can automatically calculate diamond prices by reading the product's description. The parser looks for <strong>Shape</strong>, <strong>Carat</strong>, and <strong>Quantity</strong>.
                </Text>
                <List type="bullet">
                  <List.Item>
                    <strong>Round & Emerald Shapes:</strong> Uses the standard Diamond Base Price.
                  </List.Item>
                  <List.Item>
                    <strong>Fancy Shapes (Pear, Marquise, Oval, etc):</strong> Automatically applies a <strong>25% Markup</strong> (Base Price × 1.25).
                  </List.Item>
                </List>
                
                <Text variant="headingSm" as="h3">3. Final Math Equation</Text>
                <Text as="p">Once the rates are determined, the app computes the final checkout price as follows:</Text>
                <List type="number">
                  <List.Item><strong>Gold Cost</strong> = Variant Gold Rate × Gold Weight (g)</List.Item>
                  <List.Item><strong>Making Charge</strong> = Making Charge Per Gram × Gold Weight (g)</List.Item>
                  <List.Item><strong>Subtotal</strong> = Gold Cost + Making Charge + Diamond Price</List.Item>
                  <List.Item><strong>Final Live Price</strong> = Subtotal + GST Tax (e.g. 3%)</List.Item>
                </List>
                <Text as="p">
                  <em>Note: Gold value tracks the live market rate 1:1 - it is never marked up. The "Compare at Price" instead comes from marking up only the Making Charges and Diamond Price portions (25% by default, configurable on the Pricing Rules page), so the storefront can show a genuine "you save on making charges / diamond" comparison rather than an inflated discount on the metal itself.</em>
                </Text>
              </BlockStack>
            </Card>
          </BlockStack>

        </Layout.Section>
      </Layout>
    </Page>
  );
}

import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Button,
  Icon,
  Banner,
} from "@shopify/polaris";
import { DeleteIcon, PlusIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  let settings = await prisma.appSettings.findUnique({ where: { shop: session.shop } });
  if (!settings) {
    settings = await prisma.appSettings.create({ data: { shop: session.shop } });
  }

  return { settings };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  let settings = await prisma.appSettings.findUnique({ where: { shop: session.shop } });
  if (!settings) {
    settings = await prisma.appSettings.create({ data: { shop: session.shop } });
  }

  if (intent === "save_pricing") {
    const diamondBaseRaw = formData.get("diamondBasePrice");
    const makingRaw = formData.get("makingChargePerGram");
    const gstRaw = formData.get("gstPercentage");
    const defaultMarkupRaw = formData.get("defaultShapeMarkupPercent");
    const shapeMarkupsRaw = formData.get("shapeMarkups");

    const diamondBasePrice = diamondBaseRaw ? parseFloat(diamondBaseRaw) : NaN;
    const makingChargePerGram = makingRaw ? parseFloat(makingRaw) : NaN;
    const gstPercentage = gstRaw ? parseFloat(gstRaw) : NaN;
    const defaultShapeMarkupPercent = defaultMarkupRaw ? parseFloat(defaultMarkupRaw) : NaN;

    let shapeMarkups = settings.shapeMarkups;
    try {
      if (shapeMarkupsRaw) shapeMarkups = JSON.parse(shapeMarkupsRaw);
    } catch (e) {
      return { success: false, message: "Invalid shape markup data - not saved." };
    }

    const dataToUpdate = {};
    if (!isNaN(diamondBasePrice)) dataToUpdate.diamondBasePrice = diamondBasePrice;
    if (!isNaN(makingChargePerGram)) dataToUpdate.makingChargePerGram = makingChargePerGram;
    if (!isNaN(gstPercentage)) dataToUpdate.gstPercentage = gstPercentage;
    if (!isNaN(defaultShapeMarkupPercent)) dataToUpdate.defaultShapeMarkupPercent = defaultShapeMarkupPercent;
    dataToUpdate.shapeMarkups = shapeMarkups;

    settings = await prisma.appSettings.update({
      where: { shop: session.shop },
      data: dataToUpdate,
    });

    return { success: true, settings, message: "Pricing rules saved. Run a sync for these to take effect on your products." };
  }

  return null;
};

export default function PricingRules() {
  const { settings: initialSettings } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const settings = fetcher.data?.settings || initialSettings;
  const isLoading = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.message) {
      shopify.toast.show(fetcher.data.message, { isError: fetcher.data.success === false });
    }
  }, [fetcher.data, shopify]);

  const [diamondBasePrice, setDiamondBasePrice] = useState(settings.diamondBasePrice?.toString() || "26000");
  const [makingChargePerGram, setMakingChargePerGram] = useState(settings.makingChargePerGram?.toString() || "1500");
  const [gstPercentage, setGstPercentage] = useState(settings.gstPercentage?.toString() || "3");
  const [defaultShapeMarkupPercent, setDefaultShapeMarkupPercent] = useState(
    settings.defaultShapeMarkupPercent?.toString() || "25"
  );

  // shapeMarkups (a { shapeName: percent } map) as an editable list of rows
  const [shapeRows, setShapeRows] = useState(() => {
    const entries = Object.entries(settings.shapeMarkups || {});
    return entries.length > 0 ? entries.map(([shape, percent]) => ({ shape, percent: percent.toString() })) : [{ shape: "round", percent: "0" }, { shape: "emerald", percent: "0" }];
  });

  const updateRow = (index, field, value) => {
    setShapeRows(prev => prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  };

  const removeRow = (index) => {
    setShapeRows(prev => prev.filter((_, i) => i !== index));
  };

  const addRow = () => {
    setShapeRows(prev => [...prev, { shape: "", percent: "0" }]);
  };

  const handleSave = () => {
    const shapeMarkups = {};
    for (const row of shapeRows) {
      const key = row.shape.trim().toLowerCase();
      const percent = parseFloat(row.percent);
      if (key && !isNaN(percent)) shapeMarkups[key] = percent;
    }

    const formData = new FormData();
    formData.append("intent", "save_pricing");
    formData.append("diamondBasePrice", diamondBasePrice);
    formData.append("makingChargePerGram", makingChargePerGram);
    formData.append("gstPercentage", gstPercentage);
    formData.append("defaultShapeMarkupPercent", defaultShapeMarkupPercent);
    formData.append("shapeMarkups", JSON.stringify(shapeMarkups));
    fetcher.submit(formData, { method: "POST" });
  };

  const baseRate = parseFloat(diamondBasePrice) || 0;

  return (
    <Page title="Pricing Rules" fullWidth>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Banner tone="info">
              <p>
                These rules apply to <strong>every product</strong> the next time it's synced (Sync All Prices,
                or an individual variant save) - changing a number here doesn't retroactively change prices
                already on your storefront until you run a sync.
              </p>
            </Banner>

            <Card>
              <BlockStack gap="400">
                <Text variant="headingMd" as="h2">Base Rates</Text>
                <InlineStack gap="400" wrap>
                  <div style={{ flex: 1, minWidth: '200px' }}>
                    <TextField
                      label="Diamond Base Price (₹/ct)"
                      type="number"
                      step="1"
                      value={diamondBasePrice}
                      onChange={setDiamondBasePrice}
                      autoComplete="off"
                      helpText="Rate per carat for Round/Emerald (or whatever shapes you set to 0% below)."
                    />
                  </div>
                  <div style={{ flex: 1, minWidth: '200px' }}>
                    <TextField
                      label="Making Charges (₹/g)"
                      type="number"
                      step="0.01"
                      value={makingChargePerGram}
                      onChange={setMakingChargePerGram}
                      autoComplete="off"
                    />
                  </div>
                  <div style={{ flex: 1, minWidth: '200px' }}>
                    <TextField
                      label="GST Percentage (%)"
                      type="number"
                      step="0.01"
                      value={gstPercentage}
                      onChange={setGstPercentage}
                      autoComplete="off"
                    />
                  </div>
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text variant="headingMd" as="h2">Diamond Shape Markup</Text>
                  <Text as="p" tone="subdued">
                    Markup % on top of the Diamond Base Price, per shape (matched against the "Shape:" line in
                    each product's description, case-insensitive). Any shape not listed below uses the default
                    markup.
                  </Text>
                </BlockStack>

                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', minWidth: '520px', borderCollapse: 'collapse', textAlign: 'left' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid #e1e3e5' }}>
                        <th style={{ padding: '8px 8px 8px 0', fontSize: '12px', textTransform: 'uppercase', color: '#637381' }}>Shape</th>
                        <th style={{ padding: '8px', fontSize: '12px', textTransform: 'uppercase', color: '#637381' }}>Markup %</th>
                        <th style={{ padding: '8px', fontSize: '12px', textTransform: 'uppercase', color: '#637381' }}>Effective Rate (₹/ct)</th>
                        <th style={{ padding: '8px', width: '40px' }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {shapeRows.map((row, index) => {
                        const percentNum = parseFloat(row.percent) || 0;
                        const effectiveRate = baseRate * (1 + percentNum / 100);
                        return (
                          <tr key={index} style={{ borderBottom: '1px solid #f4f6f8' }}>
                            <td style={{ padding: '8px 8px 8px 0' }}>
                              <TextField
                                labelHidden
                                label="Shape"
                                value={row.shape}
                                onChange={(v) => updateRow(index, "shape", v)}
                                placeholder="e.g. Pear"
                                autoComplete="off"
                              />
                            </td>
                            <td style={{ padding: '8px' }}>
                              <TextField
                                labelHidden
                                label="Markup %"
                                type="number"
                                step="1"
                                value={row.percent}
                                onChange={(v) => updateRow(index, "percent", v)}
                                suffix="%"
                                autoComplete="off"
                              />
                            </td>
                            <td style={{ padding: '8px' }}>
                              <Text as="span" tone="subdued">₹{effectiveRate.toFixed(2)}</Text>
                            </td>
                            <td style={{ padding: '8px', textAlign: 'center' }}>
                              <Button
                                icon={DeleteIcon}
                                variant="tertiary"
                                tone="critical"
                                accessibilityLabel={`Remove ${row.shape || 'row'}`}
                                onClick={() => removeRow(index)}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <InlineStack>
                  <Button icon={PlusIcon} onClick={addRow}>Add shape</Button>
                </InlineStack>

                <div style={{ maxWidth: '260px' }}>
                  <TextField
                    label="Default markup for any other shape (%)"
                    type="number"
                    step="1"
                    value={defaultShapeMarkupPercent}
                    onChange={setDefaultShapeMarkupPercent}
                    suffix="%"
                    autoComplete="off"
                    helpText={`Effective rate: ₹${(baseRate * (1 + (parseFloat(defaultShapeMarkupPercent) || 0) / 100)).toFixed(2)}/ct`}
                  />
                </div>
              </BlockStack>
            </Card>

            <InlineStack>
              <Button variant="primary" onClick={handleSave} loading={isLoading}>
                Save Pricing Rules
              </Button>
            </InlineStack>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};

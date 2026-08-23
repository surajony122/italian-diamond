import { useEffect, useState, useCallback } from "react";
import { useFetcher, useLoaderData, useSubmit, Form, useNavigation } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Page,
  Layout,
  Card,
  Text,
  Badge,
  TextField,
  Button,
  InlineStack,
  BlockStack,
  Select,
  Filters,
  SkeletonPage,
  SkeletonBodyText,
  Icon,
  Modal,
  Box,
  DropZone,
  ProgressBar,
  Tooltip,
} from "@shopify/polaris";
import { ChevronDownIcon, ChevronUpIcon, ExportIcon, ImportIcon, InfoIcon, CashDollarIcon } from '@shopify/polaris-icons';
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { calculateFinalPrice, parseDiamondText } from "../services/pricing";
import { runBulkSync } from "../services/syncEngine";
export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q") || "";
  const status = url.searchParams.get("status") || "ALL";

  let searchQuery = [];
  if (q) searchQuery.push(`title:*${q}*`);
  if (status !== "ALL" && status !== "NEEDS_WEIGHT") searchQuery.push(`status:${status}`);
  const queryStr = searchQuery.length > 0 ? searchQuery.join(" AND ") : "";

  const response = await admin.graphql(`
    query getProducts($queryStr: String) {
      products(first: 50, query: $queryStr) {
        edges {
          node {
            id
            title
            status
            variants(first: 50) {
              edges {
                node {
                  id
                  title
                  price
                  sku
                  inventoryItem {
                    measurement {
                      weight {
                        value
                      }
                    }
                  }
                  goldWeight: metafield(namespace: "custom", key: "gold_weight") {
                    value
                  }
                  diamondPrice: metafield(namespace: "custom", key: "diamond_price") {
                    value
                  }
                  originalPrice: metafield(namespace: "custom", key: "original_price") {
                    value
                  }
                  priceBreakdown: metafield(namespace: "custom", key: "price_breakdown") {
                    value
                  }
                }
              }
            }
          }
        }
      }
    }
  `, {
    variables: { queryStr: queryStr || null }
  });

  const { data } = await response.json();
  
  const products = data.products.edges.map(productEdge => {
    const product = productEdge.node;
    return {
      id: product.id,
      title: product.title,
      status: product.status,
      variants: product.variants.edges.map(variantEdge => {
        const variant = variantEdge.node;
        return {
          variantId: variant.id,
          variantTitle: variant.title,
          sku: variant.sku,
          price: variant.price,
          originalPrice: variant.originalPrice,
          goldWeight: variant.goldWeight?.value || variant.inventoryItem?.measurement?.weight?.value?.toString() || "",
          diamondPrice: variant.diamondPrice?.value || variant.price,
          priceBreakdown: variant.priceBreakdown?.value || null,
        };
      })
    };
  });

  let finalProducts = products;
  if (status === "NEEDS_WEIGHT") {
    finalProducts = products.filter(p => p.variants.some(v => !v.goldWeight || parseFloat(v.goldWeight) === 0));
  }

  return { products: finalProducts, q, status };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "global_sync") {
    let appSettings = await prisma.appSettings.findUnique({ where: { shop: session.shop } });
    if (!appSettings) return null;
    await runBulkSync(admin, appSettings);
    return null;
  }

  if (intent === "save_variant") {
    const variantId = formData.get("variantId");
    const goldWeight = parseFloat(formData.get("goldWeight"));
    const diamondPrice = parseFloat(formData.get("diamondPrice"));
    
    // 1. Get settings and variant options
    let appSettings = await prisma.appSettings.findUnique({ where: { shop: session.shop } });
    
    const variantQuery = await admin.graphql(`
      query {
        productVariant(id: "${variantId}") {
          price
          title
          selectedOptions { value }
          product {
            id
            title
            diamondInfo1: metafield(namespace: "custom", key: "diamond") { value }
            diamondInfo2: metafield(namespace: "custom", key: "diamond_info") { value }
          }
        }
      }
    `);
    const varData = await variantQuery.json();
    const variantNode = varData.data.productVariant;
    const optionValues = variantNode.selectedOptions.map(o => o.value.toUpperCase());

    // 2. Detect Karat
    let karatMultiplier = 1.0;
    let detectedKarat = "24K";
    if (optionValues.some(v => v.includes("9K") || v.includes("9 KT"))) { karatMultiplier = 0.375; detectedKarat = "9K"; }
    else if (optionValues.some(v => v.includes("10K") || v.includes("10 KT"))) { karatMultiplier = 0.4167; detectedKarat = "10K"; }
    else if (optionValues.some(v => v.includes("14K") || v.includes("14 KT"))) { karatMultiplier = 0.5833; detectedKarat = "14K"; }
    else if (optionValues.some(v => v.includes("18K") || v.includes("18 KT"))) { karatMultiplier = 0.7500; detectedKarat = "18K"; }
    else if (optionValues.some(v => v.includes("22K") || v.includes("22 KT"))) { karatMultiplier = 0.9167; detectedKarat = "22K"; }

    const variantGoldRate = appSettings.goldRate * karatMultiplier;
    
    // -- SMART TEXT PARSER LOGIC --
    const diamondInfoText = variantNode.product.diamondInfo1?.value || variantNode.product.diamondInfo2?.value || "";
    let finalDiamondPrice = 0;
    
    const parserResult = parseDiamondText(
      diamondInfoText,
      appSettings.diamondBasePrice || 26000,
      appSettings.shapeMarkups || {},
      appSettings.defaultShapeMarkupPercent ?? 25
    );
    if (parserResult.parsedDiamonds.length > 0 && !parserResult.diamondParsingError) {
      finalDiamondPrice = parserResult.calculatedDiamondPrice;
    }
    
    // 3. Calculate new final price
    const calculated = calculateFinalPrice({
      diamondPrice: finalDiamondPrice,
      goldWeight,
      goldRate: variantGoldRate,
      makingChargePerGram: appSettings.makingChargePerGram,
      gstPercentage: appSettings.gstPercentage
    });
    
    calculated.settings = {
      goldRate: variantGoldRate.toFixed(2),
      makingChargePerGram: appSettings.makingChargePerGram,
      gstPercentage: appSettings.gstPercentage,
      goldWeight: goldWeight,
      karat: detectedKarat
    };
    if (parserResult.parsedDiamonds.length > 0) {
      calculated.parsedDiamonds = parserResult.parsedDiamonds;
    }
    if (parserResult.diamondParsingError) {
      calculated.diamondParsingError = true;
    }

    // 4. Update Variant Price and Metafields via GraphQL
    const metafields = [];
    if (!isNaN(goldWeight)) metafields.push({ namespace: "custom", key: "gold_weight", type: "number_decimal", value: goldWeight.toString() });
    if (!isNaN(diamondPrice)) metafields.push({ namespace: "custom", key: "diamond_price", type: "number_decimal", value: diamondPrice.toString() });
    metafields.push({ namespace: "custom", key: "price_breakdown", type: "json", value: JSON.stringify(calculated) });

    const response = await admin.graphql(`
      mutation productVariantUpdate($input: ProductVariantInput!) {
        productVariantUpdate(input: $input) {
          userErrors { field message }
        }
      }
    `, {
      variables: { input: { id: variantId, price: calculated.finalPrice.toString(), metafields } }
    });

    const { data } = await response.json();
    if (data.productVariantUpdate.userErrors.length > 0) {
      return { success: false, message: "Failed: " + data.productVariantUpdate.userErrors[0].message };
    }

    await prisma.auditLog.create({
      data: {
        shop: session.shop,
        productId: variantNode.product.id,
        variantId: variantId,
        title: `${variantNode.product.title} - ${variantNode.title}`,
        oldPrice: parseFloat(variantNode.price),
        newPrice: calculated.finalPrice,
        reason: "Manual Save"
      }
    });

    return { success: true, message: "Variant recalculated and saved!" };
  }

  if (intent === "bulk_update") {
    const variantIds = JSON.parse(formData.get("variantIds"));
    const bulkGoldWeight = formData.get("bulkGoldWeight");

    if (!bulkGoldWeight) return { success: false, message: "No gold weight provided." };

    const metafields = variantIds.map(id => ({
      ownerId: id,
      namespace: "custom",
      key: "gold_weight",
      type: "number_decimal",
      value: bulkGoldWeight.toString()
    }));

    const response = await admin.graphql(`
      mutation variantMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }
    `, {
      variables: { metafields }
    });

    const { data } = await response.json();
    if (data.metafieldsSet.userErrors.length > 0) {
      return { success: false, message: "Bulk update failed." };
    }

    return new Response(JSON.stringify({ message: "Product updated successfully!" }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // Note: "Backup Original Prices" in the UI hits the chunked /api/backup-chunk route
  // (see startProgressTask below), not an intent here. An earlier, unchunked duplicate
  // of that same logic used to live in this action (same page-in-one-request pattern
  // that caused the Render startup timeout - see the Dockerfile fix) and was dead code
  // since nothing ever submitted intent="backup_prices"; removed rather than left to rot.

  return new Response(JSON.stringify({ error: "Invalid intent" }), { status: 400 });
};

const thStyle = { padding: '16px', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.5px', color: '#637381' };

// Column header with a small info icon + tooltip explaining what it means - several of
// these columns (Diamond Base, Original Backup, Live Final Price) aren't self-explanatory
// on first use.
function HeaderWithTooltip({ label, help }) {
  return (
    <InlineStack gap="100" blockAlign="center" wrap={false}>
      <span>{label}</span>
      <Tooltip content={help}>
        <Icon source={InfoIcon} tone="subdued" />
      </Tooltip>
    </InlineStack>
  );
}

export default function Products() {
  const { products, q, status } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const submit = useSubmit();
  const navigation = useNavigation();

  const [selectedVariants, setSelectedVariants] = useState([]);
  const [bulkWeight, setBulkWeight] = useState("");
  
  const [queryValue, setQueryValue] = useState(q || "");
  const [statusValue, setStatusValue] = useState(status || "ALL");

  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [isImporting, setIsImporting] = useState(false);
  
  // Progress Bar State
  const [progressModal, setProgressModal] = useState({
    open: false,
    title: "",
    processedProducts: 0,
    totalProducts: null,   // null until the first response tells us (real total, not a guess)
    variantsProcessed: 0,
  });
  
  // System Check State
  const [isSystemCheckModalOpen, setIsSystemCheckModalOpen] = useState(false);
  const [systemCheckResults, setSystemCheckResults] = useState(null);

  // Shared export logic - used by the toolbar "Export to CSV" button (respects the
  // current selection) and the System Check modal's per-issue export links (always a
  // full-catalog scan for that issue, regardless of what's selected/on-screen, since
  // this page only ever loads the first 50 matching products).
  //
  // Opens the export URL directly in a new top-level tab rather than fetching a blob
  // and triggering an <a download> click from inside the embedded admin iframe - that
  // pattern is a well-known Shopify embedded-app gotcha: browsers routinely block
  // blob-URL downloads triggered from inside a sandboxed cross-origin iframe, silently
  // (no error, nothing happens). A new top-level tab isn't sandboxed, and the server
  // already sends Content-Disposition: attachment, so the browser downloads it natively.
  const handleExport = ({ useSelection = false, issue = null } = {}) => {
    let url = '/api/export';
    const params = new URLSearchParams();
    if (useSelection && selectedVariants.length > 0) {
      params.set('variantIds', JSON.stringify(selectedVariants));
    }
    if (issue) params.set('issue', issue);
    if ([...params].length > 0) url += `?${params.toString()}`;

    window.open(url, '_blank');
  };

  const runSystemCheck = () => {
    const missingWeights = products.reduce((count, p) => count + p.variants.filter(v => !v.goldWeight || parseFloat(v.goldWeight) === 0).length, 0);
    const missingBackups = products.reduce((count, p) => count + p.variants.filter(v => !v.originalPrice?.value).length, 0);
    const totalVariants = products.reduce((count, p) => count + p.variants.length, 0);
    
    setSystemCheckResults({
      missingWeights,
      missingBackups,
      totalVariants,
      passed: missingWeights === 0 && missingBackups === 0,
    });
    setIsSystemCheckModalOpen(true);
  };
  
  const startProgressTask = async (endpoint, title) => {
    setProgressModal({ open: true, title, processedProducts: 0, totalProducts: null, variantsProcessed: 0 });
    let hasNextPage = true;
    let cursor = null;
    let variantsProcessed = 0;
    let totalProducts = null;
    const seenProductIds = new Set(); // dedupes across pages so a product isn't double-counted

    try {
      while (hasNextPage) {
        const formData = new FormData();
        if (cursor) formData.append("cursor", cursor);

        const res = await fetch(endpoint, {
          method: "POST",
          body: formData
        });

        if (!res.ok) throw new Error("Server error");
        const data = await res.json();

        if (!data.success) throw new Error(data.error || "Task failed");

        variantsProcessed += data.variantsProcessed;
        if (data.totalProducts != null) totalProducts = data.totalProducts;
        if (Array.isArray(data.productIds)) {
          for (const id of data.productIds) seenProductIds.add(id);
        }

        setProgressModal({
          open: true,
          title,
          processedProducts: seenProductIds.size,
          totalProducts,
          variantsProcessed,
        });

        hasNextPage = data.hasNextPage;
        cursor = data.nextCursor;
      }
      shopify.toast.show(`${title} completed successfully!`);
    } catch (e) {
      shopify.toast.show(`Error: ${e.message}`, { isError: true });
    } finally {
      setProgressModal(prev => ({ ...prev, open: false }));
      submit({ q: queryValue, status: statusValue }); // refresh page
    }
  };
  
  const handleDropZoneDrop = useCallback(
    (_dropFiles, acceptedFiles, _rejectedFiles) => setImportFile(acceptedFiles[0]),
    [],
  );
  
  const handleImportSubmit = async () => {
    if (!importFile) return;
    setIsImporting(true);
    const formData = new FormData();
    formData.append("file", importFile);
    
    try {
      const res = await fetch("/api/import", {
        method: "POST",
        body: formData
      });
      const data = await res.json();
      if (res.ok) {
        shopify.toast.show(data.message);
        setIsImportModalOpen(false);
        setImportFile(null);
      } else {
        throw new Error(data.error || "Import failed");
      }
    } catch (e) {
      shopify.toast.show(e.message, { isError: true });
    } finally {
      setIsImporting(false);
    }
  };

  useEffect(() => {
    if (fetcher.data?.message) {
      shopify.toast.show(fetcher.data.message);
      setSelectedVariants([]);
    }
  }, [fetcher.data, shopify]);

  const toggleSelect = (variantId) => {
    setSelectedVariants(prev => 
      prev.includes(variantId) ? prev.filter(id => id !== variantId) : [...prev, variantId]
    );
  };

  const toggleProductSelect = (variantIds, isChecked) => {
    if (isChecked) {
      setSelectedVariants(prev => [...new Set([...prev, ...variantIds])]);
    } else {
      setSelectedVariants(prev => prev.filter(id => !variantIds.includes(id)));
    }
  };

  const handleBulkSubmit = () => {
    if (selectedVariants.length === 0) return;
    const formData = new FormData();
    formData.append("intent", "bulk_update");
    formData.append("variantIds", JSON.stringify(selectedVariants));
    formData.append("bulkGoldWeight", bulkWeight);
    fetcher.submit(formData, { method: "POST" });
  };

  const handleFiltersQueryChange = useCallback(
    (value) => {
      setQueryValue(value);
      submit({ q: value, status: statusValue });
    },
    [submit, statusValue],
  );

  const handleStatusChange = useCallback(
    (value) => {
      setStatusValue(value[0]);
      submit({ q: queryValue, status: value[0] });
    },
    [submit, queryValue],
  );

  const filters = [
    {
      key: 'status',
      label: 'Status',
      filter: (
        <Select
          label="Status"
          options={[
            {label: 'All Products', value: 'ALL'},
            {label: 'Needs Weight (New)', value: 'NEEDS_WEIGHT'},
            {label: 'Active Only', value: 'ACTIVE'},
            {label: 'Draft Only', value: 'DRAFT'}
          ]}
          value={statusValue}
          onChange={(val) => handleStatusChange([val])}
        />
      ),
      shortcut: true,
    },
  ];

  const allVariantIds = products.flatMap(p => p.variants.map(v => v.variantId));

  if (navigation.state === "loading" && navigation.location.pathname === "/app/products") {
    return (
      <SkeletonPage primaryAction fullWidth>
        <Layout>
          <Layout.Section>
            <Card>
              <SkeletonBodyText lines={2} />
            </Card>
            <br />
            <Card>
              <SkeletonBodyText lines={10} />
            </Card>
          </Layout.Section>
        </Layout>
      </SkeletonPage>
    );
  }

  const handleGlobalSync = () => {
    setIsSystemCheckModalOpen(false);
    startProgressTask("/api/sync-chunk", "Syncing All Prices");
  };

  return (
    <Page
      title="Products & Bulk Editor"
      fullWidth
      primaryAction={{
        content: 'Sync All Prices',
        icon: CashDollarIcon,
        onAction: runSystemCheck,
        loading: fetcher.state !== "idle"
      }}
      secondaryActions={[
        {
          content: 'Import CSV',
          icon: ImportIcon,
          onAction: () => setIsImportModalOpen(true),
        },
        {
          content: 'Backup Original Prices',
          onAction: () => startProgressTask("/api/backup-chunk", "Backing up Original Prices")
        },
        {
          content: 'Export to CSV',
          icon: ExportIcon,
          onAction: () => handleExport({ useSelection: true }),
        }
      ]}
    >
      <Modal
        open={isImportModalOpen}
        onClose={() => { setIsImportModalOpen(false); setImportFile(null); }}
        title="Import CSV"
        primaryAction={{
          content: 'Upload and Import',
          onAction: handleImportSubmit,
          loading: isImporting,
          disabled: !importFile
        }}
        secondaryActions={[
          {
            content: 'Cancel',
            onAction: () => { setIsImportModalOpen(false); setImportFile(null); }
          }
        ]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <Text as="p">
              Upload the CSV file you exported and modified. Make sure not to change the "Handle" or "Variant SKU" columns.
            </Text>
            <DropZone onDrop={handleDropZoneDrop} variableHeight allowMultiple={false} accept=".csv">
              {importFile ? (
                <BlockStack alignment="center" inlineAlign="center">
                  <Box padding="400">
                    <Text variant="bodyMd" as="p" alignment="center">
                      Ready to upload: <strong>{importFile.name}</strong>
                    </Text>
                  </Box>
                </BlockStack>
              ) : (
                <DropZone.FileUpload actionTitle="Add CSV file" />
              )}
            </DropZone>
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        open={progressModal.open}
        onClose={() => {}}
        title={progressModal.title}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <Text as="p">Please keep this tab open while the operation completes.</Text>
            {progressModal.totalProducts ? (
              <>
                <ProgressBar
                  progress={Math.min((progressModal.processedProducts / progressModal.totalProducts) * 100, 100)}
                  size="small"
                  tone="primary"
                />
                <Text as="p" alignment="center">
                  {progressModal.processedProducts} / {progressModal.totalProducts} products
                  {" "}({Math.round((progressModal.processedProducts / progressModal.totalProducts) * 100)}%)
                </Text>
              </>
            ) : (
              <>
                {/* Endpoints that don't report a total (e.g. Backup Original Prices) fall back
                    to an indeterminate-feeling bar rather than claiming a false percentage. */}
                <ProgressBar progress={Math.min((progressModal.variantsProcessed / (progressModal.variantsProcessed + 25)) * 100, 95)} size="small" tone="primary" />
                <Text as="p" alignment="center">
                  Processed: {progressModal.variantsProcessed} variants
                </Text>
              </>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        open={isSystemCheckModalOpen}
        onClose={() => setIsSystemCheckModalOpen(false)}
        title="Pre-Flight System Check"
        primaryAction={{
          content: systemCheckResults?.passed ? 'Proceed with Sync' : 'Sync Anyway (Override)',
          onAction: handleGlobalSync,
          destructive: !systemCheckResults?.passed
        }}
        secondaryActions={[
          {
            content: 'Cancel',
            onAction: () => setIsSystemCheckModalOpen(false),
          },
        ]}
      >
        <Modal.Section>
          {systemCheckResults && (
            <BlockStack gap="400">
              {systemCheckResults.passed ? (
                <Text as="p" tone="success">✅ All systems go! Your store is fully configured and ready for price synchronization.</Text>
              ) : (
                <Text as="p" tone="critical">⚠️ Warning: The system check found potential issues. Syncing now may result in incomplete data.</Text>
              )}

              <Text as="p" tone="subdued" variant="bodySm">
                These counts are from the current page's loaded products only. Use "Export list" for a complete,
                full-catalog CSV of the actual issue - it may find more than what's shown here.
              </Text>

              <BlockStack gap="200">
                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="150">
                    <Text as="span" fontWeight="bold">Missing Gold Weights: </Text>
                    {systemCheckResults.missingWeights > 0 ? (
                      <Text as="span" tone="critical">{systemCheckResults.missingWeights} variants (this page)</Text>
                    ) : (
                      <Text as="span" tone="success">0 variants (this page)</Text>
                    )}
                  </InlineStack>
                  <Button
                    size="micro"
                    icon={ExportIcon}
                    onClick={() => handleExport({ issue: "missing_weight" })}
                  >
                    Export list
                  </Button>
                </InlineStack>

                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="150">
                    <Text as="span" fontWeight="bold">Missing Original Price Backups: </Text>
                    {systemCheckResults.missingBackups > 0 ? (
                      <Text as="span" tone="critical">{systemCheckResults.missingBackups} variants (this page)</Text>
                    ) : (
                      <Text as="span" tone="success">0 variants (this page)</Text>
                    )}
                  </InlineStack>
                  <Button
                    size="micro"
                    icon={ExportIcon}
                    onClick={() => handleExport({ issue: "missing_backup" })}
                  >
                    Export list
                  </Button>
                </InlineStack>
              </BlockStack>
            </BlockStack>
          )}
        </Modal.Section>
      </Modal>
      
      <Layout>
        <Layout.Section>
          
          <Card padding="0">
            <div style={{padding: '16px'}}>
              <Filters
                queryValue={queryValue}
                filters={filters}
                onQueryChange={handleFiltersQueryChange}
                onQueryClear={() => handleFiltersQueryChange("")}
                onClearAll={() => {
                  setQueryValue("");
                  setStatusValue("ALL");
                  submit({ q: "", status: "ALL" });
                }}
              />
            </div>

            {selectedVariants.length > 0 && (
              <div style={{padding: '16px', backgroundColor: '#f4f6f8', borderTop: '1px solid #dfe3e8', borderBottom: '1px solid #dfe3e8'}}>
                <InlineStack gap="400" align="start" blockAlign="center" wrap>
                  <Text variant="bodyMd" fontWeight="bold">{selectedVariants.length} variants selected</Text>
                  <div style={{width: '200px', minWidth: '160px'}}>
                    <TextField
                      type="number"
                      placeholder="Bulk set Gold Weight"
                      value={bulkWeight}
                      onChange={setBulkWeight}
                      autoComplete="off"
                    />
                  </div>
                  <Button onClick={handleBulkSubmit} variant="primary" loading={fetcher.state !== "idle"}>
                    Apply to Selected
                  </Button>
                </InlineStack>
              </div>
            )}

        {/* Grouped Table (Kept Custom for Nested Variants UI). overflowX: auto instead of
            hidden - on narrow/embedded viewports this scrolls the table horizontally
            instead of silently clipping columns off the right edge. */}
        <div style={{ overflowX: 'auto', backgroundColor: 'white' }}>
          <table style={{width: '100%', minWidth: '900px', borderCollapse: 'collapse', textAlign: 'left'}}>
            <thead>
              <tr style={{borderBottom: '1px solid #e1e3e5', backgroundColor: '#f9fafb'}}>
                <th style={{padding: '16px', width: '40px'}}>
                  <input
                    type="checkbox"
                    onChange={(e) => {
                      if (e.target.checked) setSelectedVariants(allVariantIds);
                      else setSelectedVariants([]);
                    }}
                    checked={allVariantIds.length > 0 && selectedVariants.length === allVariantIds.length}
                    style={{width: '16px', height: '16px', cursor: 'pointer'}}
                  />
                </th>
                <th style={thStyle}>Product / Variant</th>
                <th style={thStyle}>
                  <HeaderWithTooltip
                    label="Diamond Base (₹)"
                    help="The diamond cost used in pricing. Auto-filled from the product description when it can be parsed; otherwise enter it manually per variant."
                  />
                </th>
                <th style={thStyle}>Gold Weight (g)</th>
                <th style={thStyle}>
                  <HeaderWithTooltip
                    label="Original Backup"
                    help="The variant's price before dynamic pricing first touched it. Saved automatically on first sync so you can always restore to it from the Dashboard."
                  />
                </th>
                <th style={thStyle}>
                  <HeaderWithTooltip
                    label="Live Final Price"
                    help="The current storefront price, plus a breakdown of gold, making charge, diamond, and GST that produced it."
                  />
                </th>
                <th style={thStyle}>Action</th>
              </tr>
            </thead>
            <tbody>
              {products.length === 0 && (
                <tr>
                  <td colSpan="7" style={{padding: '32px', textAlign: 'center'}}>
                    <BlockStack gap="200" inlineAlign="center">
                      <Text as="p" tone="subdued">
                        {q || status !== "ALL"
                          ? "No products match your search/filter."
                          : "No products found."}
                      </Text>
                      {(q || status !== "ALL") && (
                        <Button
                          onClick={() => {
                            setQueryValue("");
                            setStatusValue("ALL");
                            submit({ q: "", status: "ALL" });
                          }}
                        >
                          Clear filters
                        </Button>
                      )}
                    </BlockStack>
                  </td>
                </tr>
              )}
              {products.map(product => (
                <ProductGroup
                  key={product.id}
                  product={product}
                  fetcher={fetcher}
                  selectedVariants={selectedVariants}
                  onToggleSelect={toggleSelect}
                  onToggleProductSelect={toggleProductSelect}
                />
              ))}
            </tbody>
          </table>
        </div>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

function ProductGroup({ product, fetcher, selectedVariants, onToggleSelect, onToggleProductSelect }) {
  const [isOpen, setIsOpen] = useState(false);
  const allVariantIds = product.variants.map(v => v.variantId);
  const isAllSelected = allVariantIds.length > 0 && allVariantIds.every(id => selectedVariants.includes(id));

  return (
    <>
      <tr style={{backgroundColor: '#f9fafb', borderBottom: '1px solid #e1e3e5', cursor: 'pointer'}} onClick={() => setIsOpen(!isOpen)}>
        <td style={{padding: '16px'}} onClick={(e) => e.stopPropagation()}>
          <InlineStack gap="300" align="start" blockAlign="center">
            <input 
              type="checkbox" 
              checked={isAllSelected}
              onChange={(e) => onToggleProductSelect(allVariantIds, e.target.checked)}
              style={{width: '16px', height: '16px', cursor: 'pointer'}}
            />
            <div onClick={() => setIsOpen(!isOpen)} style={{display: 'flex', alignItems: 'center'}}>
              <Icon source={isOpen ? ChevronUpIcon : ChevronDownIcon} color="base" />
            </div>
          </InlineStack>
        </td>
        <td colSpan="6" style={{padding: '16px'}}>
          <InlineStack gap="300" align="start" blockAlign="center">
            <Text variant="bodyMd" fontWeight="bold">{product.title}</Text>
            <Badge tone={product.status === 'ACTIVE' ? 'success' : 'info'}>
              {product.status}
            </Badge>
            {product.variants.some(v => !v.goldWeight || parseFloat(v.goldWeight) === 0) && (
              <Badge tone="warning">NEW (Needs Weight)</Badge>
            )}
          </InlineStack>
        </td>
      </tr>
      {isOpen && product.variants.map((variant, index) => (
        <VariantRow 
          key={variant.variantId} 
          variant={variant} 
          fetcher={fetcher} 
          isSelected={selectedVariants.includes(variant.variantId)} 
          onToggle={() => onToggleSelect(variant.variantId)}
          isLast={index === product.variants.length - 1}
        />
      ))}
    </>
  );
}

function VariantRow({ variant, fetcher, isSelected, onToggle, isLast }) {
  let breakdown = null;
  try {
    if (variant.priceBreakdown) {
      breakdown = JSON.parse(variant.priceBreakdown);
    }
  } catch (e) {}

  const isSmartParsed = !!breakdown?.parsedDiamonds;
  const initialDiamondPrice = isSmartParsed ? breakdown.diamondPrice.toString() : variant.diamondPrice;

  const [diamondPrice, setDiamondPrice] = useState(initialDiamondPrice);
  const [goldWeight, setGoldWeight] = useState(variant.goldWeight);

  const hasChanged = diamondPrice !== initialDiamondPrice || goldWeight !== variant.goldWeight;

  const handleSave = () => {
    if (!hasChanged) return;
    const formData = new FormData();
    formData.append("intent", "save_variant");
    formData.append("variantId", variant.variantId);
    formData.append("diamondPrice", diamondPrice);
    formData.append("goldWeight", goldWeight);
    fetcher.submit(formData, { method: "POST", preventScrollReset: true });
  };

  return (
    <tr style={{borderBottom: isLast ? 'none' : '1px solid #f4f6f8', transition: 'background-color 0.2s'}} onMouseOver={e => e.currentTarget.style.backgroundColor = '#fcfcfc'} onMouseOut={e => e.currentTarget.style.backgroundColor = 'transparent'}>
      <td style={{padding: '16px'}}>
        <input type="checkbox" checked={isSelected} onChange={onToggle} style={{width: '16px', height: '16px', cursor: 'pointer'}} />
      </td>
      <td style={{padding: '16px', paddingLeft: '32px'}}>
        <Text variant="bodyMd" color="subdued">{variant.variantTitle !== 'Default Title' ? variant.variantTitle : 'Default Variant'}</Text>
      </td>
      <td style={{padding: '16px'}}>
        <BlockStack gap="100">
          <TextField
            type="number"
            step="0.01"
            value={diamondPrice}
            onChange={setDiamondPrice}
            prefix="₹"
            autoComplete="off"
            disabled={isSmartParsed}
          />
          {isSmartParsed && (
            <Badge tone="info" size="small">Auto-calculated from description</Badge>
          )}
        </BlockStack>
      </td>
      <td style={{padding: '16px'}}>
        <TextField
          type="number"
          step="0.01"
          value={goldWeight}
          onChange={setGoldWeight}
          onBlur={handleSave}
          placeholder="0.00"
          autoComplete="off"
        />
      </td>
      <td style={{padding: '16px'}}>
        {variant.originalPrice?.value ? `₹${parseFloat(variant.originalPrice.value).toFixed(2)}` : <Text tone="subdued">None</Text>}
      </td>
      <td style={{padding: '16px'}}>
        <Text variant="bodyMd" fontWeight="bold">₹{parseFloat(variant.price).toFixed(2)}</Text>
        {breakdown && breakdown.settings && (
          <BlockStack gap="025">
            <Text as="p" variant="bodySm" tone="subdued">
              {breakdown.settings.karat || "24K"} gold ({breakdown.settings.goldWeight}g × ₹{breakdown.settings.goldRate}) — ₹{breakdown.goldValue}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Making charge ({breakdown.settings.goldWeight}g × ₹{breakdown.settings.makingChargePerGram}) — ₹{breakdown.makingCharges}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Diamond — ₹{breakdown.diamondPrice}
            </Text>
            {breakdown.parsedDiamonds && breakdown.parsedDiamonds.map((d, i) => (
              <Text as="p" variant="bodySm" tone="subdued" key={i}>
                &nbsp;&nbsp;↳ {d.quantity}× {d.shape} ({d.carat}ct × ₹{d.rate}) — ₹{d.price}
              </Text>
            ))}
            <Text as="p" variant="bodySm" tone="subdued">
              GST ({breakdown.settings.gstPercentage}%) — ₹{breakdown.gst}
            </Text>
            {breakdown.diamondParsingError && (
              <Badge tone="critical">Diamond text couldn't be parsed - check description</Badge>
            )}
          </BlockStack>
        )}
      </td>
      <td style={{padding: '16px'}}>
        {fetcher.state !== "idle" && hasChanged ? (
          <Badge tone="info">Saving...</Badge>
        ) : (
          <Badge tone={hasChanged ? "warning" : "success"}>{hasChanged ? "Unsaved" : "Saved"}</Badge>
        )}
      </td>
    </tr>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};

// Fetches the current 24K gold rate (₹/gram) from whichever provider is configured.
// Both providers return a single 24K base rate - the app's own karat-multiplier logic
// (9K/10K/14K/18K/22K/24K) is applied on top of this uniformly, so neither integration
// needs to know anything about karats itself.

async function fetchFromGoldApiIo(apiKey) {
  if (!apiKey || apiKey.trim() === '') {
    throw new Error("GoldAPI.io requires an API key");
  }
  const response = await fetch('https://www.goldapi.io/api/XAU/INR', {
    headers: { 'x-access-token': apiKey }
  });
  const data = await response.json();
  if (data && data.price_gram_24k) {
    return data.price_gram_24k;
  }
  throw new Error("Invalid response from GoldAPI.io");
}

// IBJA (India Bullion & Jewellers Association) reference rate - India's actual local
// retail/bullion rate (includes import duty etc.), unlike GoldAPI.io's raw international
// spot-to-INR conversion. Free, no API key. Community-hosted (unofficial), so treat it
// as best-effort like any other external dependency - the caller's existing fallback
// still applies if this fails.
async function fetchFromIbja() {
  const response = await fetch('https://ibja-api.vercel.app/latest');
  const data = await response.json();
  // Rates are published per 10 grams for 999 (24K) purity; PM is the day's official
  // published reference, AM a provisional/earlier session figure - prefer PM, fall back
  // to AM if PM isn't populated yet (e.g. early in the day before it's published).
  const per10Grams = parseFloat(data?.lblGold999_PM) || parseFloat(data?.lblGold999_AM);
  if (per10Grams && per10Grams > 0) {
    return per10Grams / 10;
  }
  throw new Error("Invalid response from IBJA API");
}

export async function fetchLiveGoldRate(apiKey, provider = "goldapi") {
  try {
    if (provider === "ibja") {
      return await fetchFromIbja();
    }
    return await fetchFromGoldApiIo(apiKey);
  } catch (err) {
    console.error(`Gold rate fetch error (${provider}):`, err);
    // Fallback simulator if the configured provider fails - unchanged from before.
    const baseRate = 9800;
    const fluctuation = Math.floor(Math.random() * 200) - 100; // -100 to +100
    return baseRate + fluctuation;
  }
}

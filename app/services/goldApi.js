export async function fetchLiveGoldRate(apiKey) {
  if (apiKey && apiKey.trim() !== '') {
    try {
      const response = await fetch('https://www.goldapi.io/api/XAU/INR', {
        headers: { 'x-access-token': apiKey }
      });
      const data = await response.json();
      if (data && data.price_gram_24k) {
        return data.price_gram_24k;
      }
      throw new Error("Invalid response from GoldAPI");
    } catch (err) {
      console.error("GoldAPI fetch error:", err);
      // Fallback below if API fails
    }
  }

  // Fallback simulator if no API key or API fails
  const baseRate = 9800;
  const fluctuation = Math.floor(Math.random() * 200) - 100; // -100 to +100
  return baseRate + fluctuation;
}

export function calculateFinalPrice({
  diamondPrice,
  goldWeight,
  goldRate,
  makingChargePerGram,
  gstPercentage,
  compareAtMarkupPercentage = 25
}) {
  const goldValue = goldWeight * goldRate;
  const makingCharges = goldWeight * makingChargePerGram;
  const subtotal = diamondPrice + goldValue + makingCharges;
  const gst = subtotal * (gstPercentage / 100);
  const finalPrice = subtotal + gst;
  const compareAtPrice = finalPrice * (1 + compareAtMarkupPercentage / 100);

  return {
    diamondPrice: Number(diamondPrice.toFixed(2)),
    goldValue: Number(goldValue.toFixed(2)),
    makingCharges: Number(makingCharges.toFixed(2)),
    gst: Number(gst.toFixed(2)),
    finalPrice: Number(finalPrice.toFixed(2)),
    compareAtPrice: Number(compareAtPrice.toFixed(2)),
  };
}

export function extractTextFromRichText(node) {
  if (typeof node === 'string') return node;
  if (!node) return "";
  if (node.type === 'text' && node.value) {
    return node.value;
  }
  if (node.children && Array.isArray(node.children)) {
    const childTexts = node.children.map(extractTextFromRichText).filter(Boolean);
    if (node.type === 'paragraph' || node.type === 'list-item') {
      return childTexts.join("") + "\n";
    }
    return childTexts.join("");
  }
  return "";
}

export function parseDiamondText(diamondInfoText, diamondBasePrice = 26000) {
  let diamondParsingError = false;
  let parsedDiamonds = [];
  let calculatedDiamondPrice = 0;

  if (diamondInfoText) {
    let cleanText = "";
    if (diamondInfoText.trim().startsWith('{')) {
      try {
        const jsonObj = JSON.parse(diamondInfoText);
        cleanText = extractTextFromRichText(jsonObj);
      } catch(e) {
        cleanText = diamondInfoText;
      }
    } else {
      cleanText = diamondInfoText.replace(/<[^>]*>?/gm, '\n').replace(/&nbsp;/g, ' ');
    }

    const lines = cleanText.split('\n').map(l => l.trim()).filter(Boolean);
    
    let shapes = [];
    let carats = [];
    let quantities = [];

    for (const line of lines) {
      const lowerLine = line.toLowerCase();
      if (lowerLine.startsWith("shape")) {
        const parts = line.split(':');
        if (parts.length > 1) {
          shapes = parts[1].trim().split(/\s+/).filter(Boolean);
        }
      }
      if (lowerLine.startsWith("carat")) {
        const parts = line.split(':');
        if (parts.length > 1) {
          const caratWords = parts[1].trim().split(/\s+/).filter(Boolean);
          carats = caratWords.map(w => parseFloat(w.replace(/[^\d.]/g, '')));
        }
      }
      if (lowerLine.startsWith("quantity")) {
        const parts = line.split(':');
        if (parts.length > 1) {
          const qtyWords = parts[1].trim().split(/\s+/).filter(Boolean);
          quantities = qtyWords.map(w => parseInt(w.replace(/[^\d]/g, ''), 10) || 1);
        }
      }
    }

    if (shapes.length > 0) {
      if (shapes.length === carats.length) {
        for (let i = 0; i < shapes.length; i++) {
          const shape = shapes[i];
          const carat = carats[i];
          const qty = quantities[i] || 1;
          
          let rate = diamondBasePrice;
          const shapeLower = shape.toLowerCase();
          if (shapeLower !== "round" && shapeLower !== "emerald") {
              rate = diamondBasePrice * 1.25;
          }
          const price = rate * carat;
          calculatedDiamondPrice += price;
          
          parsedDiamonds.push({ shape, carat, quantity: qty, rate, price });
        }
      } else {
        diamondParsingError = true;
      }
    }
  }

  return {
    calculatedDiamondPrice,
    parsedDiamonds,
    diamondParsingError,
  };
}

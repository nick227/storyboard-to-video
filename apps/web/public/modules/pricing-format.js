const USAGE_KEY_LABELS = {
  inputTokens: 'Input',
  cachedInputTokens: 'Cached Input',
  outputTokens: 'Output',
  inputTextTokens: 'Input Text',
  inputImageTokens: 'Input Image',
  outputImageTokens: 'Output Image',
  outputTextOrThinkingTokens: 'Output Text/Thinking',
};

export function formatRateCard(card) {
  if (!card) return '';
  if (card.type === 'token_components') {
    const comps = card.components || [];
    return comps.map((c) => {
      const ratePerM = c.nanoUsdPerMillion / 1e9;
      const keyLabel = USAGE_KEY_LABELS[c.usageKey] || c.usageKey;
      return `${keyLabel}: $${ratePerM.toFixed(4)}/M`;
    }).join(', ');
  }
  if (card.type === 'linear_steps') {
    const baseUSD = card.baseNanoUsd / 1e9;
    return `$${baseUSD.toFixed(4)} per ${card.baseUnits} steps (scaled linearly)`;
  }
  if (card.type === 'flat') {
    const rate = card.nanoUsdPerUnit / 1e9;
    return `$${rate.toFixed(4)} flat rate`;
  }
  return JSON.stringify(card);
}

export function formatMarkup(markup) {
  if (!markup) return 'No markup configured — provider cost is passed through unchanged.';
  const percent = Number(markup.markupBasisPoints || 0) / 100;
  const fixedUSD = Number(markup.fixedNanoUsd || 0) / 1e9;
  if (percent === 0 && fixedUSD === 0) return 'No markup is currently applied — you pay provider cost, 1:1.';
  const parts = [];
  if (percent !== 0) parts.push(`+${percent.toFixed(2)}%`);
  if (fixedUSD !== 0) parts.push(`+$${fixedUSD.toFixed(6)} flat per generation`);
  return `${parts.join(' ')} over provider cost`;
}

export function formatCreditRate(creditRate) {
  if (!creditRate) return 'No active credit rate configured.';
  const usdPerCredit = Number(creditRate.nanoUsdPerSiteCredit || 0) / 1e9;
  return `1 credit = $${usdPerCredit.toFixed(6)} of provider cost + markup`;
}

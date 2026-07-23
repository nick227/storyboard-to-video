import { creditStore } from '../core/store.js';

export function formatCredits(value) {
  return (Number(value || 0) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export async function refreshCreditBalance() {
  try {
    const response = await fetch('/api/billing/balance');
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || 'Balance unavailable');
    creditStore.set({
      availableCreditMicros: data.account?.availableCreditMicros ?? '0',
      reservedCreditMicros: data.account?.reservedCreditMicros ?? '0',
      loaded: true,
      error: false,
    });
  } catch (_) {
    creditStore.set({ loaded: true, error: true });
  }
  return creditStore.get();
}

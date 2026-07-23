// Dezgo Flux (FLUX.1 Schnell) — https://dev.dezgo.com/API/ `/text2image_flux`
// Flux steps: API default 4, range 2–20. We default to 8 for quality above the speed default.
// SD1 steps (text2image / image2image): API default 30, range 10–150.
const DEZGO_FLUX_MODEL = 'flux_1_schnell';
const DEZGO_SD1_MODEL = 'text2image';
const DEZGO_FLUX_DEFAULT_STEPS = 8;
const DEZGO_SD1_DEFAULT_STEPS = 30;
const DEZGO_BILLING_PROVIDER = 'dezgo';

function isDezgoProvider(provider) {
  return provider === 'dezgo' || provider === 'dezgo_flux';
}

function isDezgoFluxProvider(provider) {
  return provider === 'dezgo_flux';
}

function isDezgoFlux(model) {
  return String(model || '').toLowerCase().includes('flux');
}

function dezgoModelForProvider(provider) {
  return isDezgoFluxProvider(provider) ? DEZGO_FLUX_MODEL : DEZGO_SD1_MODEL;
}

function configuredNumber(env, key) {
  if (env[key] == null || String(env[key]).trim() === '') return null;
  return Number(env[key]);
}

function dezgoSteps(env = {}, model = DEZGO_FLUX_MODEL) {
  if (isDezgoFlux(model)) {
    const raw = configuredNumber(env, 'DEZGO_STEPS') ?? DEZGO_FLUX_DEFAULT_STEPS;
    return Math.min(20, Math.max(2, raw));
  }
  const raw = configuredNumber(env, 'DEZGO_SD1_STEPS') ?? configuredNumber(env, 'DEZGO_STEPS') ?? DEZGO_SD1_DEFAULT_STEPS;
  return Math.min(150, Math.max(10, raw));
}

function dezgoBillingProvider(provider) {
  return isDezgoProvider(provider) ? DEZGO_BILLING_PROVIDER : provider;
}

module.exports = {
  DEZGO_BILLING_PROVIDER,
  DEZGO_FLUX_DEFAULT_STEPS,
  DEZGO_FLUX_MODEL,
  DEZGO_SD1_DEFAULT_STEPS,
  DEZGO_SD1_MODEL,
  dezgoBillingProvider,
  dezgoModelForProvider,
  dezgoSteps,
  isDezgoFlux,
  isDezgoFluxProvider,
  isDezgoProvider,
};

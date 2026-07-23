// Dezgo Flux (FLUX.1 Schnell) — https://dev.dezgo.com/API/ `/text2image_flux`
// Only Flux model currently published on /info: flux_1_schnell (family flux_schnell).
// Flux steps: API default 4, range 2–20. We default to 8 for quality above the speed default.
// SD1 steps (text2image / image2image): API default 30, range 10–150.
const DEZGO_FLUX_MODEL = 'flux_1_schnell';
const DEZGO_SD1_MODEL = 'text2image';
const DEZGO_FLUX_DEFAULT_STEPS = 8;
const DEZGO_SD1_DEFAULT_STEPS = 30;

function dezgoModel(env = {}) {
  return env.DEZGO_MODEL || DEZGO_FLUX_MODEL;
}

function isDezgoFlux(model) {
  return String(model || '').toLowerCase().includes('flux');
}

function configuredNumber(env, key) {
  if (env[key] == null || String(env[key]).trim() === '') return null;
  return Number(env[key]);
}

function dezgoSteps(env = {}, model = dezgoModel(env)) {
  if (isDezgoFlux(model)) {
    const raw = configuredNumber(env, 'DEZGO_STEPS') ?? DEZGO_FLUX_DEFAULT_STEPS;
    return Math.min(20, Math.max(2, raw));
  }
  // When Flux is the primary model, DEZGO_STEPS is Flux-ranged (2–20) and must not drive SD1.
  const primaryIsFlux = isDezgoFlux(dezgoModel(env));
  const raw = configuredNumber(env, 'DEZGO_SD1_STEPS')
    ?? (primaryIsFlux ? DEZGO_SD1_DEFAULT_STEPS : (configuredNumber(env, 'DEZGO_STEPS') ?? DEZGO_SD1_DEFAULT_STEPS));
  return Math.min(150, Math.max(10, raw));
}

module.exports = {
  DEZGO_FLUX_DEFAULT_STEPS,
  DEZGO_FLUX_MODEL,
  DEZGO_SD1_DEFAULT_STEPS,
  DEZGO_SD1_MODEL,
  dezgoModel,
  dezgoSteps,
  isDezgoFlux,
};

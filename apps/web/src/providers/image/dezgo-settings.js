// Dezgo Flux (FLUX.1 Schnell) — https://dev.dezgo.com/API/ `/text2image_flux`
// Only Flux model currently published on /info: flux_1_schnell (family flux_schnell).
// Steps: API default 4, range 2–20. We default to 8 for quality above the speed default.
const DEZGO_FLUX_MODEL = 'flux_1_schnell';
const DEZGO_SD1_MODEL = 'text2image';
const DEZGO_FLUX_DEFAULT_STEPS = 8;
const DEZGO_SD1_DEFAULT_STEPS = 25;

function dezgoModel(env = {}) {
  return env.DEZGO_MODEL || DEZGO_FLUX_MODEL;
}

function isDezgoFlux(model) {
  return String(model || '').toLowerCase().includes('flux');
}

function dezgoSteps(env = {}, model = dezgoModel(env)) {
  const raw = env.DEZGO_STEPS != null && String(env.DEZGO_STEPS).trim() !== ''
    ? Number(env.DEZGO_STEPS)
    : (isDezgoFlux(model) ? DEZGO_FLUX_DEFAULT_STEPS : DEZGO_SD1_DEFAULT_STEPS);
  if (!isDezgoFlux(model)) return raw;
  return Math.min(20, Math.max(2, raw));
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

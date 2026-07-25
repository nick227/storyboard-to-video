const TEXT_PROVIDERS = new Set(['gemini', 'openai', 'stub']);
const IMAGE_PROVIDERS = new Set(['gemini', 'openai', 'dezgo', 'dezgo_flux', 'stub', 'pixabay', 'local-safetensors']);
const AUDIO_PROVIDERS = new Set(['elevenlabs', 'piper', 'spark', 'stub']);
// Freesound (sfx) and Jamendo (music) are planned next; only pixabay is implemented today.
const STOCK_PROVIDERS = new Set(['pixabay']);

module.exports = { AUDIO_PROVIDERS, IMAGE_PROVIDERS, STOCK_PROVIDERS, TEXT_PROVIDERS };

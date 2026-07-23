const TEXT_PROVIDERS = new Set(['gemini', 'openai', 'stub']);
const IMAGE_PROVIDERS = new Set(['gemini', 'openai', 'dezgo', 'dezgo_flux', 'stub']);
const AUDIO_PROVIDERS = new Set(['elevenlabs', 'piper', 'spark', 'stub']);

module.exports = { AUDIO_PROVIDERS, IMAGE_PROVIDERS, TEXT_PROVIDERS };

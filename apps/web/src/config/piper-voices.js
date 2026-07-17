// Curated catalog of Piper voices this app ships with. Extend by adding an
// entry here (id must match the rhasspy/piper-voices HF repo file naming:
// {locale}-{speaker}-{quality}) — setup-piper.js and voice.service.js both
// read from this single list.
const PIPER_VOICE_CATALOG = [
  { id: 'en_US-lessac-medium', label: 'Lessac — US, neutral' },
  { id: 'en_US-amy-medium', label: 'Amy — US, female' },
  { id: 'en_US-ryan-medium', label: 'Ryan — US, male' },
  { id: 'en_US-hfc_female-medium', label: 'HFC Female — US, female' },
  { id: 'en_US-hfc_male-medium', label: 'HFC Male — US, male' },
  { id: 'en_GB-alan-medium', label: 'Alan — UK, male' },
  { id: 'en_GB-jenny_dioco-medium', label: 'Jenny — UK, female' },
];

function piperVoiceHfPaths(id) {
  const [locale, speaker, quality] = id.split('-');
  const lang = locale.split('_')[0];
  const base = `https://huggingface.co/rhasspy/piper-voices/resolve/main/${lang}/${locale}/${speaker}/${quality}/${id}`;
  return { onnxUrl: `${base}.onnx`, configUrl: `${base}.onnx.json` };
}

module.exports = { PIPER_VOICE_CATALOG, piperVoiceHfPaths };

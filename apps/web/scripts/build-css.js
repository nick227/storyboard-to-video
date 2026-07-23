const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const webRoot = path.join(__dirname, '..');

const BUNDLES = [
  { name: 'studio', source: 'index.css', output: 'styles.css', maxBytes: 70_000, bundle: true },
  { name: 'auth', source: 'auth-index.css', output: 'auth.css', maxBytes: 8_000, bundle: true },
  { name: 'admin', source: 'pages/admin.css', output: 'admin.css', maxBytes: 6_000 },
  { name: 'credits', source: 'pages/credits.css', output: 'credits.css', maxBytes: 6_000 },
  { name: 'landing', source: 'pages/landing.css', output: 'landing.css', maxBytes: 10_000, bundle: true },
  { name: 'public scripts', source: 'pages/scripts-public.css', output: 'scripts-public.css', maxBytes: 11_000 },
  { name: 'text to speech', source: 'pages/text-to-speech.css', output: 'text-to-speech.css', maxBytes: 2_500 },
  {
    name: 'top bar',
    source: 'shared/topbar.css',
    output: 'topbar.css',
    maxBytes: 9_000,
    bundle: true,
    // Remote @import cannot be resolved by lightningcss --bundle; prepend after minify.
    prepend: "@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;650;700;800&display=swap');",
  },
  {
    name: 'screenplay editor',
    source: 'components/screenplay-editor.css',
    output: 'screenplay-editor/screenplay-editor-standalone.css',
    maxBytes: 16_000,
    bundle: true,
    prepend: "@import url('https://fonts.googleapis.com/css2?family=Courier+Prime:ital,wght@0,400;0,700;1,400;1,700&display=swap');",
  },
];

function buildCss() {
  const binary = path.join(
    webRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'lightningcss.cmd' : 'lightningcss',
  );

  for (const bundle of BUNDLES) {
    const source = path.join(webRoot, 'stylesheets', bundle.source);
    const output = path.join(webRoot, 'public', 'css', bundle.output);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const args = [...(bundle.bundle ? ['--bundle'] : []), '--minify', source, '-o', output];
    const result = spawnSync(binary, args, {
      cwd: webRoot,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
    if (bundle.prepend) {
      const css = fs.readFileSync(output, 'utf8');
      fs.writeFileSync(output, `${bundle.prepend}${css}`);
    }
  }
}

if (require.main === module) buildCss();

module.exports = { BUNDLES, buildCss };

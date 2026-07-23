const fs = require('node:fs');
const path = require('node:path');
const { BUNDLES } = require('./build-css');

const webRoot = path.join(__dirname, '..');
const sourceRoot = path.join(webRoot, 'stylesheets');
const outputRoot = path.join(webRoot, 'public', 'css');
const manifestPath = path.join(sourceRoot, 'index.css');
const authManifestPath = path.join(sourceRoot, 'auth-index.css');
const expectedModules = [
  '00-foundation.css',
  '01-studio-shell-workflow.css',
  '02-script.css',
  '03-setup-references.css',
  '04-storyboard.css',
  '05-dialogs-voice.css',
  '06-responsive.css',
  '07-timeline-utilities.css',
  '08-narration.css',
  '09-auth.css',
  '10-style-library.css',
  '11-usage.css',
];

function fail(message) {
  console.error(`CSS check failed: ${message}`);
  process.exitCode = 1;
}

function importedModules(source) {
  return [...source.matchAll(/@import\s+["']\.\/([^"']+)["'];/g)].map((match) => match[1]);
}

function duplicateProperties(source, filename) {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of withoutComments.matchAll(rulePattern)) {
    const selector = match[1].trim();
    if (selector.startsWith('@') || selector === 'from' || selector === 'to' || /^\d+%$/.test(selector)) continue;

    const properties = [...match[2].matchAll(/(?:^|;)\s*([-\w]+)\s*:/g)].map((property) => property[1]);
    const duplicates = [...new Set(properties.filter((property, index) => properties.indexOf(property) !== index))];
    if (duplicates.length) fail(`${filename}: "${selector}" repeats ${duplicates.join(', ')}`);
  }
}

function listCssFiles(root, relative = '') {
  const directory = path.join(root, relative);
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(relative, entry.name);
    return entry.isDirectory() ? listCssFiles(root, child) : (entry.name.endsWith('.css') ? [child] : []);
  });
}

const manifest = fs.readFileSync(manifestPath, 'utf8');
const imports = importedModules(manifest);
const expectedStudioModules = expectedModules.filter((moduleName) => moduleName !== '09-auth.css');
if (JSON.stringify(imports) !== JSON.stringify(expectedStudioModules)) {
  fail('stylesheets/index.css imports must match the documented module order');
}
const authImports = importedModules(fs.readFileSync(authManifestPath, 'utf8'));
if (JSON.stringify(authImports) !== JSON.stringify(['00-foundation.css', '09-auth.css'])) {
  fail('stylesheets/auth-index.css must contain only the shared foundation and authentication module');
}

for (const moduleName of expectedModules) {
  const modulePath = path.join(sourceRoot, moduleName);
  if (!fs.existsSync(modulePath)) {
    fail(`missing module ${moduleName}`);
  }
}

let sourceBytes = 0;
const authoredFiles = listCssFiles(sourceRoot);
for (const sourceName of authoredFiles) {
  const modulePath = path.join(sourceRoot, sourceName);
  const source = fs.readFileSync(modulePath, 'utf8');
  sourceBytes += Buffer.byteLength(source);
  const lineCount = source.split('\n').length;
  if (lineCount > 700) fail(`${sourceName} has ${lineCount} lines; split modules before they exceed 700`);
  duplicateProperties(source, sourceName);
}

if (sourceBytes > 145_000) fail(`authored CSS is ${sourceBytes} bytes; budget is 145,000`);

const expectedOutputs = BUNDLES.map((bundle) => bundle.output).sort();
const actualOutputs = listCssFiles(outputRoot).sort();
if (JSON.stringify(actualOutputs) !== JSON.stringify(expectedOutputs)) {
  fail(`public/css must contain only generated bundles: ${expectedOutputs.join(', ')}`);
}

for (const bundle of BUNDLES) {
  const outputPath = path.join(outputRoot, bundle.output);
  if (!fs.existsSync(outputPath)) {
    fail(`public/css/${bundle.output} has not been built`);
    continue;
  }
  const output = fs.readFileSync(outputPath, 'utf8');
  const outputBytes = Buffer.byteLength(output);
  if (outputBytes > bundle.maxBytes) {
    fail(`${bundle.output} is ${outputBytes} bytes; budget is ${bundle.maxBytes.toLocaleString()}`);
  }
}

const studioOutput = fs.readFileSync(path.join(outputRoot, 'styles.css'), 'utf8');
if (!studioOutput.includes('.confirm-video-summary[hidden]')) {
  fail('generated CSS is missing the hidden regeneration-summary rule');
}

if (!process.exitCode) {
  console.log(`CSS check passed: ${authoredFiles.length} source files, ${BUNDLES.length} generated bundles, ${sourceBytes} source bytes.`);
}

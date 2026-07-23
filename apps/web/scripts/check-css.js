const fs = require('node:fs');
const path = require('node:path');

const webRoot = path.join(__dirname, '..');
const sourceRoot = path.join(webRoot, 'stylesheets');
const outputPath = path.join(webRoot, 'public', 'styles.css');
const authOutputPath = path.join(webRoot, 'public', 'auth.css');
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

let sourceBytes = 0;
for (const moduleName of expectedModules) {
  const modulePath = path.join(sourceRoot, moduleName);
  if (!fs.existsSync(modulePath)) {
    fail(`missing module ${moduleName}`);
    continue;
  }

  const source = fs.readFileSync(modulePath, 'utf8');
  sourceBytes += Buffer.byteLength(source);
  const lineCount = source.split('\n').length;
  if (lineCount > 700) fail(`${moduleName} has ${lineCount} lines; split modules before they exceed 700`);
  duplicateProperties(source, moduleName);
}

if (sourceBytes > 90_000) fail(`authored CSS is ${sourceBytes} bytes; budget is 90,000`);
if (!fs.existsSync(outputPath)) {
  fail('public/styles.css has not been built');
} else {
  const output = fs.readFileSync(outputPath, 'utf8');
  const outputBytes = Buffer.byteLength(output);
  if (outputBytes > 70_000) fail(`generated CSS is ${outputBytes} bytes; budget is 70,000`);
  if (!output.includes('.confirm-video-summary[hidden]')) {
    fail('generated CSS is missing the hidden regeneration-summary rule');
  }
}
if (!fs.existsSync(authOutputPath)) {
  fail('public/auth.css has not been built');
} else if (fs.statSync(authOutputPath).size > 8_000) {
  fail(`generated auth CSS is ${fs.statSync(authOutputPath).size} bytes; budget is 8,000`);
}

if (!process.exitCode) {
  console.log(`CSS check passed: ${expectedModules.length} modules, ${sourceBytes} source bytes.`);
}

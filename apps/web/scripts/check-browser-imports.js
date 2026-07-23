const fs = require('node:fs');
const path = require('node:path');

const browserRoot = path.resolve(__dirname, '..', 'public', 'js');
const javascriptFiles = [];

function collectJavaScriptFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectJavaScriptFiles(entryPath);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      javascriptFiles.push(entryPath);
    }
  }
}

function resolveImport(importerPath, specifier) {
  let targetPath = path.resolve(path.dirname(importerPath), specifier);
  if (!path.extname(targetPath)) targetPath += '.js';
  return targetPath;
}

collectJavaScriptFiles(browserRoot);

const missingImports = [];
const importPatterns = [
  /(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g,
  /import\(\s*['"](\.[^'"]+)['"]\s*\)/g,
];

for (const filePath of javascriptFiles) {
  const source = fs.readFileSync(filePath, 'utf8');
  for (const importPattern of importPatterns) {
    for (const match of source.matchAll(importPattern)) {
      if (!fs.existsSync(resolveImport(filePath, match[1]))) {
        missingImports.push(`${path.relative(browserRoot, filePath)} -> ${match[1]}`);
      }
    }
  }
}

if (missingImports.length) {
  console.error(`Missing browser imports (${missingImports.length}):\n${missingImports.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(
    `Browser import check passed: ${javascriptFiles.length} files, all relative imports resolve.`,
  );
}

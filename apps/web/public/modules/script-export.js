import { RawScriptAdapter } from './screenplay-editor/js/adapters/RawScriptAdapter.js';

const FDX_TYPES = Object.freeze({
  header: 'Scene Heading',
  action: 'Action',
  speaker: 'Character',
  dialog: 'Dialogue',
  directions: 'Parenthetical',
  'chapter-break': 'New Act',
});

function scriptLines(source = '') {
  if (Array.isArray(source)) return source;
  if (Array.isArray(source?.lines)) return source.lines;
  return RawScriptAdapter.parse(source, 'fountain').lines;
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function escapeRtf(value = '') {
  let output = '';
  for (let index = 0; index < String(value).length; index += 1) {
    const code = String(value).charCodeAt(index);
    const character = String(value)[index];
    if (character === '\\' || character === '{' || character === '}') output += `\\${character}`;
    else if (character === '\n') output += '\\line ';
    else if (code > 127) output += `\\u${code > 32767 ? code - 65536 : code}?`;
    else output += character;
  }
  return output;
}

export function toPlainScript(source = '') {
  const indent = (count, text) => `${' '.repeat(count)}${text}`;
  return scriptLines(source).map((line) => {
    const content = line.content.trim();
    if (line.format === 'header') return content.toUpperCase();
    if (line.format === 'speaker') return indent(24, content.toUpperCase());
    if (line.format === 'dialog') return indent(12, content);
    if (line.format === 'directions') return indent(18, content.startsWith('(') ? content : `(${content})`);
    if (line.format === 'chapter-break') return `\f${content.toUpperCase()}\f`;
    return content;
  }).join('\n\n');
}

export function toRichTextScript(source = '') {
  const controls = {
    header: '\\keepn\\sb240\\sa120\\b\\caps',
    action: '\\sa120',
    speaker: '\\li3600\\sa0\\b',
    dialog: '\\li1800\\ri1800\\sa80',
    directions: '\\li2520\\ri1800\\sa0\\i',
    'chapter-break': '\\page\\qc\\sb240\\sa240\\b\\caps',
  };
  const paragraphs = scriptLines(source).map((line) => {
    return `\\pard\\plain\\f0\\fs24${controls[line.format] || controls.action} ${escapeRtf(line.content.trim())}\\par`;
  });
  return `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Courier New;}}\\paperw12240\\paperh15840\\margl2160\\margr1440\\margt1440\\margb1440\n${paragraphs.join('\n')}\n}`;
}

export function toFinalDraftXml(source = '') {
  const paragraphs = scriptLines(source).map((line) => {
    const type = FDX_TYPES[line.format] || FDX_TYPES.action;
    return `    <Paragraph Type="${type}"><Text>${escapeHtml(line.content.trim())}</Text></Paragraph>`;
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<FinalDraft DocumentType="Script" Template="No" Version="1">\n  <Content>\n${paragraphs.join('\n')}\n  </Content>\n</FinalDraft>\n`;
}

export function toStructuredScriptJson(source = '') {
  return `${JSON.stringify({
    schemaVersion: 1,
    type: 'storyframe-screenplay',
    lines: scriptLines(source).map((line) => ({ format: line.format, content: line.content })),
  }, null, 2)}\n`;
}

export function toPrintableScriptHtml(source = '', title = 'Screenplay') {
  const paragraphs = scriptLines(source).map((line) => {
    return `<p class="${escapeHtml(line.format)}">${escapeHtml(line.content.trim())}</p>`;
  }).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(title)}</title>
  <style>
    @page { size: Letter; margin: 1in 1in 1in 1.5in; }
    * { box-sizing: border-box; }
    body { margin: 0 auto; max-width: 6in; color: #000; background: #fff; font: 12pt/1 Courier, "Courier New", monospace; }
    p { margin: 0 0 1em; white-space: pre-wrap; }
    .header { margin-top: 1.5em; font-weight: bold; text-transform: uppercase; }
    .speaker { margin: 1em 0 0 3in; font-weight: bold; text-transform: uppercase; }
    .dialog { margin: 0 1.5in 0 1.5in; }
    .directions { margin: 0 1.5in 0 2in; font-style: italic; }
    .chapter-break { break-before: page; margin-top: 3in; text-align: center; font-weight: bold; text-transform: uppercase; }
    @media screen { body { padding: 0.6in 0; } }
  </style>
</head>
<body>${paragraphs}</body>
</html>`;
}

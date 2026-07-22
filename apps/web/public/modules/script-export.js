import { RawScriptAdapter } from './screenplay-editor/js/adapters/RawScriptAdapter.js';

const FDX_TYPES = Object.freeze({
  header: 'Scene Heading',
  action: 'Action',
  speaker: 'Character',
  dialog: 'Dialogue',
  directions: 'Parenthetical',
  transition: 'Transition',
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
    if (line.format === 'speaker') return indent(22, content.toUpperCase());
    if (line.format === 'dialog') return indent(10, content);
    if (line.format === 'directions') return indent(16, content.startsWith('(') ? content : `(${content})`);
    if (line.format === 'transition') return indent(45, content.toUpperCase());
    if (line.format === 'chapter-break') return `\f${content.toUpperCase()}\f`;
    return content;
  }).join('\n\n');
}

export function toRichTextScript(source = '') {
  /* Twips: 1440 = 1in. Content-relative indents after 1.5in left margin. */
  const controls = {
    header: '\\keepn\\sb240\\sa240\\caps',
    action: '\\sa240',
    speaker: '\\li3168\\sa0\\caps',
    dialog: '\\li1440\\ri2160\\sa240',
    directions: '\\li2304\\ri2880\\sa0',
    transition: '\\li6480\\sa240\\caps\\qr',
    'chapter-break': '\\page\\qc\\sb240\\sa240\\caps',
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
    body { margin: 0 auto; max-width: 6in; color: #000; background: #fff; font: 12pt/1 "Courier Prime", Courier, "Courier New", monospace; }
    p { margin: 0 0 1em; white-space: pre-wrap; font-weight: 400; font-style: normal; }
    .header { margin-top: 1em; text-transform: uppercase; }
    .action { margin-bottom: 1em; }
    .speaker { margin: 1em 0 0 2.2in; text-transform: uppercase; }
    .dialog { margin: 0 1.5in 1em 1in; }
    .directions { margin: 0 2in 0 1.6in; }
    .transition { margin: 1em 0 1em 4.5in; text-align: right; text-transform: uppercase; }
    .chapter-break { break-before: page; margin-top: 3in; text-align: center; text-transform: uppercase; }
    @media screen { body { padding: 0.6in 0; } }
  </style>
</head>
<body>${paragraphs}</body>
</html>`;
}

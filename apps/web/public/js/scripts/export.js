import { RawScriptAdapter } from '../screenplay-editor/js/adapters/RawScriptAdapter.js';

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

function normalizeCoverMeta(cover = {}) {
  return {
    title: String(cover.title || '').trim(),
    author: String(cover.author || '').trim(),
    summary: String(cover.summary || '').trim(),
    coverUrl: cover.coverUrl || null,
  };
}

function titlePagePlainLines(cover = {}) {
  const meta = normalizeCoverMeta(cover);
  const lines = [];
  if (meta.title) lines.push(meta.title.toUpperCase());
  if (meta.author) lines.push(`Written by ${meta.author}`);
  if (meta.summary) lines.push('', meta.summary);
  return lines;
}

export function toPlainScript(source = '', cover = null) {
  const indent = (count, text) => `${' '.repeat(count)}${text}`;
  const body = scriptLines(source).map((line) => {
    const content = line.content.trim();
    if (line.format === 'header') return content.toUpperCase();
    if (line.format === 'speaker') return indent(22, content.toUpperCase());
    if (line.format === 'dialog') return indent(10, content);
    if (line.format === 'directions') return indent(16, content.startsWith('(') ? content : `(${content})`);
    if (line.format === 'transition') return indent(45, content.toUpperCase());
    if (line.format === 'chapter-break') return `\f${content.toUpperCase()}\f`;
    return content;
  }).join('\n\n');
  if (!cover) return body;
  const titlePage = titlePagePlainLines(cover).join('\n\n');
  return titlePage ? `${titlePage}\n\n\f\n\n${body}` : body;
}

export function toRichTextScript(source = '', cover = null) {
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
  const titleBlocks = [];
  if (cover) {
    const meta = normalizeCoverMeta(cover);
    if (meta.title) titleBlocks.push(`\\pard\\plain\\f0\\fs28\\qc\\sb1440\\sa480\\b ${escapeRtf(meta.title)}\\b0\\par`);
    if (meta.author) titleBlocks.push(`\\pard\\plain\\f0\\fs24\\qc\\sa480 Written by ${escapeRtf(meta.author)}\\par`);
    if (meta.summary) titleBlocks.push(`\\pard\\plain\\f0\\fs22\\qc\\sa480 ${escapeRtf(meta.summary)}\\par`);
    if (titleBlocks.length) titleBlocks.push('\\page');
  }
  const paragraphs = scriptLines(source).map((line) => {
    return `\\pard\\plain\\f0\\fs24${controls[line.format] || controls.action} ${escapeRtf(line.content.trim())}\\par`;
  });
  return `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Courier New;}}\\paperw12240\\paperh15840\\margl2160\\margr1440\\margt1440\\margb1440\n${[...titleBlocks, ...paragraphs].join('\n')}\n}`;
}

export function toFinalDraftXml(source = '', cover = null) {
  const titleParagraphs = [];
  if (cover) {
    const meta = normalizeCoverMeta(cover);
    if (meta.title) {
      titleParagraphs.push(`    <Paragraph Type="Action"><Text>${escapeHtml(meta.title)}</Text></Paragraph>`);
    }
    if (meta.author) {
      titleParagraphs.push(`    <Paragraph Type="Action"><Text>Written by ${escapeHtml(meta.author)}</Text></Paragraph>`);
    }
    if (meta.summary) {
      titleParagraphs.push(`    <Paragraph Type="Action"><Text>${escapeHtml(meta.summary)}</Text></Paragraph>`);
    }
    if (titleParagraphs.length) {
      titleParagraphs.push('    <Paragraph Type="Action"><Text></Text></Paragraph>');
    }
  }
  const paragraphs = scriptLines(source).map((line) => {
    const type = FDX_TYPES[line.format] || FDX_TYPES.action;
    return `    <Paragraph Type="${type}"><Text>${escapeHtml(line.content.trim())}</Text></Paragraph>`;
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<FinalDraft DocumentType="Script" Template="No" Version="1">\n  <Content>\n${[...titleParagraphs, ...paragraphs].join('\n')}\n  </Content>\n</FinalDraft>\n`;
}

export function toStructuredScriptJson(source = '') {
  return `${JSON.stringify({
    schemaVersion: 1,
    type: 'storyboarder-screenplay',
    lines: scriptLines(source).map((line) => ({ format: line.format, content: line.content })),
  }, null, 2)}\n`;
}

function printableCoverHtml(cover = {}) {
  const meta = normalizeCoverMeta(cover);
  if (!meta.title && !meta.author && !meta.summary && !meta.coverUrl) return '';
  const art = meta.coverUrl
    ? `<div class="cover-art"><img src="${escapeHtml(meta.coverUrl)}" alt="" /></div>`
    : '';
  return `<section class="cover-page${meta.coverUrl ? ' has-cover-art' : ''}" aria-label="Screenplay cover">
  ${art}
  <div class="cover-copy">
    <p class="cover-label">Screenplay</p>
    <h1>${escapeHtml(meta.title || 'Untitled')}</h1>
    ${meta.summary ? `<p class="cover-summary">${escapeHtml(meta.summary)}</p>` : ''}
    ${meta.author ? `<p class="cover-author">Written by<br><strong>${escapeHtml(meta.author)}</strong></p>` : ''}
  </div>
</section>`;
}

export function toPrintableScriptHtml(source = '', title = 'Screenplay', cover = null) {
  const coverMeta = cover ? { ...normalizeCoverMeta(cover), title: cover.title || title } : { title };
  const paragraphs = scriptLines(source).map((line) => {
    return `<p class="${escapeHtml(line.format)}">${escapeHtml(line.content.trim())}</p>`;
  }).join('\n');
  const coverHtml = printableCoverHtml(coverMeta);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(title)}</title>
  <style>
    @page { size: Letter; margin: 0; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #000; background: #fff; font: 12pt/1 "Courier Prime", Courier, "Courier New", monospace; }
    .cover-page {
      width: 8.5in;
      min-height: 11in;
      margin: 0 auto;
      padding: 1.5in 1.25in;
      text-align: center;
      page-break-after: always;
      break-after: page;
      display: grid;
      align-content: center;
      gap: 1rem;
    }
    .cover-page.has-cover-art {
      padding: 0;
      grid-template-rows: minmax(3.5in, 42%) auto;
      text-align: left;
    }
    .cover-art {
      display: grid;
      place-items: center;
      min-height: 3.5in;
      background: #f4f4f4;
      overflow: hidden;
    }
    .cover-art img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: contain;
      object-position: center;
    }
    .cover-page.has-cover-art .cover-copy { padding: 1in 1.25in 1.25in; }
    .cover-label {
      margin: 0;
      font-size: 10pt;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: #444;
    }
    .cover-page h1 {
      margin: 0;
      font-size: 28pt;
      line-height: 1.1;
      font-weight: 700;
    }
    .cover-summary {
      margin: 0 auto;
      max-width: 42ch;
      white-space: pre-wrap;
      line-height: 1.45;
      color: #333;
    }
    .cover-page.has-cover-art .cover-summary { margin: 0; }
    .cover-author { margin: 0; color: #444; line-height: 1.5; }
    .cover-author strong { color: #000; font-size: 14pt; }
    .script-body {
      width: 8.5in;
      margin: 0 auto;
      padding: 1in 1in 1in 1.5in;
      max-width: none;
    }
    .script-body p { margin: 0 0 1em; white-space: pre-wrap; font-weight: 400; font-style: normal; }
    .header { margin-top: 1em; text-transform: uppercase; }
    .action { margin-bottom: 1em; }
    .speaker { margin: 1em 0 0 2.2in; text-transform: uppercase; }
    .dialog { margin: 0 1.5in 1em 1in; }
    .directions { margin: 0 2in 0 1.6in; }
    .transition { margin: 1em 0 1em 4.5in; text-align: right; text-transform: uppercase; }
    .chapter-break { break-before: page; margin-top: 3in; text-align: center; text-transform: uppercase; }
    @media screen {
      body { background: #ddd; }
      .cover-page, .script-body { background: #fff; box-shadow: 0 0 0.4in rgba(0,0,0,0.15); margin-bottom: 0.4in; }
    }
  </style>
</head>
<body>
${coverHtml}
<div class="script-body">${paragraphs}</div>
</body>
</html>`;
}

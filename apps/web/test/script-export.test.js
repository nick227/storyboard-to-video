const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(path.join(__dirname, '../public/js/scripts/export.js')).href;

const sample = `INT. OFFICE - DAY

@Dr. Rivera
(quietly)
We should begin.

The projector flickers.`;

test('script exports preserve screenplay element semantics across text, RTF, and FDX', async () => {
  const { toFinalDraftXml, toPlainScript, toRichTextScript } = await import(moduleUrl);

  const text = toPlainScript(sample);
  assert.match(text, /INT\. OFFICE - DAY/);
  assert.match(text, /DR\. RIVERA/);
  assert.match(text, /\(quietly\)/);

  const rtf = toRichTextScript(sample);
  assert.match(rtf, /^\{\\rtf1/);
  assert.match(rtf, /\\li3168.*Dr\. Rivera/);
  assert.match(rtf, /\\li1440\\ri2160.*We should begin\./);
  assert.doesNotMatch(rtf, /\\b /);
  assert.doesNotMatch(rtf, /\\i /);

  const fdx = toFinalDraftXml(sample);
  assert.match(fdx, /<Paragraph Type="Scene Heading"><Text>INT\. OFFICE - DAY<\/Text>/);
  assert.match(fdx, /<Paragraph Type="Character"><Text>Dr\. Rivera<\/Text>/);
  assert.match(fdx, /<Paragraph Type="Dialogue"><Text>We should begin\.<\/Text>/);
});

test('printable export escapes script content before inserting it into HTML', async () => {
  const { toPrintableScriptHtml } = await import(moduleUrl);
  const html = toPrintableScriptHtml('INT. LAB - DAY\n\nA <dangerous> & unusual test.', 'A & B');

  assert.match(html, /<title>A &amp; B<\/title>/);
  assert.match(html, /A &lt;dangerous&gt; &amp; unusual test\./);
  assert.doesNotMatch(html, /<dangerous>/);
});

test('printable export includes a cover page with contained art and escaped summary', async () => {
  const { toPrintableScriptHtml } = await import(moduleUrl);
  const html = toPrintableScriptHtml('INT. LAB - DAY\n\nHello.', 'Harbor Night', {
    title: 'Harbor <Night>',
    author: 'Ada & Co',
    summary: 'A dockworker finds a <letter>.',
    coverUrl: 'https://example.test/cover.png',
  });

  assert.match(html, /class="cover-page has-cover-art"/);
  assert.match(html, /object-fit: contain/);
  assert.match(html, /Harbor &lt;Night&gt;/);
  assert.match(html, /Ada &amp; Co/);
  assert.match(html, /A dockworker finds a &lt;letter&gt;\./);
  assert.match(html, /https:\/\/example\.test\/cover\.png/);
  assert.match(html, /page-break-after: always/);
  assert.match(html, /min-height: 5\.5in/);
  assert.match(html, /cover-byline/);
});

test('FDX and RTF exports prepend title-page text from cover meta', async () => {
  const { toFinalDraftXml, toRichTextScript } = await import(moduleUrl);
  const cover = { title: 'Harbor Night', author: 'Ada', summary: 'A sealed letter.' };
  const fdx = toFinalDraftXml(sample, cover);
  assert.match(fdx, /<Paragraph Type="Action"><Text>Harbor Night<\/Text><\/Paragraph>/);
  assert.match(fdx, /Written by Ada/);
  assert.match(fdx, /A sealed letter\./);

  const rtf = toRichTextScript(sample, cover);
  assert.match(rtf, /Harbor Night/);
  assert.match(rtf, /Written by Ada/);
  assert.match(rtf, /A sealed letter\./);
  assert.match(rtf, /\\page/);
});

test('structured JSON is a versioned export artifact with explicit line formats', async () => {
  const { toStructuredScriptJson } = await import(moduleUrl);
  const exported = JSON.parse(toStructuredScriptJson(sample));

  assert.equal(exported.schemaVersion, 1);
  assert.equal(exported.type, 'storyboarder-screenplay');
  assert.deepEqual(exported.lines.slice(0, 4).map((line) => line.format), ['header', 'speaker', 'directions', 'dialog']);
  assert.equal(exported.lines[3].content, 'We should begin.');
});

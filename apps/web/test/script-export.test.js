const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(path.join(__dirname, '../public/modules/script-export.js')).href;

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
  assert.match(rtf, /\\li3600.*Dr\. Rivera/);
  assert.match(rtf, /\\li1800\\ri1800.*We should begin\./);

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

test('structured JSON is a versioned export artifact with explicit line formats', async () => {
  const { toStructuredScriptJson } = await import(moduleUrl);
  const exported = JSON.parse(toStructuredScriptJson(sample));

  assert.equal(exported.schemaVersion, 1);
  assert.equal(exported.type, 'storyframe-screenplay');
  assert.deepEqual(exported.lines.slice(0, 4).map((line) => line.format), ['header', 'speaker', 'directions', 'dialog']);
  assert.equal(exported.lines[3].content, 'We should begin.');
});

const fs = require('node:fs');
const path = require('node:path');
function xml(value = '') { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); }
function stubImage(prompt, title = 'Storyboard scene') {
  const clean = String(prompt || '').replace(/\s+/g, ' ').trim(); const lines = []; for (let i = 0; i < clean.length && lines.length < 8; i += 54) lines.push(clean.slice(i, i + 54));
  const text = lines.map((line, i) => `<text x="70" y="${610 + i * 38}" font-family="Arial" font-size="24" fill="#222">${xml(line)}</text>`).join('');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="#fffdf5"/><rect x="36" y="36" width="952" height="952" rx="24" fill="none" stroke="#111" stroke-width="8"/><text x="70" y="100" font-family="Arial" font-size="28" font-weight="700">STUB PREVIEW — ${xml(title)}</text><circle cx="360" cy="290" r="82" fill="#ffd85e" stroke="#111" stroke-width="10"/><path d="M360 372 L360 520 M275 425 L445 425 M360 520 L300 585 M360 520 L420 585" fill="none" stroke="#111" stroke-width="12"/>${text}</svg>`);
}
function stubVideo(config) {
  const configured = config.env.VIDEO_STUB_PATH ? path.resolve(config.env.VIDEO_STUB_PATH) : null; if (configured) return configured;
  const file = path.join(config.paths.stubs, 'placeholder.mp4');
  if (!fs.existsSync(file)) {
    const placeholder = 'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMWbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAACgAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAkB0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAACgAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAEAAAABAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAAoAAAAAAABAAAAAAG4bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAyAAAAAgBVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABY21pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAASNzdGJsAAAAv3N0c2QAAAAAAAAAAQAAAK9hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAEAAQABIAAAASAAAAAAAAAABFUxhdmM2MC4zMS4xMDIgbGliY2ZvZGVjAAAAAAAAAAAAAAAGP//AAAANWF2Y0MBZAAK/+EAGGdkAAqs2UQmwEQAAAMABAAAAwDIPEiWWAEABmjr48siwP34+AAAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAAI2aAACNmgAAAAYc3R0cwAAAAAAAAABAAAAAQAAAgAAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAEAAAABAAAAFHN0c3oAAAAAAAAC1QAAAAEAAAAUc3RjbwAAAAAAAAABAAADRgAAAGJ1ZHRhAAAAWm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALWlsc3QAAAAlqXRvbwAAAB1kYXRhAAAAAQAAAABMYXZmNjAuMTYuMTAwAAAACGZyZWUAAALdbWRhdAAAAq4GBf//qtxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjQgcjMxMDggMzFlMTlmOSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjMgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0xIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDM6MHgxMTMgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMiBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0yIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBidXVyYXlfY29tcGF0PTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0yIGJfYWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRiPTEgY3JmPTIzLjAAgAAAAB9liIQAK//+9nN8CmttsJUuBXb2ljctPO9ZoHwD/GUB';
    fs.mkdirSync(config.paths.stubs, { recursive: true }); fs.writeFileSync(file, Buffer.from(placeholder, 'base64'));
  }
  return file;
}
module.exports = { stubImage, stubVideo };

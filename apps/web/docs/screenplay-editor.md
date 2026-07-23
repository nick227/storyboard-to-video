# Standalone Screenplay Editor Component

A lightweight, portable, framework-agnostic Screenplay Writing UX component for web applications.

## Features
- Full screenplay formatting flow: `ACTION` → `SPEAKER` → `DIALOG` → `SPEAKER`
- Keybindings: `Enter` formatting progression, `Tab` / `Shift+Tab` format cycling, `Ctrl + Left / Right` word navigation
- Multi-page pagination engine with automated page break calculations
- Standard Fountain format parsing & serialization (`fountain`, `json`, `array`, `tagged`)
- Standalone CSS styling with zero external dependencies

## File Structure

```
pages/dev/screenplay-editor.html                 # Standalone demo harness
public/css/screenplay-editor/
└── screenplay-editor-standalone.css             # Self-contained stylesheet
public/js/screenplay-editor/
├── demo.js                                       # Demo initialization
└── js/
    ├── ScreenplayEditor.js                       # Primary component class
    ├── constants/
    ├── adapters/
    ├── handlers/
    ├── keyboard/
    ├── model/
    └── page/
```

## Quick Start & Integration Instructions

### 1. Include the Stylesheet
```html
<link rel="stylesheet" href="/css/screenplay-editor/screenplay-editor-standalone.css">
```

### 2. Add Container Element to your HTML
```html
<div id="screenplay-editor-root" style="width: 100%; height: 600px;"></div>
```

### 3. Instantiate Component in JS
```javascript
import { ScreenplayEditor } from '/js/screenplay-editor/js/ScreenplayEditor.js';

const editor = new ScreenplayEditor({
  container: document.getElementById('screenplay-editor-root'),
  initialScript: `
INT. COFFEE SHOP - DAY

MARCUS
(smiling)
Still using that ancient machine?
  `,
  format: 'fountain', // Options: 'fountain' | 'json' | 'array' | 'tagged'
  showToolbar: true,
  onChange: ({ rawText, document, isDirty }) => {
    console.log('Script updated:', rawText);
  },
  onSelectionChange: ({ format, lineElement }) => {
    console.log('Current line format:', format);
  }
});

// Export script content dynamically
const text = editor.getRawScript('fountain');

// Load new script dynamically
editor.loadScript(newFountainText, 'fountain');
```

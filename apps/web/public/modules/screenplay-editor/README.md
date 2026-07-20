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
standalone-screenplay-editor/
├── index.html                           # Standalone Demo Harness
├── demo.js                              # Demo initialization script
├── css/
│   └── screenplay-editor-standalone.css # Self-contained CSS stylesheet
├── js/
│   ├── ScreenplayEditor.js              # Primary Component Class
│   ├── constants/
│   │   └── formats.js                   # Format rules & state flow definitions
│   ├── adapters/
│   │   ├── FountainAdapter.js           # Fountain syntax parser/serializer
│   │   └── RawScriptAdapter.js          # Universal raw format facade
│   ├── handlers/                        # DOM, Caret & Selection handlers
│   ├── keyboard/                        # Keybinding controllers
│   ├── model/                           # Document & line data models
│   └── page/                            # Page break & pagination manager
└── README.md                            # Documentation
```

## Quick Start & Integration Instructions

### 1. Include the Stylesheet
```html
<link rel="stylesheet" href="css/screenplay-editor-standalone.css">
```

### 2. Add Container Element to your HTML
```html
<div id="screenplay-editor-root" style="width: 100%; height: 600px;"></div>
```

### 3. Instantiate Component in JS
```javascript
import { ScreenplayEditor } from './js/ScreenplayEditor.js';

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

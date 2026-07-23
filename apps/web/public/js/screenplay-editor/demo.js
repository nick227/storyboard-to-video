import { ScreenplayEditor } from './js/ScreenplayEditor.js';

const initialFountainSample = `INT. COFFEE SHOP - DAY

MARCUS sits at the corner table, typing furiously on a vintage typewriter.

SARAH enters, shaking rain off her umbrella. She spots Marcus and walks over.

SARAH
(smiling)
Still using that ancient machine?

MARCUS
It has soul, Sarah. No notifications. No distractions. Just pure story.

Sarah sits down across from him.`;

const initHarness = () => {
    const container = document.getElementById('screenplay-editor-container');
    const rawOutput = document.getElementById('raw-output');

    if (!container) {
        console.error('[Harness] Editor container element not found');
        return;
    }

    // Instantiate standalone screenplay editor
    const editor = new ScreenplayEditor({
        container,
        initialScript: initialFountainSample,
        format: 'fountain',
        showToolbar: true,
        onChange: ({ rawText }) => {
            if (rawOutput) {
                rawOutput.value = rawText;
            }
        }
    });

    // Populate initial raw text
    if (rawOutput) {
        rawOutput.value = editor.getRawScript('fountain');
    }

    // Expose for browser console testing
    window.standaloneScreenplayEditor = editor;
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initHarness);
} else {
    initHarness();
}

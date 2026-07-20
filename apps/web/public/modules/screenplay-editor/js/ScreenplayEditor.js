import { RawScriptAdapter } from './adapters/RawScriptAdapter.js';
import { FountainAdapter } from './adapters/FountainAdapter.js';
import { LineFormatter } from './LineFormatter.js';
import { KeyboardManager } from './keyboard/KeyboardManager.js';
import { PageManager } from './page/PageManager.js';
import { EditorDOMHandler } from './handlers/EditorDOMHandler.js';
import { EDITOR_EVENTS } from './constants/editorConstants.js';
import { VALID_FORMATS, FORMAT_DISPLAY_NAMES } from './constants/formats.js';

/**
 * ScreenplayEditor: A standalone, portable Screenplay Writing UX Component.
 * Can be embedded in any Web application with ZERO external dependencies.
 */
export class ScreenplayEditor {
    /**
     * @param {object} options
     * @param {HTMLElement} options.container - Container element to mount editor into
     * @param {string|Array} [options.initialScript=''] - Initial raw script text (Fountain, Tagged HTML, or JSON)
     * @param {string} [options.format='fountain'] - Input format ('fountain' | 'tagged' | 'json' | 'array')
     * @param {boolean} [options.showToolbar=true] - Whether to render built-in toolbar
     * @param {function} [options.onChange] - Callback fired whenever script content changes
     * @param {function} [options.onSelectionChange] - Callback fired whenever selection/cursor format changes
     */
    constructor (options = {}) {
        if (!options.container) {
            throw new Error('[ScreenplayEditor] Container element is required');
        }

        this.container = options.container;
        this.format = options.format || 'fountain';
        this.showToolbar = options.showToolbar !== false;

        this.callbacks = {
            onChange: options.onChange || null,
            onSelectionChange: options.onSelectionChange || null
        };

        // State
        this.document = RawScriptAdapter.parse(options.initialScript || '', this.format);
        this.isDirty = false;

        // Sub-modules
        this.lineFormatter = new LineFormatter();
        this.pageManager = null;
        this.domHandler = null;
        this.keyboardManager = null;

        // Elements
        this.wrapper = null;
        this.toolbar = null;
        this.workspace = null;

        this._initUI();
        this._initEngine();
        this.loadScript(options.initialScript || '', this.format);
    }

    _initUI () {
        this.container.innerHTML = '';
        
        this.wrapper = document.createElement('div');
        this.wrapper.className = 'screenplay-editor-wrapper';

        if (this.showToolbar) {
            this.toolbar = document.createElement('div');
            this.toolbar.className = 'screenplay-toolbar';
            this._buildToolbarUI();
            this.wrapper.appendChild(this.toolbar);
        }

        this.workspace = document.createElement('div');
        this.workspace.className = 'screenplay-workspace';
        this.wrapper.appendChild(this.workspace);

        this.container.appendChild(this.wrapper);
    }

    _buildToolbarUI () {
        const select = document.createElement('select');
        select.className = 'screenplay-format-select';
        
        Object.keys(FORMAT_DISPLAY_NAMES).forEach(fmt => {
            const opt = document.createElement('option');
            opt.value = fmt;
            opt.textContent = FORMAT_DISPLAY_NAMES[fmt];
            select.appendChild(opt);
        });

        select.addEventListener('change', (e) => {
            this.setLineFormat(e.target.value);
        });

        this.toolbar.appendChild(select);
        this.formatSelect = select;
    }

    _initEngine () {
        this.pageManager = new PageManager({
            container: this.workspace,
            lineFormatter: this.lineFormatter
        });
        this.pageManager.initialize();

        this.domHandler = new EditorDOMHandler({
            pageManager: this.pageManager,
            lineFormatter: this.lineFormatter
        });

        const mockContentManager = {
            emit: (event, data) => this._handleEngineEvent(event, data)
        };

        this.keyboardManager = new KeyboardManager({
            pageManager: this.pageManager,
            contentManager: mockContentManager,
            lineFormatter: this.lineFormatter,
            domHandler: this.domHandler
        });

        this.keyboardManager.initialize(this.workspace);

        this.workspace.addEventListener('input', () => this._notifyChange());
        this.workspace.addEventListener('keyup', () => this._updateSelectionState());
        this.workspace.addEventListener('click', () => this._updateSelectionState());
    }

    loadScript (content, format = 'fountain') {
        this.format = format;
        this.document = RawScriptAdapter.parse(content, format);

        const linesData = this.document.lines.map(l => ({
            id: l.id,
            format: l.format,
            content: l.content
        }));

        this.pageManager.renderDocument(linesData);
        this.isDirty = false;
        this._updateSelectionState();
    }

    getRawScript (format) {
        const currentDoc = this.getScriptDocument();
        return RawScriptAdapter.serialize(currentDoc, format || this.format);
    }

    getScriptDocument () {
        const lineElements = Array.from(this.workspace.querySelectorAll('.script-line'));
        const linesData = lineElements.map(el => ({
            id: el.dataset.lineId || el.id,
            format: el.getAttribute('data-format') || VALID_FORMATS.ACTION,
            content: el.textContent || ''
        }));
        return RawScriptAdapter.fromArray(linesData);
    }

    setLineFormat (format) {
        const activeLine = this.pageManager.getActiveLine() || this.workspace.querySelector('.script-line');
        if (activeLine) {
            activeLine.setAttribute('data-format', format);
            this._notifyChange();
        }
    }

    _notifyChange () {
        this.isDirty = true;
        const currentDoc = this.getScriptDocument();
        const rawText = RawScriptAdapter.serialize(currentDoc, this.format);

        if (typeof this.callbacks.onChange === 'function') {
            this.callbacks.onChange({
                rawText,
                document: currentDoc,
                isDirty: true
            });
        }
    }

    _updateSelectionState () {
        const activeLine = this.pageManager.getActiveLine();
        if (activeLine) {
            const currentFormat = activeLine.getAttribute('data-format') || VALID_FORMATS.ACTION;
            if (this.formatSelect && this.formatSelect.value !== currentFormat) {
                this.formatSelect.value = currentFormat;
            }

            if (typeof this.callbacks.onSelectionChange === 'function') {
                this.callbacks.onSelectionChange({
                    format: currentFormat,
                    lineElement: activeLine
                });
            }
        }
    }

    _handleEngineEvent (event, data) {
        if (event === EDITOR_EVENTS.CONTENT_CHANGED) {
            this._notifyChange();
        }
    }

    destroy () {
        if (this.keyboardManager) {
            this.keyboardManager.destroy();
        }
        this.container.innerHTML = '';
    }
}

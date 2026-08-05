// Floating, minimizable chat widget for the Screenplay tab. Built the same way HelpModal.js
// builds its dialog -- plain DOM nodes appended directly, no static HTML partial -- since this is
// the only existing precedent for a self-contained floating component in this app; every other
// overlay is a static <dialog> partial under pages/partials/dialogs/, which doesn't fit a widget
// that needs open/minimized/closed states rather than a single modal show/hide.
export class AssistantPanel {
  /**
   * @param {{
   *   container: HTMLElement,
   *   getMessages: () => Array<{id:string, role:'user'|'assistant', content:string, insertedIntoScript?:boolean}>,
   *   onSend: (userMessage: string) => Promise<void>,
   *   onAddLines: () => Promise<void>,
   *   getState: () => { open: boolean, minimized: boolean },
   *   onOpen: () => void,
   *   onMinimize: () => void,
   *   onClose: () => void,
   * }} options
   */
  constructor(options) {
    this.container = options.container;
    this.getMessages = options.getMessages;
    this.onSend = options.onSend;
    this.onAddLines = options.onAddLines;
    this.getState = options.getState;
    this.onOpen = options.onOpen;
    this.onMinimize = options.onMinimize;
    this.onClose = options.onClose;
    this.busy = false;
    this._build();
    this.render();
  }

  _build() {
    const root = document.createElement('div');
    root.className = 'screenplay-assistant';

    const fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'screenplay-assistant-fab';
    fab.setAttribute('aria-label', 'Open screenplay assistant');
    fab.textContent = 'AI';
    fab.addEventListener('click', () => this.onOpen());

    const panel = document.createElement('div');
    panel.className = 'screenplay-assistant-panel';

    const header = document.createElement('div');
    header.className = 'screenplay-assistant-header';
    const title = document.createElement('span');
    title.className = 'screenplay-assistant-title';
    title.textContent = 'Screenplay assistant';
    const minimizeBtn = document.createElement('button');
    minimizeBtn.type = 'button';
    minimizeBtn.className = 'screenplay-assistant-icon-btn';
    minimizeBtn.setAttribute('aria-label', 'Minimize');
    minimizeBtn.textContent = '−';
    minimizeBtn.addEventListener('click', () => this.onMinimize());
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'screenplay-assistant-icon-btn';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => this.onClose());
    header.append(title, minimizeBtn, closeBtn);
    header.addEventListener('click', (event) => {
      if (event.target === header || event.target === title) this.onMinimize();
    });

    const body = document.createElement('div');
    body.className = 'screenplay-assistant-body';

    const messages = document.createElement('div');
    messages.className = 'screenplay-assistant-messages';
    this.messagesEl = messages;

    const actions = document.createElement('div');
    actions.className = 'screenplay-assistant-actions';
    const addLinesBtn = document.createElement('button');
    addLinesBtn.type = 'button';
    addLinesBtn.className = 'screenplay-assistant-action-btn';
    addLinesBtn.textContent = 'Add 10 lines';
    addLinesBtn.addEventListener('click', () => this._runAddLines());
    const summarizeBtn = document.createElement('button');
    summarizeBtn.type = 'button';
    summarizeBtn.className = 'screenplay-assistant-action-btn';
    summarizeBtn.textContent = 'Summarize';
    summarizeBtn.addEventListener('click', () => this._sendMessage('Summarize this screenplay so far.', 'summarize'));
    const suggestBtn = document.createElement('button');
    suggestBtn.type = 'button';
    suggestBtn.className = 'screenplay-assistant-action-btn';
    suggestBtn.textContent = 'Suggest';
    suggestBtn.addEventListener('click', () => this._sendMessage('Suggest ways to improve this screenplay.', 'suggest'));
    actions.append(addLinesBtn, summarizeBtn, suggestBtn);
    this.addLinesBtn = addLinesBtn;
    this.summarizeBtn = summarizeBtn;
    this.suggestBtn = suggestBtn;

    const inputRow = document.createElement('form');
    inputRow.className = 'screenplay-assistant-input-row';
    const textarea = document.createElement('textarea');
    textarea.className = 'screenplay-assistant-input';
    textarea.placeholder = 'Ask about your screenplay…';
    textarea.rows = 1;
    const sendBtn = document.createElement('button');
    sendBtn.type = 'submit';
    sendBtn.className = 'screenplay-assistant-send-btn';
    sendBtn.textContent = 'Send';
    inputRow.append(textarea, sendBtn);
    const submitTyped = () => {
      const value = textarea.value.trim();
      if (!value) return;
      textarea.value = '';
      this._sendMessage(value, 'send');
    };
    inputRow.addEventListener('submit', (event) => {
      event.preventDefault();
      submitTyped();
    });
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        submitTyped();
      }
    });
    this.textarea = textarea;
    this.sendBtn = sendBtn;

    body.append(messages, actions, inputRow);
    panel.append(header, body);
    root.append(fab, panel);
    this.container.appendChild(root);

    this.root = root;
    this.fab = fab;
    this.panel = panel;
  }

  // `action` identifies which button is running, purely so _setBusy can show "Working…" on the
  // one button actually doing work instead of every button at once, while still disabling all of
  // them (only one request should ever be in flight at a time).
  async _sendMessage(value, action) {
    if (!value || this.busy) return;
    this._setBusy(action);
    try {
      await this.onSend(value);
    } catch (_) {
      // Errors are already surfaced via setStatus by the controller; keep the widget usable.
    } finally {
      this._setBusy(null);
      this.render();
    }
  }

  async _runAddLines() {
    if (this.busy) return;
    this._setBusy('addLines');
    try {
      await this.onAddLines();
    } catch (_) {
      // Same as above -- controller reports the failure via setStatus.
    } finally {
      this._setBusy(null);
      this.render();
    }
  }

  _setBusy(action) {
    this.busy = Boolean(action);
    this.sendBtn.disabled = this.busy;
    this.addLinesBtn.disabled = this.busy;
    this.summarizeBtn.disabled = this.busy;
    this.suggestBtn.disabled = this.busy;
    this.addLinesBtn.textContent = action === 'addLines' ? 'Working…' : 'Add 10 lines';
    this.summarizeBtn.textContent = action === 'summarize' ? 'Working…' : 'Summarize';
    this.suggestBtn.textContent = action === 'suggest' ? 'Working…' : 'Suggest';
  }

  render() {
    const { open, minimized } = this.getState();
    this.root.classList.toggle('is-open', open);
    this.root.classList.toggle('is-minimized', open && minimized);
    this.fab.hidden = open;
    this.panel.hidden = !open;

    if (!open) return;
    const messages = this.getMessages();
    this.messagesEl.innerHTML = '';
    if (!messages.length) {
      const empty = document.createElement('p');
      empty.className = 'screenplay-assistant-empty';
      empty.textContent = 'Ask a question about your screenplay, or use the buttons below to add lines, summarize, or get suggestions.';
      this.messagesEl.append(empty);
    }
    for (const message of messages) {
      const bubble = document.createElement('div');
      bubble.className = `screenplay-assistant-message screenplay-assistant-message-${message.role}`;
      if (message.insertedIntoScript) bubble.classList.add('is-inserted');
      const text = document.createElement('p');
      text.textContent = message.content;
      bubble.append(text);
      if (message.insertedIntoScript) {
        const tag = document.createElement('span');
        tag.className = 'screenplay-assistant-inserted-tag';
        tag.textContent = 'Added to script';
        bubble.append(tag);
      }
      this.messagesEl.append(bubble);
    }
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  destroy() {
    this.root.remove();
  }
}

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
   *   onAddLines: () => Promise<string>,
   *   onAcceptAddLines: (text: string) => Promise<void>,
   *   onDiscardAddLines: () => void,
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
    this.onAcceptAddLines = options.onAcceptAddLines;
    this.onDiscardAddLines = options.onDiscardAddLines;
    this.getState = options.getState;
    this.onOpen = options.onOpen;
    this.onMinimize = options.onMinimize;
    this.onClose = options.onClose;
    this.busy = false;
    // Not persisted, not yet injected -- a generation the writer hasn't accepted or discarded yet.
    // Holding it here (rather than auto-injecting) is what makes a bad generation harmless: nothing
    // touches scriptText or the persisted chat history until the writer explicitly accepts it.
    this.pendingAddition = null;
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

    const preview = document.createElement('div');
    preview.className = 'screenplay-assistant-preview';
    preview.hidden = true;
    const previewText = document.createElement('p');
    previewText.className = 'screenplay-assistant-preview-text';
    const previewActions = document.createElement('div');
    previewActions.className = 'screenplay-assistant-preview-actions';
    const acceptBtn = document.createElement('button');
    acceptBtn.type = 'button';
    acceptBtn.className = 'screenplay-assistant-accept-btn';
    acceptBtn.textContent = 'Add to script';
    acceptBtn.addEventListener('click', () => this._acceptPending());
    const discardBtn = document.createElement('button');
    discardBtn.type = 'button';
    discardBtn.className = 'screenplay-assistant-discard-btn';
    discardBtn.textContent = 'Discard';
    discardBtn.addEventListener('click', () => this._discardPending());
    previewActions.append(acceptBtn, discardBtn);
    preview.append(previewText, previewActions);
    this.previewEl = preview;
    this.previewText = previewText;
    this.acceptBtn = acceptBtn;
    this.discardBtn = discardBtn;

    const actions = document.createElement('div');
    actions.className = 'screenplay-assistant-actions';
    const addLinesBtn = document.createElement('button');
    addLinesBtn.type = 'button';
    addLinesBtn.className = 'screenplay-assistant-add-lines-btn';
    addLinesBtn.textContent = 'Add next 10 lines';
    addLinesBtn.addEventListener('click', () => this._runAddLines());
    actions.append(addLinesBtn);
    this.addLinesBtn = addLinesBtn;

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
    inputRow.addEventListener('submit', (event) => {
      event.preventDefault();
      this._runSend(textarea);
    });
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this._runSend(textarea);
      }
    });
    this.textarea = textarea;
    this.sendBtn = sendBtn;

    body.append(messages, preview, actions, inputRow);
    panel.append(header, body);
    root.append(fab, panel);
    this.container.appendChild(root);

    this.root = root;
    this.fab = fab;
    this.panel = panel;
  }

  async _runSend(textarea) {
    const value = textarea.value.trim();
    if (!value || this.busy) return;
    textarea.value = '';
    this._setBusy(true);
    try {
      await this.onSend(value);
    } catch (_) {
      // Errors are already surfaced via setStatus by the controller; keep the widget usable.
    } finally {
      this._setBusy(false);
      this.render();
    }
  }

  async _runAddLines() {
    if (this.busy || this.pendingAddition) return;
    this._setBusy(true);
    try {
      const text = await this.onAddLines();
      if (text) this.pendingAddition = text;
    } catch (_) {
      // Same as above -- controller reports the failure via setStatus.
    } finally {
      this._setBusy(false);
      this.render();
    }
  }

  async _acceptPending() {
    if (!this.pendingAddition || this.busy) return;
    const text = this.pendingAddition;
    this.pendingAddition = null;
    this._setBusy(true);
    try {
      await this.onAcceptAddLines(text);
    } catch (_) {
      // Controller surfaces the failure via setStatus; nothing left in the panel to roll back.
    } finally {
      this._setBusy(false);
      this.render();
    }
  }

  _discardPending() {
    if (!this.pendingAddition) return;
    this.pendingAddition = null;
    this.onDiscardAddLines?.();
    this.render();
  }

  _setBusy(busy) {
    this.busy = busy;
    this.sendBtn.disabled = busy;
    this.addLinesBtn.disabled = busy || Boolean(this.pendingAddition);
    this.addLinesBtn.textContent = busy && !this.pendingAddition ? 'Working…' : 'Add next 10 lines';
    this.acceptBtn.disabled = busy;
    this.discardBtn.disabled = busy;
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
      empty.textContent = 'Ask a question about your screenplay, or click "Add next 10 lines" to continue writing it.';
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

    this.previewEl.hidden = !this.pendingAddition;
    if (this.pendingAddition) this.previewText.textContent = this.pendingAddition;
    this.addLinesBtn.disabled = this.busy || Boolean(this.pendingAddition);
  }

  destroy() {
    this.root.remove();
  }
}

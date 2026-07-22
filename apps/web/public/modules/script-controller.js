import { ScreenplayEditor } from './screenplay-editor/js/ScreenplayEditor.js';
import { toFinalDraftXml, toPlainScript, toPrintableScriptHtml, toRichTextScript, toStructuredScriptJson } from './script-export.js';
import { assertElements } from './dom-contract.js';

const STUDIO_PAGE_STORAGE_KEY = 'storyframe.activeStudioPage';

export function initScriptController(elements, { setStatus, onScriptChange } = {}) {
  assertElements('Script controller', elements, [
    'scriptText', 'modeSelect', 'editorContainer', 'pagePanel', 'focusBtn',
    'downloadBtn', 'downloadMenu', 'pageTabs', 'pageTabButtons', 'pagePanels',
    'storyboardTitle',
  ]);
  let editor = null;
  let activePage = 'storyboard';
  let pageSwitchToken = 0;

  const updateScriptText = (rawText, { emit = true } = {}) => {
    if (elements.scriptText.value !== rawText) elements.scriptText.value = rawText;
    if (emit) elements.scriptText.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const setEditorMode = (mode) => {
    const currentMode = mode || 'raw';
    try { localStorage.setItem('scriptEditorMode', currentMode); } catch (_) {}
    if (elements.modeSelect.value !== currentMode) elements.modeSelect.value = currentMode;

    if (currentMode === 'screenplay') {
      const initialScript = elements.scriptText.value || '';
      elements.scriptText.hidden = true;
      elements.editorContainer.hidden = false;
      if (!editor) {
        if (!elements.pagePanel.hidden) {
          editor = new ScreenplayEditor({
            container: elements.editorContainer,
            initialScript,
            format: 'fountain',
            showToolbar: true,
            onChange: ({ rawText }) => updateScriptText(rawText),
          });
        }
      } else {
        editor.loadScript(initialScript, 'fountain');
      }
    } else {
      if (editor) updateScriptText(editor.getRawScript('fountain'));
      elements.editorContainer.hidden = true;
      elements.scriptText.hidden = false;
    }
  };

  const applyPage = (page, { persist = true } = {}) => {
    const activeButton = elements.pageTabButtons.find((button) => button.dataset.page === page);
    if (!activeButton) return;
    elements.pageTabButtons.forEach((button) => {
      const isActive = button === activeButton;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-selected', String(isActive));
      button.tabIndex = isActive ? 0 : -1;
    });
    elements.pagePanels.forEach((panel) => {
      panel.hidden = panel.id !== activeButton.getAttribute('aria-controls');
    });
    activePage = page;
    if (persist) {
      try { localStorage.setItem(STUDIO_PAGE_STORAGE_KEY, page); } catch (_) {}
    }
    if (page === 'script' && elements.modeSelect.value === 'screenplay' && !editor) setEditorMode('screenplay');
  };

  const switchPage = async (page, { instant = false } = {}) => {
    if (!elements.pageTabButtons.some((button) => button.dataset.page === page)) return;
    if (page === activePage) {
      try { localStorage.setItem(STUDIO_PAGE_STORAGE_KEY, page); } catch (_) {}
      return;
    }
    if (instant || !elements.pageTransition) {
      applyPage(page);
      return;
    }
    const token = ++pageSwitchToken;
    const pageLabel = elements.pageTabButtons.find((button) => button.dataset.page === page)?.textContent.trim() || 'page';
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (elements.pageTransitionLabel) elements.pageTransitionLabel.textContent = `Opening ${pageLabel}…`;
    elements.pageTransition.hidden = false;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (token !== pageSwitchToken) return;
    elements.pageTransition.classList.add('is-visible');
    await new Promise((resolve) => setTimeout(resolve, reducedMotion ? 60 : 150));
    if (token !== pageSwitchToken) return;
    applyPage(page);
    elements.pageTransition.classList.remove('is-visible');
    await new Promise((resolve) => setTimeout(resolve, reducedMotion ? 0 : 120));
    if (token === pageSwitchToken) elements.pageTransition.hidden = true;
  };

  const setFocusMode = (enabled) => {
    const isEnabled = Boolean(enabled);
    elements.pagePanel.classList.toggle('is-script-focus', isEnabled);
    document.body.classList.toggle('script-focus-active', isEnabled);
    elements.focusBtn.setAttribute('aria-pressed', String(isEnabled));
    elements.focusBtn.title = isEnabled ? 'Exit distraction-free mode (Esc)' : 'Open distraction-free mode';
    if (elements.focusBtnLabel) elements.focusBtnLabel.textContent = isEnabled ? 'Exit full screen' : 'Full screen';
    [document.querySelector('.storyboard-topbar'), elements.pageTabs].forEach((element) => {
      if (!element) return;
      element.inert = isEnabled;
      if (isEnabled) element.setAttribute('aria-hidden', 'true');
      else element.removeAttribute('aria-hidden');
    });
  };

  const fountainScript = () => editor && elements.modeSelect.value === 'screenplay'
    ? editor.getRawScript('fountain')
    : elements.scriptText.value || '';
  const exportSource = () => editor && elements.modeSelect.value === 'screenplay'
    ? editor.getScriptDocument()
    : fountainScript();
  const fileBaseName = () => (elements.storyboardTitle.value.trim() || 'screenplay').toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'screenplay';
  const downloadFile = (content, extension, mimeType) => {
    const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${fileBaseName()}.${extension}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const closeDownloadMenu = ({ restoreFocus = false } = {}) => {
    elements.downloadMenu.hidden = true;
    elements.downloadBtn.setAttribute('aria-expanded', 'false');
    if (restoreFocus) elements.downloadBtn.focus();
  };
  const exportScript = (format) => {
    const fountain = fountainScript();
    const source = exportSource();
    const title = elements.storyboardTitle.value.trim() || 'Screenplay';
    if (format === 'fountain') downloadFile(`${fountain.replace(/\s+$/, '')}\n`, 'fountain', 'text/plain;charset=utf-8');
    else if (format === 'fdx') downloadFile(toFinalDraftXml(source), 'fdx', 'application/xml;charset=utf-8');
    else if (format === 'rtf') downloadFile(toRichTextScript(source), 'rtf', 'application/rtf');
    else if (format === 'text') downloadFile(`${toPlainScript(source).replace(/\s+$/, '')}\n`, 'txt', 'text/plain;charset=utf-8');
    else if (format === 'json') downloadFile(toStructuredScriptJson(source), 'json', 'application/json;charset=utf-8');
    else if (format === 'print') {
      const printWindow = window.open('', '_blank');
      if (!printWindow) return setStatus?.('Allow pop-ups to print or save the screenplay as PDF.');
      printWindow.opener = null;
      printWindow.document.open();
      printWindow.document.write(toPrintableScriptHtml(source, title));
      printWindow.document.close();
      printWindow.focus();
      setTimeout(() => printWindow.print(), 100);
    }
  };

  let savedPage = activePage;
  try {
    const storedPage = localStorage.getItem(STUDIO_PAGE_STORAGE_KEY);
    if (elements.pageTabButtons.some((button) => button.dataset.page === storedPage)) savedPage = storedPage;
  } catch (_) {}
  applyPage(savedPage, { persist: false });
  let savedMode = 'raw';
  try { savedMode = localStorage.getItem('scriptEditorMode') || 'raw'; } catch (_) {}
  setEditorMode(savedMode);

  elements.pageTabButtons.forEach((button) => button.addEventListener('click', () => switchPage(button.dataset.page)));
  elements.pageTabs.addEventListener('keydown', (event) => {
    const currentIndex = elements.pageTabButtons.indexOf(document.activeElement);
    if (currentIndex < 0) return;
    let nextIndex;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % elements.pageTabButtons.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + elements.pageTabButtons.length) % elements.pageTabButtons.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = elements.pageTabButtons.length - 1;
    else return;
    event.preventDefault();
    elements.pageTabButtons[nextIndex].focus();
    elements.pageTabButtons[nextIndex].click();
  });
  elements.modeSelect.addEventListener('change', (event) => setEditorMode(event.target.value));
  elements.focusBtn.addEventListener('click', () => setFocusMode(!elements.pagePanel.classList.contains('is-script-focus')));
  elements.downloadBtn.addEventListener('click', () => {
    const willOpen = elements.downloadMenu.hidden;
    elements.downloadMenu.hidden = !willOpen;
    elements.downloadBtn.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) elements.downloadMenu.querySelector('[role="menuitem"]')?.focus();
  });
  elements.downloadMenu.addEventListener('click', (event) => {
    const option = event.target.closest('[data-script-format]');
    if (!option) return;
    exportScript(option.dataset.scriptFormat);
    closeDownloadMenu();
  });
  elements.scriptText.addEventListener('input', () => onScriptChange?.());
  document.addEventListener('click', (event) => {
    if (elements.downloadMenu.hidden || event.target === elements.downloadBtn || elements.downloadBtn.contains(event.target)) return;
    if (!elements.downloadMenu.contains(event.target)) closeDownloadMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!elements.downloadMenu.hidden) {
      event.preventDefault();
      closeDownloadMenu({ restoreFocus: true });
    } else if (elements.pagePanel.classList.contains('is-script-focus')) {
      event.preventDefault();
      setFocusMode(false);
      elements.focusBtn.focus();
    }
  }, true);

  return {
    syncFromText: () => {
      if (editor && elements.modeSelect.value === 'screenplay') editor.loadScript(elements.scriptText.value || '', 'fountain');
    },
  };
}

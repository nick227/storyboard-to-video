import { ScreenplayEditor } from '../screenplay-editor/js/ScreenplayEditor.js';
import { toFinalDraftXml, toPlainScript, toPrintableScriptHtml, toRichTextScript, toStructuredScriptJson } from './export.js';
import { assertElements } from '../core/dom-contract.js';
import {
  DEFAULT_ARTIFACT, PAGE_TO_ARTIFACT, authorSlugFromRecord, authorSlugFromSession,
  parseWorkPath, scriptSlugFromRecord, workPath,
} from '../core/app-paths.js';

const STUDIO_PAGE_STORAGE_KEY = 'storyboarder.activeStudioPage';
const SCRIPT_THEME_STORAGE_KEY = 'storyboarder.scriptTheme';

export function initScriptController(elements, {
  setStatus, onScriptChange, onPageChange, getCurrentRecord, getSession, getCoverMeta,
  onTitlePageChange, onTitlePageCoverClick,
} = {}) {
  assertElements('Script controller', elements, [
    'scriptText', 'modeSelect', 'themeSelect', 'editorContainer', 'pagePanel', 'focusBtn',
    'downloadBtn', 'downloadMenu', 'pageTabs', 'pageTabButtons', 'pagePanels',
    'storyboardTitle',
  ]);
  let editor = null;
  let activePage = 'storyboard';
  let pageSwitchToken = 0;
  const stickyChrome = {
    topbar: document.querySelector('.sf-topbar'),
    workbar: document.querySelector('.sf-workbar'),
    storyboard: document.querySelector('.storyboard-topbar'),
    scriptHeader: elements.pagePanel.querySelector('.script-header-row'),
  };

  const syncStickyChromeMetrics = () => {
    const height = (element, fallback) => {
      if (!element || element.hidden || getComputedStyle(element).display === 'none') return 0;
      const measured = Math.ceil(element.getBoundingClientRect().height);
      return measured > 0 ? measured : fallback;
    };
    const topbarHeight = height(stickyChrome.topbar, 57);
    const workbarHeight = height(stickyChrome.workbar, 44);
    const storyboardHeight = height(stickyChrome.storyboard, 48);
    const scriptHeaderHeight = height(stickyChrome.scriptHeader, 46);
    const rootStyle = document.documentElement.style;
    rootStyle.setProperty('--sf-topbar-height', `${topbarHeight}px`);
    rootStyle.setProperty('--sf-workbar-height', `${workbarHeight}px`);
    rootStyle.setProperty('--storyboard-topbar-height', `${storyboardHeight}px`);
    rootStyle.setProperty('--script-header-height', `${scriptHeaderHeight}px`);
    rootStyle.setProperty(
      '--screenplay-chrome-height',
      `${topbarHeight + workbarHeight + storyboardHeight + scriptHeaderHeight}px`,
    );
  };

  const stickyChromeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(syncStickyChromeMetrics)
    : null;
  Object.values(stickyChrome).forEach((element) => {
    if (element) stickyChromeObserver?.observe(element);
  });

  const syncEditorLayoutState = () => {
    const isActive = activePage === 'script'
      && elements.modeSelect.value === 'screenplay'
      && !elements.pagePanel.hidden;
    document.body.classList.toggle('screenplay-editor-active', isActive);
    document.documentElement.classList.toggle('screenplay-editor-active', isActive);
    requestAnimationFrame(syncStickyChromeMetrics);
  };

  const updateScriptText = (rawText, { emit = true } = {}) => {
    if (elements.scriptText.value !== rawText) elements.scriptText.value = rawText;
    if (emit) elements.scriptText.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const currentTitlePageMeta = () => {
    const record = getCurrentRecord?.();
    const script = record?.script || {};
    return {
      title: elements.storyboardTitle.value.trim() || script.title || 'Untitled',
      author: script.author || getSession?.()?.user?.displayName || 'Anonymous',
      coverUrl: script.coverUrl || null,
      logline: script.logline || '',
      summary: script.summary || '',
    };
  };

  // Grows the raw-text textarea to fit its content instead of scrolling internally.
  // Skipped in fullscreen focus mode, where CSS flex sizing (fill + its own scroll) takes over.
  const autosizeScriptText = () => {
    if (elements.pagePanel.classList.contains('is-script-focus')) return;
    elements.scriptText.style.height = 'auto';
    elements.scriptText.style.height = `${elements.scriptText.scrollHeight}px`;
  };

  const setToolbarHostsVisible = (visible) => {
    if (!elements.toolbarHost) return;
    elements.toolbarHost.classList.toggle('is-inactive', !visible);
    elements.toolbarHost.setAttribute('aria-hidden', String(!visible));
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
            toolbarHost: elements.toolbarHost || null,
            initialScript,
            format: 'fountain',
            theme: elements.themeSelect.value,
            titlePage: currentTitlePageMeta(),
            showToolbar: true,
            onChange: ({ rawText }) => updateScriptText(rawText),
            onTitlePageChange,
            onTitlePageCoverClick,
          });
        }
      } else {
        editor.loadScript(initialScript, 'fountain');
        editor.setTitlePageMeta(currentTitlePageMeta());
        setToolbarHostsVisible(true);
      }
      setToolbarHostsVisible(Boolean(editor));
    } else {
      elements.editorContainer.hidden = true;
      elements.scriptText.hidden = false;
      if (editor) updateScriptText(editor.getRawScript('fountain'));
      autosizeScriptText();
      setToolbarHostsVisible(false);
    }
    syncEditorLayoutState();
  };

  const currentSlug = () => scriptSlugFromRecord(getCurrentRecord?.());
  const currentAuthor = () => authorSlugFromRecord(getCurrentRecord?.(), getSession?.());

  const syncTabHrefs = (slug = currentSlug()) => {
    const author = currentAuthor();
    const projectId = getCurrentRecord?.()?.id;
    elements.pageTabButtons.forEach((button) => {
      const artifact = button.dataset.artifact || PAGE_TO_ARTIFACT[button.dataset.page] || DEFAULT_ARTIFACT;
      const url = new URL(workPath(author, slug || 'untitled', artifact, { edit: true }), window.location.origin);
      if (projectId) url.searchParams.set('project', projectId);
      button.setAttribute('href', `${url.pathname}${url.search}`);
    });
    const download = document.getElementById('downloadZipBtn');
    if (download) {
      const artifact = PAGE_TO_ARTIFACT[activePage] || DEFAULT_ARTIFACT;
      const url = new URL(workPath(author, slug || 'untitled', artifact, { edit: true }), window.location.origin);
      if (projectId) url.searchParams.set('project', projectId);
      url.searchParams.set('download', '1');
      download.setAttribute('href', `${url.pathname}${url.search}`);
    }
  };

  const applyPage = (page, { persist = true } = {}) => {
    const activeButton = elements.pageTabButtons.find((button) => button.dataset.page === page);
    if (!activeButton) return;
    elements.pageTabButtons.forEach((button) => {
      const isActive = button === activeButton;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-selected', String(isActive));
      button.setAttribute('aria-current', isActive ? 'page' : 'false');
      button.tabIndex = isActive ? 0 : -1;
    });
    elements.pagePanels.forEach((panel) => {
      const target = activeButton.getAttribute('aria-controls') || activeButton.dataset.panel;
      panel.hidden = panel.id !== target;
    });
    activePage = page;
    const slug = currentSlug();
    syncTabHrefs(slug);
    if (persist && getCurrentRecord?.()) {
      try { localStorage.setItem(STUDIO_PAGE_STORAGE_KEY, page); } catch (_) {}
      const artifact = PAGE_TO_ARTIFACT[page] || DEFAULT_ARTIFACT;
      const url = new URL(window.location.href);
      url.searchParams.delete('page');
      const next = `${workPath(currentAuthor(), slug || 'untitled', artifact, { edit: true })}${url.search}${url.hash}`;
      history.replaceState(history.state, '', next);
    }
    if (page === 'script' && elements.modeSelect.value === 'screenplay' && !editor) setEditorMode('screenplay');
    syncEditorLayoutState();
    onPageChange?.(page);
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
    [document.querySelector('.storyboard-topbar'), document.querySelector('.sf-workbar')].forEach((element) => {
      if (!element) return;
      element.inert = isEnabled;
      if (isEnabled) element.setAttribute('aria-hidden', 'true');
      else element.removeAttribute('aria-hidden');
    });
    if (!isEnabled) autosizeScriptText();
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
    const cover = typeof getCoverMeta === 'function' ? getCoverMeta() : {};
    const coverMeta = {
      title: cover.title || title,
      author: cover.author || '',
      summary: cover.summary || '',
      coverUrl: cover.coverUrl || null,
    };
    if (format === 'fountain') downloadFile(`${fountain.replace(/\s+$/, '')}\n`, 'fountain', 'text/plain;charset=utf-8');
    else if (format === 'fdx') downloadFile(toFinalDraftXml(source, coverMeta), 'fdx', 'application/xml;charset=utf-8');
    else if (format === 'rtf') downloadFile(toRichTextScript(source, coverMeta), 'rtf', 'application/rtf');
    else if (format === 'text') downloadFile(`${toPlainScript(source, coverMeta).replace(/\s+$/, '')}\n`, 'txt', 'text/plain;charset=utf-8');
    else if (format === 'json') downloadFile(toStructuredScriptJson(source), 'json', 'application/json;charset=utf-8');
    else if (format === 'print') {
      const printWindow = window.open('', '_blank');
      if (!printWindow) return setStatus?.('Allow pop-ups to print or save the screenplay as PDF.');
      printWindow.opener = null;
      printWindow.document.open();
      printWindow.document.write(toPrintableScriptHtml(source, title, coverMeta));
      printWindow.document.close();
      printWindow.focus();
      setTimeout(() => printWindow.print(), 100);
    }
  };

  let savedPage = activePage;
  try {
    const fromPath = parseWorkPath(window.location.pathname)?.page;
    const storedPage = localStorage.getItem(STUDIO_PAGE_STORAGE_KEY);
    if (elements.pageTabButtons.some((button) => button.dataset.page === fromPath)) savedPage = fromPath;
    else if (elements.pageTabButtons.some((button) => button.dataset.page === storedPage)) savedPage = storedPage;
    else savedPage = 'script';
  } catch (_) {}
  applyPage(savedPage, { persist: true });
  let savedTheme = 'light';
  try { savedTheme = localStorage.getItem(SCRIPT_THEME_STORAGE_KEY) || 'light'; } catch (_) {}
  if (!['light', 'dark'].includes(savedTheme)) savedTheme = 'light';
  elements.themeSelect.value = savedTheme;
  let savedMode = 'raw';
  try { savedMode = localStorage.getItem('scriptEditorMode') || 'raw'; } catch (_) {}
  setEditorMode(savedMode);

  elements.pageTabButtons.forEach((button) => button.addEventListener('click', (event) => {
    event.preventDefault();
    switchPage(button.dataset.page);
  }));
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
  elements.themeSelect.addEventListener('change', (event) => {
    const theme = event.target.value === 'dark' ? 'dark' : 'light';
    try { localStorage.setItem(SCRIPT_THEME_STORAGE_KEY, theme); } catch (_) {}
    editor?.setTheme(theme);
  });
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
  elements.scriptText.addEventListener('input', () => {
    autosizeScriptText();
    onScriptChange?.();
  });
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
      if (editor && elements.modeSelect.value === 'screenplay') {
        editor.loadScript(elements.scriptText.value || '', 'fountain');
        editor.setTitlePageMeta(currentTitlePageMeta());
      }
    },
    autosizeScriptText,
    syncRoute: () => applyPage(activePage, { persist: true }),
    activePage: () => activePage,
    syncTitlePage: (meta) => editor?.setTitlePageMeta(meta || currentTitlePageMeta()),
    startNewScript: () => {
      applyPage('script', { persist: true });
      setEditorMode('screenplay');
      requestAnimationFrame(() => editor?.focusInitialSceneHeading());
    },
    // editor.loadScript() only re-renders -- it never calls onChange/_notifyChange -- so
    // updateScriptText() below is what actually dispatches the `input` event that fires
    // onScriptChange (app.js) and the save pipeline, same as every manual keystroke.
    appendScriptText: (text) => {
      const trimmed = fountainScript().replace(/\s+$/, '');
      const newRaw = `${trimmed}${trimmed ? '\n\n' : ''}${text.trim()}\n`;
      if (editor && elements.modeSelect.value === 'screenplay') editor.loadScript(newRaw, 'fountain');
      updateScriptText(newRaw);
      return newRaw;
    },
    replaceScriptText: (text) => {
      const newRaw = String(text || '').replace(/\s+$/, '');
      if (editor && elements.modeSelect.value === 'screenplay') editor.loadScript(newRaw, 'fountain');
      updateScriptText(newRaw);
      return newRaw;
    },
    openHelp: () => editor?.helpModal?.open(),
  };
}

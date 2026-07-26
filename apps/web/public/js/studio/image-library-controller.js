import { projectStore, sceneStore, generationStore } from '../core/store.js';
import { getCurrentStoryboardRecord, queueSync } from '../core/persistence.js';
import { loadProtectedAssetBlob } from '../core/assets.js';
import { adaptSceneImageShot, imageShot, setActiveImageVersion } from '../core/scene-shots.js';
import { api } from '../core/api.js';

function emptyState(token = 0) {
  return {
    token,
    mode: '',
    projectId: '',
    styleId: '',
    sceneId: '',
    scriptId: '',
    coverUrl: null,
    onCoverApplied: null,
    sceneNumber: 1,
    domEls: null,
    setStatus: null,
    uploads: [],
    generations: [],
    pastStoryboards: [],
    hasRetrievedPast: false,
    stockQuery: '',
    stockPage: 0,
    stockResults: [],
    stockHasMore: false,
  };
}

function appendEmptyState(container, message) {
  const empty = document.createElement('div');
  empty.className = 'library-image-empty';
  empty.textContent = message;
  container.replaceChildren(empty);
}

// Not stopword/keyword extraction -- just the prompt's leading clause, capped short, left fully
// editable in the search box. The full AI visual prompt is a sentence; Pixabay searches better on
// a short phrase, but guessing "meaningful" words out of the sentence is more likely to produce a
// worse query than just truncating it and letting the user fix it up.
function deriveStockQuery(prompt) {
  const text = String(prompt || '').trim();
  if (!text) return '';
  const leadingClause = text.split(/[.,;:]/)[0].trim();
  return (leadingClause || text).split(/\s+/).slice(0, 8).join(' ');
}

export class ImageLibraryController {
  constructor() {
    this.state = emptyState();
    this.dom = null;
    this.renderStyleReferences = null;
    this.initialized = false;
    this.contextAbortController = null;
    this.previewScopes = new Map();
  }

  init(domEls, setStatus, { renderStyleReferences } = {}) {
    if (this.initialized) return;
    const modal = document.getElementById('imageLibraryModal');
    if (!modal) return;

    const byId = (id) => modal.querySelector(`#${id}`);
    this.dom = {
      modal,
      closeBtn: byId('closeImageLibraryBtn'),
      doneBtn: byId('closeImageLibraryDoneBtn'),
      generateBtn: byId('libraryGenerateBtn'),
      uploadInput: byId('libraryUploadInput'),
      useStoryCheckbox: byId('libraryUseStory'),
      providerSelect: byId('libraryProviderSelect'),
      promptTextarea: byId('libraryAiPrompt'),
      retrievePastBtn: byId('libraryRetrievePastBtn'),
      controls: modal.querySelector('.ai-generator-controls'),
      tabButtons: [...modal.querySelectorAll('.library-tabs .tab-btn')],
      tabPanes: [...modal.querySelectorAll('.library-tab-content .tab-pane')],
      uploadsPane: byId('libraryTabUploads'),
      generationsPane: byId('libraryTabGenerations'),
      stockPane: byId('libraryTabStock'),
      stockQueryInput: byId('libraryStockQuery'),
      stockSearchBtn: byId('libraryStockSearchBtn'),
      stockList: byId('libraryStockList'),
      stockStatus: byId('libraryStockStatus'),
      stockLoadMoreBtn: byId('libraryStockLoadMoreBtn'),
      pastPane: byId('libraryTabPast'),
      pastList: byId('libraryPastList'),
      pastPlaceholder: modal.querySelector('.past-storyboards-placeholder'),
      activeList: byId('libraryActiveList'),
      contextLabel: byId('imageLibraryModalContextLabel'),
      modalTitle: byId('imageLibraryModalTitle'),
      activeLabel: byId('libraryActiveSectionLabel'),
    };
    this.renderStyleReferences = renderStyleReferences;
    this.initialized = true;

    domEls.characterRefLibraryBtn?.addEventListener('click', () => {
      this.open({
        mode: 'character-reference',
        styleId: domEls.styleSelect.value,
        domEls,
        setStatus,
      });
    });
    domEls.worldRefLibraryBtn?.addEventListener('click', () => {
      this.open({
        mode: 'world-reference',
        styleId: domEls.styleSelect.value,
        domEls,
        setStatus,
      });
    });

    this.dom.closeBtn?.addEventListener('click', () => modal.close());
    this.dom.doneBtn?.addEventListener('click', () => modal.close());
    modal.addEventListener('cancel', () => this.invalidate());
    modal.addEventListener('close', () => this.invalidate());
    this.dom.generateBtn?.addEventListener('click', () => this.generate());
    this.dom.uploadInput?.addEventListener('change', (event) => this.upload(event));
    this.dom.retrievePastBtn?.addEventListener('click', () => this.retrievePastStoryboards());
    this.dom.stockSearchBtn?.addEventListener('click', () => this.searchStock());
    this.dom.stockQueryInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); this.searchStock(); }
    });
    this.dom.stockLoadMoreBtn?.addEventListener('click', () => this.searchStock({ resetPage: false }));
    this.dom.tabButtons.forEach((button) => {
      button.addEventListener('click', () => this.selectTab(button.dataset.tab));
    });
  }

  invalidate() {
    this.contextAbortController?.abort();
    this.contextAbortController = null;
    this.clearAllPreviewScopes();
    this.setLoading(false);
    this.state = emptyState(this.state.token + 1);
    this.dom?.controls?.classList.remove('is-generating');
  }

  context() {
    const { token, projectId, mode, styleId, sceneId, scriptId } = this.state;
    return { token, projectId, mode, styleId, sceneId, scriptId, signal: this.contextAbortController?.signal };
  }

  isCurrent(context) {
    return Boolean(
      context
      && this.dom?.modal.open
      && context.token === this.state.token
      && context.projectId === this.state.projectId
      && context.projectId === projectStore.get().currentId
      && context.mode === this.state.mode
      && context.styleId === this.state.styleId
      && context.sceneId === this.state.sceneId
      && (!context.styleId || !this.state.domEls?.styleSelect || context.styleId === this.state.domEls.styleSelect.value)
      && (context.mode !== 'scene-image' || sceneStore.get().scenes.some((scene) => scene.id === context.sceneId))
    );
  }

  async open({ mode, styleId, sceneId, sceneNumber, scriptId, coverUrl, onCoverApplied, prepare, domEls, setStatus }) {
    if (!this.initialized || !this.dom) return;
    this.contextAbortController?.abort();
    this.clearAllPreviewScopes();
    this.contextAbortController = new AbortController();
    const openToken = this.state.token + 1;
    const projectId = projectStore.get().currentId || '';
    this.state = {
      ...emptyState(openToken),
      mode,
      projectId,
      styleId: styleId || '',
      sceneId: sceneId || '',
      scriptId: scriptId || '',
      coverUrl: coverUrl || null,
      onCoverApplied: typeof onCoverApplied === 'function' ? onCoverApplied : null,
      sceneNumber: sceneNumber || 1,
      domEls,
      setStatus,
    };

    const referenceMode = mode === 'character-reference' || mode === 'world-reference';
    const uploadsTab = this.dom.tabButtons.find((button) => button.dataset.tab === 'uploads');
    if (uploadsTab) uploadsTab.textContent = referenceMode ? 'Style References' : 'User Uploads';
    this.dom.promptTextarea.value = '';
    this.dom.useStoryCheckbox.checked = false;
    this.dom.retrievePastBtn.disabled = false;
    this.dom.retrievePastBtn.textContent = 'Retrieve Past Storyboard Images';
    this.dom.stockList.replaceChildren();
    this.dom.stockStatus.hidden = true;
    this.dom.stockLoadMoreBtn.hidden = true;
    this.dom.stockQueryInput.value = mode === 'scene-image'
      ? deriveStockQuery(imageShot(sceneStore.get().scenes.find((candidate) => candidate.id === sceneId)).prompt)
      : '';

    if (mode === 'character-reference') {
      this.dom.contextLabel.textContent = 'Style References > Character';
      this.dom.modalTitle.textContent = 'Character Reference Library';
      this.dom.activeLabel.textContent = 'Active character reference images';
    } else if (mode === 'world-reference') {
      this.dom.contextLabel.textContent = 'Style References > World';
      this.dom.modalTitle.textContent = 'World Reference Library';
      this.dom.activeLabel.textContent = 'Active world reference images';
    } else if (mode === 'scene-image') {
      this.dom.contextLabel.textContent = `Scene ${this.state.sceneNumber} Image`;
      this.dom.modalTitle.textContent = 'Scene Image Library';
      this.dom.activeLabel.textContent = 'Versions for this scene';
    } else if (mode === 'screenplay-cover') {
      this.dom.contextLabel.textContent = 'Screenplay';
      this.dom.modalTitle.textContent = 'Cover Art Library';
      this.dom.activeLabel.textContent = 'Current cover art';
    }

    this.selectTab('uploads');
    this.renderActiveList();
    appendEmptyState(this.dom.uploadsPane, 'Loading library…');
    appendEmptyState(this.dom.generationsPane, 'Loading library…');
    this.setLoading(true);
    this.dom.modal.showModal();

    try {
      if (typeof prepare === 'function') {
        const prepared = await prepare();
        if (this.state.token !== openToken || !this.dom.modal.open) return;
        if (prepared?.scriptId) this.state.scriptId = prepared.scriptId;
        if (prepared?.coverUrl !== undefined) this.state.coverUrl = prepared.coverUrl || null;
        if (prepared?.projectId) this.state.projectId = prepared.projectId;
        else this.state.projectId = projectStore.get().currentId || this.state.projectId;
        this.renderActiveList();
      }

      if (referenceMode) {
        const isCustom = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(this.state.styleId);
        if (isCustom) {
          try {
            const refsData = await api(`/api/custom-styles/${encodeURIComponent(this.state.styleId)}/references`, {
              signal: this.contextAbortController.signal,
            });
            if (this.state.token !== openToken || !this.dom.modal.open) return;
            generationStore.set({
              styleReferences: refsData.references || { characters: [], world: [] },
              styleReferencesStyleId: this.state.styleId,
            });
            this.renderActiveList();
          } catch (_) {
            // ignore abort / fetch errors; lists still load below
          }
        }
      }

      if (this.state.projectId) await this.refreshLibraryLists(this.context());
      else {
        appendEmptyState(this.dom.uploadsPane, 'Save the work to load library images.');
        appendEmptyState(this.dom.generationsPane, 'Save the work to load library images.');
      }
    } catch (error) {
      if (this.state.token === openToken && this.dom.modal.open) {
        this.state.setStatus?.(error.message || 'Could not open image library.');
        appendEmptyState(this.dom.uploadsPane, error.message || 'Could not load library.');
      }
    } finally {
      if (this.state.token === openToken) this.setLoading(false);
    }
  }

  setLoading(loading) {
    if (!this.dom?.modal) return;
    this.dom.modal.classList.toggle('is-loading', Boolean(loading));
    this.dom.modal.setAttribute('aria-busy', String(Boolean(loading)));
  }

  selectTab(tab) {
    this.dom.tabButtons.forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
    this.dom.tabPanes.forEach((pane) => { pane.style.display = 'none'; });
    if (tab === 'uploads') this.dom.uploadsPane.style.display = 'grid';
    if (tab === 'generations') this.dom.generationsPane.style.display = 'grid';
    if (tab === 'stock') this.dom.stockPane.style.display = 'block';
    if (tab === 'past') {
      this.dom.pastPane.style.display = 'block';
      this.dom.pastList.style.display = this.state.hasRetrievedPast ? 'grid' : 'none';
      this.dom.pastPlaceholder.style.display = this.state.hasRetrievedPast ? 'none' : 'block';
    }
  }

  clearPreviewScope(name) {
    const scope = this.previewScopes.get(name);
    for (const url of scope?.urls || []) URL.revokeObjectURL(url);
    this.previewScopes.set(name, { generation: (scope?.generation || 0) + 1, urls: new Set() });
  }

  clearAllPreviewScopes() {
    for (const name of this.previewScopes.keys()) this.clearPreviewScope(name);
  }

  async loadPreview(image, path, scopeName) {
    const context = this.context();
    const scope = this.previewScopes.get(scopeName) || { generation: 0, urls: new Set() };
    this.previewScopes.set(scopeName, scope);
    const generation = scope.generation;
    try {
      const blob = await loadProtectedAssetBlob(path, { signal: context.signal });
      const currentScope = this.previewScopes.get(scopeName);
      if (!this.isCurrent(context) || currentScope?.generation !== generation || !image.isConnected) return;
      const url = URL.createObjectURL(blob);
      currentScope.urls.add(url);
      image.src = url;
    } catch (error) {
      if (error.name !== 'AbortError' && this.isCurrent(context)) {
        this.state.setStatus?.(`Could not load image preview: ${error.message}`);
      }
    }
  }

  async generate() {
    const context = this.context();
    const userPrompt = this.dom.promptTextarea.value.trim();
    const useStory = this.dom.useStoryCheckbox.checked;
    if (!context.projectId) return;
    if (!userPrompt && !useStory) {
      this.state.setStatus?.('Please enter a prompt or select “Use story”.');
      return;
    }

    this.dom.controls?.classList.add('is-generating');
    try {
      const data = await api(`/api/projects/${encodeURIComponent(context.projectId)}/images/generate-reference`, {
        method: 'POST',
        signal: context.signal,
        body: JSON.stringify({
          userPrompt,
          useStory,
          provider: this.dom.providerSelect.value,
          styleId: context.styleId,
          mode: context.mode,
        }),
      });
      if (!this.isCurrent(context)) return;
      this.dom.promptTextarea.value = '';
      await this.refreshLibraryLists(context);
      if (!this.isCurrent(context)) return;
      if (context.mode === 'scene-image') {
        await this.selectLibraryImage(data.path, data.fileName, context);
      } else if (context.mode === 'screenplay-cover') {
        await this.applyScreenplayCover(data.path, data.fileName, context);
      } else {
        await this.addImageToActive(data.path, data.fileName, context);
      }
    } catch (error) {
      if (this.isCurrent(context)) this.state.setStatus?.(`Generation failed: ${error.message}`);
    } finally {
      if (this.isCurrent(context)) this.dom.controls?.classList.remove('is-generating');
    }
  }

  async upload(event) {
    const files = event.target.files;
    const context = this.context();
    if (!files?.length || !context.projectId) return;
    this.state.setStatus?.('Uploading library images...');
    const form = new FormData();
    [...files].forEach((file) => form.append('files', file));

    try {
      const data = await api(`/api/projects/${encodeURIComponent(context.projectId)}/images/upload-reference`, {
        method: 'POST',
        signal: context.signal,
        body: form,
      });
      if (!this.isCurrent(context)) return;
      event.target.value = '';
      await this.refreshLibraryLists(context);
      if (!this.isCurrent(context)) return;
      this.state.setStatus?.('Uploaded images to library.');
      if (context.mode !== 'scene-image' && context.mode !== 'screenplay-cover') {
        for (const fileRecord of data.files || []) {
          if (!this.isCurrent(context)) return;
          await this.addImageToActive(fileRecord.path, fileRecord.fileName, context);
        }
      }
    } catch (error) {
      if (this.isCurrent(context)) this.state.setStatus?.(`Upload failed: ${error.message}`);
    }
  }

  async retrievePastStoryboards() {
    const context = this.context();
    if (!context.projectId) return;
    this.dom.retrievePastBtn.disabled = true;
    this.dom.retrievePastBtn.textContent = 'Retrieving...';
    try {
      const data = await api(`/api/projects/${encodeURIComponent(context.projectId)}/assets/past-storyboards`, { signal: context.signal });
      if (!this.isCurrent(context)) return;
      this.state.pastStoryboards = data.pastStoryboards || [];
      this.state.hasRetrievedPast = true;
      this.renderPastStoryboardsList();
      this.dom.pastList.style.display = 'grid';
      this.dom.pastPlaceholder.style.display = 'none';
    } catch (error) {
      if (!this.isCurrent(context)) return;
      this.state.setStatus?.(`Failed to retrieve past storyboards: ${error.message}`);
      this.dom.retrievePastBtn.disabled = false;
      this.dom.retrievePastBtn.textContent = 'Retrieve Past Storyboard Images';
    }
  }

  async refreshLibraryLists(context = this.context()) {
    try {
      const data = await api(`/api/projects/${encodeURIComponent(context.projectId)}/assets/library?styleId=${encodeURIComponent(context.styleId)}`, { signal: context.signal });
      if (!this.isCurrent(context)) return;
      this.state.uploads = data.uploads || [];
      this.state.generations = data.generations || [];
      this.renderActiveList();
      this.renderLibraryGrids();
    } catch (error) {
      if (this.isCurrent(context)) {
        this.state.setStatus?.(`Could not load the image library: ${error.message}`);
      }
    }
  }

  renderActiveList() {
    this.clearPreviewScope('active');
    const { mode, sceneId } = this.state;
    let activeItems = [];
    if (mode === 'character-reference' || mode === 'world-reference') {
      const type = mode === 'character-reference' ? 'characters' : 'world';
      activeItems = (generationStore.get().styleReferences[type] || []).map((reference) => ({
        id: reference.id,
        path: reference.url,
        fileName: reference.fileName,
        isActive: true,
      }));
    } else if (mode === 'scene-image') {
      const scene = sceneStore.get().scenes.find((candidate) => candidate.id === sceneId);
      const shot = imageShot(scene);
      activeItems = shot.versions.map((version, index) => ({
        path: version.path,
        fileName: version.prompt || 'Scene version',
        index,
        isActive: index === shot.activeVersionIndex,
      }));
    } else if (mode === 'screenplay-cover' && this.state.coverUrl) {
      activeItems = [{
        path: this.state.coverUrl,
        fileName: 'Current cover',
        isActive: true,
      }];
    }

    if (!activeItems.length) {
      appendEmptyState(this.dom.activeList, mode === 'screenplay-cover'
        ? 'No cover art yet. Generate, upload, or pick one below.'
        : 'No active images. Select or generate one below.');
      return;
    }
    this.dom.activeList.replaceChildren(...activeItems.map((item) => this.createActiveCard(item)));
  }

  createActiveCard(item) {
    const card = document.createElement('div');
    card.className = `library-image-card${item.isActive ? ' active' : ''}`;
    const image = document.createElement('img');
    this.loadPreview(image, item.path, 'active');
    image.alt = item.fileName;
    image.title = item.fileName;
    const actions = document.createElement('div');
    actions.className = 'library-image-card-actions';
    const button = document.createElement('button');
    button.type = 'button';
    if (this.state.mode === 'scene-image') {
      button.textContent = item.isActive ? 'Active' : 'Make Active';
      button.addEventListener('click', () => { if (!item.isActive) this.selectSceneVersion(item.index); });
    } else if (this.state.mode === 'screenplay-cover') {
      button.textContent = 'Current';
      button.disabled = true;
    } else {
      button.textContent = 'Remove';
      button.addEventListener('click', () => this.removeImageFromActive(item));
    }
    actions.append(button);
    card.append(image, actions);
    return card;
  }

  renderLibraryGrids() {
    this.renderLibraryGrid(this.dom.uploadsPane, this.state.uploads, 'uploads');
    this.renderLibraryGrid(this.dom.generationsPane, this.state.generations, 'generations');
  }

  renderLibraryGrid(container, items, scope) {
    this.clearPreviewScope(scope);
    if (!items.length) {
      appendEmptyState(container, 'No images found in this section.');
      return;
    }
    const seenPaths = new Set();
    const cards = items
      .filter((item) => {
        if (seenPaths.has(item.path)) return false;
        seenPaths.add(item.path);
        return true;
      })
      .map((item) => this.createLibraryCard(item, scope));
    container.replaceChildren(...cards);
  }

  createLibraryCard(item, scope) {
    const card = document.createElement('div');
    card.className = 'library-image-card';
    const image = document.createElement('img');
    this.loadPreview(image, item.path, scope);
    image.alt = item.fileName;
    image.title = item.fileName;
    const actions = document.createElement('div');
    actions.className = 'library-image-card-actions';
    const useButton = document.createElement('button');
    useButton.type = 'button';
    useButton.textContent = 'Use';
    useButton.addEventListener('click', () => this.selectLibraryImage(item.path, item.fileName));
    actions.append(useButton);
    if (!item.path.startsWith('/style-references/')) {
      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.textContent = 'Delete';
      deleteButton.addEventListener('click', () => this.deleteLibraryImage(item));
      actions.append(deleteButton);
    }
    const badge = document.createElement('span');
    badge.className = 'library-image-badge';
    if (item.isSystemDefault) {
      badge.textContent = 'System Default';
      badge.classList.add('system');
    } else if (item.path.includes('/user-style-references/')) {
      badge.textContent = 'User Style Reference';
      badge.classList.add('user-style');
    } else {
      badge.textContent = 'User Upload';
      badge.classList.add('user');
    }
    card.append(image, actions, badge);
    return card;
  }

  async searchStock({ resetPage = true } = {}) {
    const context = this.context();
    if (!context.projectId) return;
    const query = this.dom.stockQueryInput.value.trim();
    if (!query) { this.state.setStatus?.('Enter a search term.'); return; }

    if (resetPage) {
      this.state.stockQuery = query;
      this.state.stockPage = 0;
      this.state.stockResults = [];
    }
    const nextPage = this.state.stockPage + 1;
    this.dom.stockStatus.hidden = false;
    this.dom.stockStatus.textContent = 'Searching Pixabay...';
    this.dom.stockLoadMoreBtn.hidden = true;
    try {
      const data = await api(`/api/projects/${encodeURIComponent(context.projectId)}/stock/search?query=${encodeURIComponent(query)}&page=${nextPage}`, { signal: context.signal });
      if (!this.isCurrent(context)) return;
      this.state.stockPage = nextPage;
      this.state.stockResults = [...this.state.stockResults, ...(data.results || [])];
      this.state.stockHasMore = this.state.stockResults.length < (data.totalHits || 0) && (data.results || []).length > 0;
      this.renderStockResults();
      if (this.state.stockResults.length) {
        this.dom.stockStatus.hidden = true;
      } else {
        this.dom.stockStatus.textContent = 'No results found.';
      }
      this.dom.stockLoadMoreBtn.hidden = !this.state.stockHasMore;
    } catch (error) {
      if (this.isCurrent(context)) {
        this.dom.stockStatus.hidden = false;
        this.dom.stockStatus.textContent = `Search failed: ${error.message}`;
      }
    }
  }

  renderStockResults() {
    this.dom.stockList.replaceChildren(...this.state.stockResults.map((item) => this.createStockCard(item)));
  }

  createStockCard(item) {
    const card = document.createElement('div');
    card.className = 'library-image-card';
    const image = document.createElement('img');
    // Hotlinked directly to Pixabay's CDN for browsing -- only the selected result gets
    // downloaded and stored server-side (see selectStockResult / POST stock/select).
    image.src = item.thumbnailUrl;
    image.loading = 'lazy';
    image.alt = item.tags || 'Pixabay photo';
    image.title = item.tags || '';
    const actions = document.createElement('div');
    actions.className = 'library-image-card-actions';
    const useButton = document.createElement('button');
    useButton.type = 'button';
    useButton.textContent = 'Use';
    useButton.addEventListener('click', () => this.selectStockResult(item));
    actions.append(useButton);
    const badge = document.createElement('span');
    badge.className = 'library-image-badge';
    badge.textContent = 'Pixabay';
    card.append(image, actions, badge);
    return card;
  }

  async selectStockResult(item) {
    const context = this.context();
    if (!context.projectId) return;
    this.state.setStatus?.('Downloading stock image...');
    try {
      const data = await api(`/api/projects/${encodeURIComponent(context.projectId)}/stock/select`, {
        method: 'POST',
        signal: context.signal,
        body: JSON.stringify({
          provider: 'pixabay', fullUrl: item.fullUrl,
          sourceId: item.providerId, sourcePageUrl: item.sourcePageUrl, creator: item.creator,
        }),
      });
      if (!this.isCurrent(context)) return;
      await this.refreshLibraryLists(context);
      if (!this.isCurrent(context)) return;
      if (context.mode === 'scene-image') {
        await this.selectLibraryImage(data.path, data.fileName, context);
      } else if (context.mode === 'screenplay-cover') {
        await this.applyScreenplayCover(data.path, data.fileName, context);
      } else {
        await this.addImageToActive(data.path, data.fileName, context);
      }
      const creator = data.provenance?.creator;
      this.state.setStatus?.(creator ? `Added from Pixabay — photo by ${creator}.` : 'Added from Pixabay.');
    } catch (error) {
      if (this.isCurrent(context)) this.state.setStatus?.(`Failed to use stock image: ${error.message}`);
    }
  }

  async deleteLibraryImage(item) {
    if (!confirm('Are you sure you want to delete this library image?')) return;
    const context = this.context();
    try {
      if (item.path.includes('/user-style-references/')) {
        const refType = item.type || (context.mode === 'character-reference' ? 'characters' : 'world');
        await api(`/api/styles/${encodeURIComponent(context.styleId)}/references`, {
          method: 'DELETE',
          signal: context.signal,
          body: JSON.stringify({ type: refType, fileName: item.fileName, deleteFile: true }),
        });
      } else {
        await api(`/api/projects/${encodeURIComponent(context.projectId)}/assets/${encodeURIComponent(item.type || 'ai-references')}/${encodeURIComponent(item.fileName)}`, {
          method: 'DELETE',
          signal: context.signal,
        });
      }
      if (this.isCurrent(context)) await this.refreshLibraryLists(context);
    } catch (error) {
      if (this.isCurrent(context)) this.state.setStatus?.(`Delete failed: ${error.message}`);
    }
  }

  renderPastStoryboardsList() {
    this.clearPreviewScope('past');
    if (!this.state.pastStoryboards.length) {
      appendEmptyState(this.dom.pastList, 'No past storyboard images found.');
      return;
    }
    const cards = this.state.pastStoryboards.map((item) => {
      const card = document.createElement('div');
      card.className = 'library-image-card';
      const image = document.createElement('img');
      this.loadPreview(image, item.path, 'past');
      image.alt = item.sceneTitle || 'Past Scene';
      const meta = document.createElement('div');
      meta.className = 'library-past-card-meta';
      meta.textContent = `${item.projectTitle} - Scene ${item.sceneTitle}`;
      const actions = document.createElement('div');
      actions.className = 'library-image-card-actions';
      const useButton = document.createElement('button');
      useButton.type = 'button';
      useButton.textContent = 'Use';
      useButton.addEventListener('click', () => this.selectLibraryImage(item.path, 'past-storyboard-image.png'));
      actions.append(useButton);
      card.append(image, meta, actions);
      return card;
    });
    this.dom.pastList.replaceChildren(...cards);
  }

  async assetFile(path, fileName, context) {
    const blob = await loadProtectedAssetBlob(path, { signal: context.signal });
    if (!this.isCurrent(context)) return null;
    return new File([blob], fileName, { type: blob.type });
  }

  async addImageToActive(path, fileName, context = this.context()) {
    if (context.mode !== 'character-reference' && context.mode !== 'world-reference') return;
    const type = context.mode === 'character-reference' ? 'characters' : 'world';
    const isCustom = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(context.styleId);
    try {
      const file = await this.assetFile(path, fileName || 'reference.png', context);
      if (!file) return;
      this.state.setStatus?.(`Adding to active ${type}...`);
      const form = new FormData();
      form.append('files', file);
      
      const uploadUrl = isCustom
        ? `/api/custom-styles/${encodeURIComponent(context.styleId)}/references?type=${encodeURIComponent(type)}`
        : `/api/styles/${encodeURIComponent(context.styleId)}/references/upload?type=${encodeURIComponent(type)}`;

      const data = await api(uploadUrl, {
        method: 'POST',
        signal: context.signal,
        body: form,
      });
      if (!this.isCurrent(context)) return;
      generationStore.set({ styleReferences: data.references || { characters: [], world: [] }, styleReferencesStyleId: context.styleId });
      this.renderStyleReferences?.(this.state.domEls, this.state.setStatus);
      this.renderActiveList();
      this.state.setStatus?.(`Added to active ${type}.`);
    } catch (error) {
      if (this.isCurrent(context)) this.state.setStatus?.(`Failed to add image: ${error.message}`);
    }
  }

  async removeImageFromActive(item) {
    const context = this.context();
    const type = context.mode === 'character-reference' ? 'characters' : 'world';
    const isCustom = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(context.styleId);
    try {
      this.state.setStatus?.(`Removing from active ${type}...`);
      let data;
      if (isCustom) {
        data = await api(`/api/custom-styles/${encodeURIComponent(context.styleId)}/references/${encodeURIComponent(item.id)}`, {
          method: 'DELETE',
          signal: context.signal,
        });
      } else {
        data = await api(`/api/styles/${encodeURIComponent(context.styleId)}/references`, {
          method: 'DELETE',
          signal: context.signal,
          body: JSON.stringify({ type, fileName: item.fileName }),
        });
      }
      if (!this.isCurrent(context)) return;
      generationStore.set({ styleReferences: data.references || { characters: [], world: [] }, styleReferencesStyleId: context.styleId });
      this.renderStyleReferences?.(this.state.domEls, this.state.setStatus);
      this.renderActiveList();
      this.state.setStatus?.(`Removed from active ${type}.`);
    } catch (error) {
      if (this.isCurrent(context)) this.state.setStatus?.(`Failed to remove image: ${error.message}`);
    }
  }

  async selectLibraryImage(path, fileName, context = this.context()) {
    if (context.mode === 'screenplay-cover') {
      await this.applyScreenplayCover(path, fileName, context);
      return;
    }
    if (context.mode === 'character-reference' || context.mode === 'world-reference') {
      if (!path.startsWith('/style-references/') && !path.startsWith('/user-style-references/')) {
        await this.addImageToActive(path, fileName, context);
        return;
      }
      const type = context.mode === 'character-reference' ? 'characters' : 'world';
      try {
        this.state.setStatus?.(`Activating ${type} reference...`);
        const data = await api(`/api/styles/${encodeURIComponent(context.styleId)}/references/activate`, {
          method: 'POST',
          signal: context.signal,
          body: JSON.stringify({ type, fileName }),
        });
        if (!this.isCurrent(context)) return;
        generationStore.set({ styleReferences: data.references || { characters: [], world: [] }, styleReferencesStyleId: context.styleId });
        this.renderStyleReferences?.(this.state.domEls, this.state.setStatus);
        this.renderActiveList();
        this.state.setStatus?.(`Activated ${type} reference.`);
      } catch (error) {
        if (this.isCurrent(context)) this.state.setStatus?.(`Failed to activate: ${error.message}`);
      }
      return;
    }

    if (context.mode !== 'scene-image') return;
    try {
      this.state.setStatus?.('Attaching image version to scene...');
      const file = await this.assetFile(path, fileName || 'scene-image.png', context);
      if (!file) return;
      const form = new FormData();
      form.append('file', file);
      const data = await api(`/api/projects/${encodeURIComponent(context.projectId)}/scenes/${encodeURIComponent(context.sceneId)}/images/upload`, {
        method: 'POST',
        signal: context.signal,
        body: form,
      });
      if (!this.isCurrent(context)) return;
      const responseScene = adaptSceneImageShot(data.scene);
      const scenes = sceneStore.get().scenes.map((scene) => scene.id === responseScene.id ? responseScene : scene);
      sceneStore.set({ scenes });
      const record = getCurrentStoryboardRecord();
      if (record) {
        record.scenes = scenes;
        record.revision = data.revision;
        queueSync(record);
      }
      this.renderActiveList();
      this.state.setStatus?.('Scene image updated.');
    } catch (error) {
      if (this.isCurrent(context)) this.state.setStatus?.(`Failed to set scene image: ${error.message}`);
    }
  }

  async applyScreenplayCover(path, fileName, context = this.context()) {
    if (!context.scriptId) {
      this.state.setStatus?.('Save the screenplay before setting cover art.');
      return;
    }
    try {
      this.state.setStatus?.('Setting cover art...');
      const file = await this.assetFile(path, fileName || 'cover.png', context);
      if (!file) return;
      const form = new FormData();
      form.append('file', file);
      const data = await api(`/api/scripts/${encodeURIComponent(context.scriptId)}/cover`, {
        method: 'POST',
        signal: context.signal,
        body: form,
      });
      if (!this.isCurrent(context)) return;
      this.state.coverUrl = data.script?.coverUrl || null;
      this.state.onCoverApplied?.(data.script);
      this.renderActiveList();
      this.state.setStatus?.('Cover art updated.');
    } catch (error) {
      if (this.isCurrent(context)) this.state.setStatus?.(`Failed to set cover art: ${error.message}`);
    }
  }

  selectSceneVersion(versionIndex) {
    const context = this.context();
    if (!this.isCurrent(context)) return;
    const scenes = sceneStore.get().scenes.map((scene) => {
      if (scene.id !== context.sceneId) return scene;
      const next = adaptSceneImageShot({ ...scene, shots: (scene.shots || []).map((shot) => ({ ...shot })) });
      setActiveImageVersion(next, versionIndex);
      next.activeVisualType = 'image';
      return next;
    });
    sceneStore.set({ scenes });
    const record = getCurrentStoryboardRecord();
    if (record) {
      record.scenes = scenes;
      queueSync(record);
    }
    this.renderActiveList();
  }
}

const imageLibraryController = new ImageLibraryController();

export function initImageLibraryModal(domEls, setStatus, dependencies) {
  imageLibraryController.init(domEls, setStatus, dependencies);
}

export function openImageLibrary(options) {
  return imageLibraryController.open(options);
}

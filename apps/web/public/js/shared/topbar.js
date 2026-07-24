(function registerStoryboarderTopbar() {
  const PAGE_TABS = [
    { id: 'tabScriptBtn', page: 'script', label: 'Screenplay', panel: 'scriptPagePanel' },
    { id: 'tabStoryboardBtn', page: 'storyboard', label: 'Storyboard', panel: 'storyboardPagePanel' },
    { id: 'tabStyleBtn', page: 'style', label: 'Style', panel: 'stylePagePanel' },
    { id: 'tabTimelineBtn', page: 'timeline', label: 'Timeline', panel: 'timelinePagePanel' },
  ];

  const BRAND_MARK = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"></rect><path d="M9 4v16M3 10h6M3 15h6"></path></svg>';

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'className') node.className = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key === 'hidden') node.hidden = value === true;
      else if (key === 'html') node.innerHTML = value;
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      node.append(child);
    }
    return node;
  }

  function currentPath() {
    return window.location.pathname.replace(/\.html$/, '') || '/';
  }

  function resolveActiveStudioPage(path) {
    if (path !== '/studio') return null;
    const requested = new URLSearchParams(window.location.search).get('page');
    if (PAGE_TABS.some((tab) => tab.page === requested)) return requested;
    try {
      const saved = localStorage.getItem('storyboarder.activeStudioPage');
      if (PAGE_TABS.some((tab) => tab.page === saved)) return saved;
    } catch (_) {}
    return 'storyboard';
  }

  class StoryboarderTopbar extends HTMLElement {
    connectedCallback() {
      if (this.dataset.ready === 'true') return;
      this.dataset.ready = 'true';
      this.replaceChildren(this.build());
      // Exposed so pages that need the session payload itself (not just the rendered topbar,
      // e.g. studio needs session.tenant.id) can await this instead of fetching /api/auth/session
      // a second time and re-implementing this same render/logout logic.
      this.sessionReady = this.loadSession();
    }

    build() {
      const path = currentPath();
      const activePage = resolveActiveStudioPage(path);
      return el('header', { className: 'sf-topbar' },
        el('div', { className: 'sf-topbar-inner' },
          el('a', { className: 'sf-brand', href: '/scripts', 'aria-label': 'Storyboarder home' },
            el('span', { className: 'sf-brand-mark', 'aria-hidden': 'true', html: BRAND_MARK }),
            el('span', {}, 'Storyboarder'),
          ),
          el('nav', { className: 'sf-nav', 'aria-label': 'Primary navigation' },
            this.buildPageTabs(activePage),
            el('a', { id: 'downloadZipBtn', className: 'sf-nav-link', href: '/studio?download=1' }, 'Download'),
            el('a', {
              id: 'adminConsoleLink',
              className: 'sf-nav-link sf-admin-link',
              href: '/admin',
              'aria-current': path === '/admin' ? 'page' : null,
              hidden: true,
            }, 'Admin'),
          ),
          el('div', { id: 'authLoggedOut', className: 'sf-account', hidden: true },
            el('a', { className: 'sf-auth-link', href: '/login.html?redirect=%2Fstudio' }, 'Sign in'),
            el('a', { className: 'sf-auth-link primary', href: '/login.html?mode=register&redirect=%2Fstudio' }, 'Create account'),
          ),
          el('div', { id: 'authLoggedIn', className: 'sf-account', hidden: true },
            el('a', { id: 'topbarCredits', className: 'sf-credits', href: '/credits', title: 'Available credits', hidden: true },
              el('span', { className: 'sf-credits-label' }, 'Credits'),
              el('strong', { id: 'topbarCreditsValue' }, '—'),
            ),
            el('div', { className: 'sf-user', title: 'Signed-in account' },
              el('span', { id: 'authUserAvatar', className: 'sf-avatar', 'aria-hidden': 'true' }),
              el('span', { id: 'authUserLabel', className: 'sf-user-label' }),
            ),
            el('button', { id: 'logoutBtn', className: 'sf-logout', type: 'button' }, 'Log out'),
          ),
        ),
      );
    }

    buildPageTabs(activePage) {
      const inStudio = activePage != null;
      return el('div', {
        className: 'page-tabs',
        role: inStudio ? 'tablist' : null,
        'aria-label': inStudio ? 'Studio pages' : null,
      },
        el('a', { className: 'page-tab', href: '/' }, 'Home'),
        ...PAGE_TABS.map((tab) => {
          const isActive = tab.page === activePage;
          return el('a', {
            id: tab.id,
            className: isActive ? 'page-tab is-active' : 'page-tab',
            href: `/studio?page=${tab.page}`,
            dataset: { page: tab.page },
            role: inStudio ? 'tab' : null,
            'aria-controls': inStudio ? tab.panel : null,
            'aria-selected': inStudio ? String(isActive) : null,
            tabindex: inStudio ? (isActive ? '0' : '-1') : null,
          }, tab.label);
        }),
      );
    }

    async loadSession() {
      try {
        const response = await fetch('/api/auth/session');
        const data = await response.json();
        if (response.ok && data.authenticated) this.showSession(data.session);
        else this.querySelector('#authLoggedOut').hidden = false;
        return data;
      } catch (_) {
        this.querySelector('#authLoggedOut').hidden = false;
        return { authenticated: false };
      }
    }

    showSession(session) {
      const name = session.user.displayName || session.user.email || '';
      const loggedOut = this.querySelector('#authLoggedOut');
      const loggedIn = this.querySelector('#authLoggedIn');
      const avatar = this.querySelector('#authUserAvatar');
      const label = this.querySelector('#authUserLabel');
      const admin = this.querySelector('#adminConsoleLink');
      loggedOut.hidden = true;
      loggedIn.hidden = false;
      avatar.textContent = name.trim().slice(0, 1).toUpperCase() || '?';
      label.textContent = name;
      label.title = `${session.user.email}\n${session.tenant.name}`;
      admin.hidden = !(session.isPlatformAdmin || ['admin', 'super_admin'].includes(session.user.platformRole));
      this.querySelector('#logoutBtn').addEventListener('click', () => this.logout(), { once: true });
      this.bindCredits();
    }

    async bindCredits() {
      const link = this.querySelector('#topbarCredits');
      const value = this.querySelector('#topbarCreditsValue');
      link.hidden = false;
      const { formatCredits, refreshCreditBalance } = await import('../billing/credit-balance.js');
      const { creditStore } = await import('../core/store.js');
      const render = (state) => { value.textContent = state.error ? '—' : formatCredits(state.availableCreditMicros); };
      creditStore.subscribe(render);
      render(creditStore.get());
      await refreshCreditBalance();
    }

    async logout() {
      const button = this.querySelector('#logoutBtn');
      button.disabled = true;
      try { await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); }
      finally {
        ['storyboard-poc-storyboards', 'storyboard-poc-current', 'storyboard-poc-draft', 'storyboard-auth-token'].forEach((key) => localStorage.removeItem(key));
        Object.keys(localStorage).filter((key) => key.startsWith('storyboard-poc-storyboards:')).forEach((key) => localStorage.removeItem(key));
        window.location.href = '/login.html';
      }
    }
  }

  if (!customElements.get('storyboarder-topbar')) customElements.define('storyboarder-topbar', StoryboarderTopbar);
})();

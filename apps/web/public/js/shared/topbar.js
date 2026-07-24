(function registerStoryboarderTopbar() {
  // ── Edit links & labels here ──────────────────────────────────────────────
  const TOPBAR = {
    brand: {
      href: '/scripts',
      label: 'Storyboarder',
      ariaLabel: 'Storyboarder home',
      mark: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"></rect><path d="M9 4v16M3 10h6M3 15h6"></path></svg>',
    },
    home: { href: '/', label: 'Home' },
    studioTabs: [
      { id: 'tabScriptBtn', page: 'script', href: '/studio?page=script', label: 'Screenplay', panel: 'scriptPagePanel' },
      { id: 'tabStoryboardBtn', page: 'storyboard', href: '/studio?page=storyboard', label: 'Storyboard', panel: 'storyboardPagePanel' },
      { id: 'tabTimelineBtn', page: 'timeline', href: '/studio?page=timeline', label: 'Timeline', panel: 'timelinePagePanel' },
    ],
    defaultStudioPage: 'storyboard',
    studioPath: '/studio',
    download: { id: 'downloadZipBtn', href: '/studio?download=1', label: 'Download' },
    admin: { id: 'adminConsoleLink', href: '/admin', label: 'Admin' },
    signIn: { href: '/login.html?redirect=%2Fstudio', label: 'Sign in' },
    register: { href: '/login.html?mode=register&redirect=%2Fstudio', label: 'Create account' },
    credits: { id: 'topbarCredits', href: '/credits', label: 'Credits', title: 'Available credits' },
    logout: { id: 'logoutBtn', label: 'Log out', redirect: '/login.html' },
  };
  // ─────────────────────────────────────────────────────────────────────────

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
    if (path !== TOPBAR.studioPath) return null;
    const requested = new URLSearchParams(window.location.search).get('page');
    if (TOPBAR.studioTabs.some((tab) => tab.page === requested)) return requested;
    try {
      const saved = localStorage.getItem('storyboarder.activeStudioPage');
      if (TOPBAR.studioTabs.some((tab) => tab.page === saved)) return saved;
    } catch (_) {}
    return TOPBAR.defaultStudioPage;
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
      const { brand, download, admin, signIn, register, credits, logout } = TOPBAR;
      return el('header', { className: 'sf-topbar' },
        el('div', { className: 'sf-topbar-inner' },
          el('a', { className: 'sf-brand', href: brand.href, 'aria-label': brand.ariaLabel },
            el('span', { className: 'sf-brand-mark', 'aria-hidden': 'true', html: brand.mark }),
            el('span', {}, brand.label),
          ),
          el('nav', { className: 'sf-nav', 'aria-label': 'Primary navigation' },
            this.buildPageTabs(activePage),
            el('a', { id: download.id, className: 'sf-nav-link', href: download.href }, download.label),
            el('a', {
              id: admin.id,
              className: 'sf-nav-link sf-admin-link',
              href: admin.href,
              'aria-current': path === admin.href ? 'page' : null,
              hidden: true,
            }, admin.label),
          ),
          el('div', { id: 'authLoggedOut', className: 'sf-account', hidden: true },
            el('a', { className: 'sf-auth-link', href: signIn.href }, signIn.label),
            el('a', { className: 'sf-auth-link primary', href: register.href }, register.label),
          ),
          el('div', { id: 'authLoggedIn', className: 'sf-account', hidden: true },
            el('a', { id: credits.id, className: 'sf-credits', href: credits.href, title: credits.title, hidden: true },
              el('span', { className: 'sf-credits-label' }, credits.label),
              el('strong', { id: 'topbarCreditsValue' }, '—'),
            ),
            el('div', { className: 'sf-user', title: 'Signed-in account' },
              el('span', { id: 'authUserAvatar', className: 'sf-avatar', 'aria-hidden': 'true' }),
              el('span', { id: 'authUserLabel', className: 'sf-user-label' }),
            ),
            el('button', { id: logout.id, className: 'sf-logout', type: 'button' }, logout.label),
          ),
        ),
      );
    }

    buildPageTabs(activePage) {
      const inStudio = activePage != null;
      const { home, studioTabs } = TOPBAR;
      return el('div', {
        className: 'page-tabs',
        role: inStudio ? 'tablist' : null,
        'aria-label': inStudio ? 'Studio pages' : null,
      },
        el('a', { className: 'page-tab', href: home.href }, home.label),
        ...studioTabs.map((tab) => {
          const isActive = tab.page === activePage;
          return el('a', {
            id: tab.id,
            className: isActive ? 'page-tab is-active' : 'page-tab',
            href: tab.href,
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
      const admin = this.querySelector(`#${TOPBAR.admin.id}`);
      loggedOut.hidden = true;
      loggedIn.hidden = false;
      avatar.textContent = name.trim().slice(0, 1).toUpperCase() || '?';
      label.textContent = name;
      label.title = `${session.user.email}\n${session.tenant.name}`;
      admin.hidden = !(session.isPlatformAdmin || ['admin', 'super_admin'].includes(session.user.platformRole));
      this.querySelector(`#${TOPBAR.logout.id}`).addEventListener('click', () => this.logout(), { once: true });
      this.bindCredits();
    }

    async bindCredits() {
      const link = this.querySelector(`#${TOPBAR.credits.id}`);
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
      const button = this.querySelector(`#${TOPBAR.logout.id}`);
      button.disabled = true;
      try { await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); }
      finally {
        ['storyboard-poc-storyboards', 'storyboard-poc-current', 'storyboard-poc-draft', 'storyboard-auth-token'].forEach((key) => localStorage.removeItem(key));
        Object.keys(localStorage).filter((key) => key.startsWith('storyboard-poc-storyboards:')).forEach((key) => localStorage.removeItem(key));
        window.location.href = TOPBAR.logout.redirect;
      }
    }
  }

  if (!customElements.get('storyboarder-topbar')) customElements.define('storyboarder-topbar', StoryboarderTopbar);
})();

(function registerStoryboarderTopbar() {
  class StoryboarderTopbar extends HTMLElement {
    connectedCallback() {
      if (this.dataset.ready === 'true') return;
      this.dataset.ready = 'true';
      const path = window.location.pathname.replace(/\.html$/, '') || '/';
      const current = (target) => path === target ? ' aria-current="page"' : '';
      const requestedStudioPage = new URLSearchParams(window.location.search).get('page');
      const studioPages = ['script', 'storyboard', 'timeline'];
      let activeStudioPage = studioPages.includes(requestedStudioPage)
        ? requestedStudioPage
        : 'storyboard';
      if (path === '/studio' && !requestedStudioPage) {
        try {
          const savedPage = localStorage.getItem('storyboarder.activeStudioPage');
          if (studioPages.includes(savedPage)) activeStudioPage = savedPage;
        } catch (_) {}
      }
      const pageTabsRole = path === '/studio' ? ' role="tablist" aria-label="Studio pages"' : '';
      const studioTabState = (page, panel) => {
        if (path !== '/studio') return ' class="page-tab"';
        const isActive = page === activeStudioPage;
        return ` class="page-tab${isActive ? ' is-active' : ''}" role="tab" aria-controls="${panel}" aria-selected="${isActive}" tabindex="${isActive ? '0' : '-1'}"`;
      };
      this.innerHTML = `
        <header class="sf-topbar">
          <div class="sf-topbar-inner">
            <a class="sf-brand" href="/scripts" aria-label="Storyboarder home">
              <span class="sf-brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"></rect><path d="M9 4v16M3 10h6M3 15h6"></path></svg></span>
              <span>Storyboarder</span>
            </a>
            <nav class="sf-nav" aria-label="Primary navigation">
              <div class="page-tabs"${pageTabsRole}>
                <a id="tabScriptBtn"${studioTabState('script', 'scriptPagePanel')} data-page="script"
                  href="/studio?page=script">Script</a>
                <a id="tabStoryboardBtn"${studioTabState('storyboard', 'storyboardPagePanel')} data-page="storyboard"
                  href="/studio?page=storyboard">Storyboard</a>
                <a id="tabTimelineBtn"${studioTabState('timeline', 'timelinePagePanel')} data-page="timeline"
                  href="/studio?page=timeline">Timeline</a>
              </div>
              <a id="downloadZipBtn" class="sf-nav-link" href="/studio?download=1">Download</a>
              <a id="adminConsoleLink" class="sf-nav-link sf-admin-link" href="/admin"${current('/admin')} hidden>Admin</a>
            </nav>
            <div id="authLoggedOut" class="sf-account" hidden>
              <a class="sf-auth-link" href="/login.html?redirect=%2Fstudio">Sign in</a>
              <a class="sf-auth-link primary" href="/login.html?mode=register&amp;redirect=%2Fstudio">Create account</a>
            </div>
            <div id="authLoggedIn" class="sf-account" hidden>
              <a id="topbarCredits" class="sf-credits" href="/credits" title="Available credits" hidden>
                <span class="sf-credits-label">Credits</span>
                <strong id="topbarCreditsValue">—</strong>
              </a>
              <div class="sf-user" title="Signed-in account">
                <span id="authUserAvatar" class="sf-avatar" aria-hidden="true"></span>
                <span id="authUserLabel" class="sf-user-label"></span>
              </div>
              <button id="logoutBtn" class="sf-logout" type="button">Log out</button>
            </div>
          </div>
        </header>`;
      // Exposed so pages that need the session payload itself (not just the rendered topbar,
      // e.g. studio needs session.tenant.id) can await this instead of fetching /api/auth/session
      // a second time and re-implementing this same render/logout logic.
      this.sessionReady = this.loadSession();
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

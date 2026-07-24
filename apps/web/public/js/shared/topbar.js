(function enhanceTopbar() {
  const root = document.querySelector('.sf-topbar');
  if (!root) return;

  const path = window.location.pathname.replace(/\.html$/, '') || '/';
  const studioMatch = path.match(/^\/(script|storyboard|timeline)(?:\/[^/]+)?$/);
  const adminLink = document.getElementById('adminConsoleLink');
  if (adminLink && path === '/admin') adminLink.setAttribute('aria-current', 'page');

  if (studioMatch) {
    const page = studioMatch[1];
    const tabs = Array.from(document.querySelectorAll('.page-tab[data-page]'));
    const list = document.querySelector('.page-tabs');
    list.setAttribute('role', 'tablist');
    list.setAttribute('aria-label', 'Studio pages');
    for (const tab of tabs) {
      const active = tab.dataset.page === page;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', tab.dataset.panel);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    }
  }

  // Pages that need the session (e.g. studio) await root.sessionReady instead of
  // re-fetching /api/auth/session and re-implementing auth UI.
  root.sessionReady = loadSession();

  async function loadSession() {
    try {
      const response = await fetch('/api/auth/session');
      const data = await response.json();
      if (response.ok && data.authenticated) showSession(data.session);
      else document.getElementById('authLoggedOut').hidden = false;
      return data;
    } catch (_) {
      document.getElementById('authLoggedOut').hidden = false;
      return { authenticated: false };
    }
  }

  function showSession(session) {
    const name = session.user.displayName || session.user.email || '';
    document.getElementById('authLoggedOut').hidden = true;
    document.getElementById('authLoggedIn').hidden = false;
    document.getElementById('authUserAvatar').textContent = name.trim().slice(0, 1).toUpperCase() || '?';
    const label = document.getElementById('authUserLabel');
    label.textContent = name;
    label.title = `${session.user.email}\n${session.tenant.name}`;
    adminLink.hidden = !(session.isPlatformAdmin || ['admin', 'super_admin'].includes(session.user.platformRole));
    document.getElementById('logoutBtn').addEventListener('click', logout, { once: true });
    bindCredits();
  }

  async function bindCredits() {
    const link = document.getElementById('topbarCredits');
    const value = document.getElementById('topbarCreditsValue');
    link.hidden = false;
    const { formatCredits, refreshCreditBalance } = await import('../billing/credit-balance.js');
    const { creditStore } = await import('../core/store.js');
    const render = (state) => { value.textContent = state.error ? '—' : formatCredits(state.availableCreditMicros); };
    creditStore.subscribe(render);
    render(creditStore.get());
    await refreshCreditBalance();
  }

  async function logout() {
    document.getElementById('logoutBtn').disabled = true;
    try { await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); }
    finally {
      ['storyboard-poc-storyboards', 'storyboard-poc-current', 'storyboard-poc-draft', 'storyboard-auth-token'].forEach((key) => localStorage.removeItem(key));
      Object.keys(localStorage).filter((key) => key.startsWith('storyboard-poc-storyboards:')).forEach((key) => localStorage.removeItem(key));
      window.location.href = '/login.html';
    }
  }
})();

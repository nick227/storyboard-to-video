(function enhanceTopbar() {
  const root = document.querySelector('.sf-topbar');
  if (!root) return;

  const path = window.location.pathname.replace(/\.html$/, '') || '/';
  const libraryLink = root.querySelector('[data-nav="library"]');
  if (libraryLink && (path === '/library' || path.startsWith('/library/'))) {
    libraryLink.setAttribute('aria-current', 'page');
  }
  const adminLink = document.getElementById('adminConsoleLink');
  if (adminLink && path === '/admin') adminLink.setAttribute('aria-current', 'page');

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

})();

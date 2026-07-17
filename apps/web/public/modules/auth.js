const LOCAL_PROJECT_KEYS = ['storyboard-poc-storyboards', 'storyboard-poc-current', 'storyboard-poc-draft', 'storyboard-auth-token'];

async function request(path, body) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message || 'Authentication request failed');
    error.code = data.error?.code;
    throw error;
  }
  return data;
}

function redirectToLogin() {
  const redirect = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.href = `/login.html?redirect=${redirect}`;
}

function clearLocalProjectState() {
  LOCAL_PROJECT_KEYS.forEach((key) => localStorage.removeItem(key));
  Object.keys(localStorage).filter((key) => key.startsWith('storyboard-poc-storyboards:')).forEach((key) => localStorage.removeItem(key));
}

function showLoggedIn(els, session) {
  const name = session.user.displayName || session.user.email || '';
  els.authUserLabel.textContent = name;
  els.authUserLabel.title = `${session.user.email}\n${session.tenant.name}`;
  els.authUserAvatar.textContent = name.trim().slice(0, 1).toUpperCase() || '?';
  els.authLoggedIn.hidden = false;
  if (els.adminConsoleLink) {
    els.adminConsoleLink.hidden = !(session.isPlatformAdmin || ['admin', 'super_admin'].includes(session.user.platformRole));
  }
}

// The server-side page guard keeps unauthenticated visitors off this page
// entirely, so this module only ever needs to render the logged-in state and
// react if a session expires mid-visit (via the storyboard:unauthenticated event).
export async function initializeAuth(els) {
  els.logoutBtn.addEventListener('click', async () => {
    els.logoutBtn.disabled = true;
    try {
      await request('/api/auth/logout', {});
    } finally {
      clearLocalProjectState();
      window.location.href = '/login.html';
    }
  });
  window.addEventListener('storyboard:unauthenticated', redirectToLogin);

  const data = await request('/api/auth/session');
  if (data.authenticated) {
    showLoggedIn(els, data.session);
    return data.session;
  }
  redirectToLogin();
  return null;
}

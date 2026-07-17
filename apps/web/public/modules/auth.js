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

function setMode(els, mode) {
  const registering = mode === 'register';
  els.authDialogTitle.textContent = registering ? 'Create your account' : 'Welcome back';
  els.authDisplayNameField.hidden = !registering;
  els.authDisplayName.required = registering;
  els.authSubmitBtn.textContent = registering ? 'Create account' : 'Log in';
  els.authToggleMode.textContent = registering ? 'Already have an account? Log in' : 'New here? Create an account';
  els.authForm.dataset.mode = mode;
  els.authError.textContent = '';
}

function showLoggedIn(els, session) {
  els.authLoggedOut.hidden = true;
  els.authLoggedIn.hidden = false;
  els.authUserLabel.textContent = session.user.displayName || session.user.email;
  els.authUserLabel.title = `${session.user.email}\n${session.tenant.name}`;
}

export async function initializeAuth(els) {
  const open = (mode = 'login') => { setMode(els, mode); if (!els.authDialog.open) els.authDialog.showModal(); };
  els.loginBtn.addEventListener('click', () => open('login'));
  els.registerBtn.addEventListener('click', () => open('register'));
  els.authDialogClose.addEventListener('click', () => els.authDialog.close());
  els.authToggleMode.addEventListener('click', () => setMode(els, els.authForm.dataset.mode === 'register' ? 'login' : 'register'));
  window.addEventListener('storyboard:unauthenticated', () => open('login'));
  els.authForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const mode = els.authForm.dataset.mode || 'login';
    els.authSubmitBtn.disabled = true;
    els.authError.textContent = '';
    try {
      await request(`/api/auth/${mode}`, {
        email: els.authEmail.value,
        password: els.authPassword.value,
        ...(mode === 'register' ? { displayName: els.authDisplayName.value } : {}),
      });
      window.location.reload();
    } catch (error) {
      els.authError.textContent = error.message;
    } finally { els.authSubmitBtn.disabled = false; }
  });
  els.logoutBtn.addEventListener('click', async () => {
    await request('/api/auth/logout', {});
    LOCAL_PROJECT_KEYS.forEach((key) => localStorage.removeItem(key));
    Object.keys(localStorage).filter((key) => key.startsWith('storyboard-poc-storyboards:')).forEach((key) => localStorage.removeItem(key));
    window.location.reload();
  });

  const data = await request('/api/auth/session');
  if (data.authenticated) {
    showLoggedIn(els, data.session);
    return data.session;
  }
  els.authLoggedOut.hidden = false;
  els.authLoggedIn.hidden = true;
  open('login');
  return null;
}

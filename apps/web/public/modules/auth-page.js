const els = {
  authTabLogin: document.getElementById('authTabLogin'),
  authTabRegister: document.getElementById('authTabRegister'),
  authCardTitle: document.getElementById('authCardTitle'),
  authCardSubtitle: document.getElementById('authCardSubtitle'),
  authDisplayNameField: document.getElementById('authDisplayNameField'),
  authDisplayName: document.getElementById('authDisplayName'),
  authEmail: document.getElementById('authEmail'),
  authPassword: document.getElementById('authPassword'),
  authError: document.getElementById('authError'),
  authForm: document.getElementById('authForm'),
  authSubmitBtn: document.getElementById('authSubmitBtn'),
  authFooterPrompt: document.getElementById('authFooterPrompt'),
  authFooterToggle: document.getElementById('authFooterToggle'),
};

function safeRedirectTarget() {
  const raw = new URLSearchParams(window.location.search).get('redirect');
  return raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/studio';
}

function setMode(mode) {
  const registering = mode === 'register';
  els.authForm.dataset.mode = mode;
  els.authTabLogin.classList.toggle('is-active', !registering);
  els.authTabLogin.setAttribute('aria-selected', String(!registering));
  els.authTabRegister.classList.toggle('is-active', registering);
  els.authTabRegister.setAttribute('aria-selected', String(registering));

  els.authCardTitle.textContent = registering ? 'Create your account' : 'Welcome back';
  els.authCardSubtitle.textContent = registering
    ? 'Start a new workspace for your storyboards.'
    : 'Log in to open your storyboards.';
  els.authDisplayNameField.hidden = !registering;
  els.authDisplayName.required = registering;
  els.authPassword.autocomplete = registering ? 'new-password' : 'current-password';
  els.authSubmitBtn.textContent = registering ? 'Create account' : 'Log in';
  els.authFooterPrompt.textContent = registering ? 'Already have an account?' : 'New here?';
  els.authFooterToggle.textContent = registering ? 'Log in' : 'Create an account';
  els.authError.textContent = '';
}

async function submit(event) {
  event.preventDefault();
  const mode = els.authForm.dataset.mode || 'login';
  els.authSubmitBtn.disabled = true;
  els.authError.textContent = '';
  try {
    const response = await fetch(`/api/auth/${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: els.authEmail.value,
        password: els.authPassword.value,
        ...(mode === 'register' ? { displayName: els.authDisplayName.value } : {}),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || 'Authentication request failed');
    window.location.href = safeRedirectTarget();
  } catch (error) {
    els.authError.textContent = error.message;
    els.authSubmitBtn.disabled = false;
  }
}

els.authTabLogin.addEventListener('click', () => setMode('login'));
els.authTabRegister.addEventListener('click', () => setMode('register'));
els.authFooterToggle.addEventListener('click', (event) => {
  event.preventDefault();
  setMode(els.authForm.dataset.mode === 'register' ? 'login' : 'register');
});
els.authForm.addEventListener('submit', submit);

const initialMode = new URLSearchParams(window.location.search).get('mode') === 'register' ? 'register' : 'login';
setMode(initialMode);

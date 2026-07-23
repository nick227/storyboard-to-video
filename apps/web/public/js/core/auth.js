function redirectToLogin() {
  const redirect = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.href = `/login.html?redirect=${redirect}`;
}

// The shared <storyboarder-topbar> element is the single place session state is fetched
// and rendered (including the logout button) -- this just awaits its result rather than
// re-fetching /api/auth/session and re-implementing that rendering here. The server-side
// page guard keeps unauthenticated visitors off this page entirely, so `authenticated`
// is only ever false here if a session expires mid-visit before this resolves; the
// storyboard:unauthenticated event covers the same case once the app is already running.
export async function initializeAuth() {
  window.addEventListener('storyboard:unauthenticated', redirectToLogin);
  const { authenticated, session } = await document.querySelector('storyboarder-topbar').sessionReady;
  if (!authenticated) {
    redirectToLogin();
    return null;
  }
  return session;
}

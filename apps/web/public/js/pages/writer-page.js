import { fetchWriter, toggleFollowWriter } from '../scripts/api.js';
import {
  flashStatus, loginRedirect, renderBreadcrumbs, scriptCoverCard,
} from '../scripts/chrome.js';

const slug = decodeURIComponent(window.location.pathname.replace(/^\/writers\//, '').replace(/\/$/, ''));
const status = document.getElementById('writerStatus');
const profile = document.getElementById('writerProfile');
const followBtn = document.getElementById('writerFollowBtn');
const followStatus = document.getElementById('writerFollowStatus');

try {
  const writer = await fetchWriter(slug);
  document.title = `${writer.displayName || 'Writer'} — Storyboarder`;
  document.getElementById('scriptsBreadcrumbs').innerHTML = renderBreadcrumbs([
    { label: 'Library', href: '/scripts' },
    { label: writer.displayName || 'Writer' },
  ]);
  document.getElementById('writerName').textContent = writer.displayName || 'Writer';
  document.getElementById('writerBio').textContent = writer.bio || 'Screenplays on Storyboarder.';
  document.getElementById('writerFollowers').textContent = `${writer.followerCount || 0} follower${writer.followerCount === 1 ? '' : 's'}`;
  document.getElementById('writerGrid').innerHTML = (writer.scripts || []).map((script) => scriptCoverCard(script)).join('')
    || '<p class="scripts-status">No public screenplays yet.</p>';

  followBtn.hidden = false;
  followBtn.textContent = writer.followedByMe ? 'Following' : 'Follow';
  followBtn.setAttribute('aria-pressed', String(Boolean(writer.followedByMe)));
  followBtn.addEventListener('click', async () => {
    try {
      const result = await toggleFollowWriter(writer.id);
      followBtn.textContent = result.following ? 'Following' : 'Follow';
      followBtn.setAttribute('aria-pressed', String(result.following));
      document.getElementById('writerFollowers').textContent = `${result.followerCount || 0} follower${result.followerCount === 1 ? '' : 's'}`;
      flashStatus(followStatus, result.following ? 'Following' : 'Unfollowed');
    } catch (error) {
      if (error.status === 401 || error.code === 'UNAUTHENTICATED') return loginRedirect();
      flashStatus(followStatus, error.message || 'Could not update follow');
    }
  });

  status.hidden = true;
  profile.hidden = false;
} catch (error) {
  status.dataset.tone = 'error';
  status.textContent = error.status === 404 ? 'Writer not found.' : (error.message || 'Failed to load writer.');
}

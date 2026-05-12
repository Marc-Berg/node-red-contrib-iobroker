import { writeFile } from 'node:fs/promises';

const owner = process.env.GITHUB_REPOSITORY_OWNER;
const repo = process.env.GITHUB_REPOSITORY?.split('/')[1];
const token = process.env.GITHUB_TOKEN;

function getBaseVersion(tagName) {
  return String(tagName || '').replace(/[-+].*$/, '');
}

if (!owner || !repo) {
  throw new Error('Missing repository context');
}

const apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`;

const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'beta-badge-updater'
};

if (token) {
  headers.Authorization = `Bearer ${token}`;
}

const response = await fetch(apiUrl, {
  headers
});

if (!response.ok) {
  throw new Error(`GitHub API request failed: ${response.status} ${response.statusText}`);
}

const releases = await response.json();

const latestRelevantPrerelease = releases.find((release) => {
  if (!release || release.prerelease !== true) {
    return false;
  }

  const prereleaseBaseVersion = getBaseVersion(release.tag_name);

  return !releases.some((candidate) => (
    candidate &&
    candidate.prerelease === false &&
    candidate.draft === false &&
    getBaseVersion(candidate.tag_name) === prereleaseBaseVersion
  ));
});

const message = latestRelevantPrerelease?.tag_name || '-';

const badge = {
  schemaVersion: 1,
  label: 'beta',
  message,
  color: 'yellow'
};

await writeFile('.github/badges/beta.json', `${JSON.stringify(badge)}\n`, 'utf8');
console.log(`beta badge message: ${message}`);

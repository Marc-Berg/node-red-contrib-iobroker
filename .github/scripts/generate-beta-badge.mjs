import { readFile, writeFile } from 'node:fs/promises';

const owner = process.env.GITHUB_REPOSITORY_OWNER;
const repo = process.env.GITHUB_REPOSITORY?.split('/')[1];
const token = process.env.GITHUB_TOKEN;

function getBaseVersion(tagName) {
  return String(tagName || '').replace(/[-+].*$/, '');
}

function compareBaseVersions(a, b) {
  const left = getBaseVersion(a).replace(/^v/, '').split('.').map(Number);
  const right = getBaseVersion(b).replace(/^v/, '').split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
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

const { name: packageName } = JSON.parse(await readFile('package.json', 'utf8'));
const npmResponse = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`);

if (!npmResponse.ok) {
  throw new Error(`npm registry request failed: ${npmResponse.status} ${npmResponse.statusText}`);
}

const { version: npmLatestVersion } = await npmResponse.json();

const latestStableVersion = [
  npmLatestVersion,
  ...releases
    .filter((release) => release && release.prerelease === false && release.draft === false)
    .map((release) => release.tag_name)
].reduce((latest, candidate) => (compareBaseVersions(candidate, latest) > 0 ? candidate : latest));

const latestRelevantPrerelease = releases.find((release) => (
  release &&
  release.prerelease === true &&
  compareBaseVersions(release.tag_name, latestStableVersion) > 0
));

const message = latestRelevantPrerelease?.tag_name || '-';

const badge = {
  schemaVersion: 1,
  label: 'beta',
  message,
  color: 'yellow'
};

await writeFile('.github/badges/beta.json', `${JSON.stringify(badge)}\n`, 'utf8');
console.log(`beta badge message: ${message}`);

import { writeFile } from 'node:fs/promises';

const owner = process.env.GITHUB_REPOSITORY_OWNER;
const repo = process.env.GITHUB_REPOSITORY?.split('/')[1];
const token = process.env.GITHUB_TOKEN;

if (!owner || !repo) {
  throw new Error('Missing repository context');
}

const apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`;

const response = await fetch(apiUrl, {
  headers: {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'beta-badge-updater'
  }
});

if (!response.ok) {
  throw new Error(`GitHub API request failed: ${response.status} ${response.statusText}`);
}

const releases = await response.json();

const latestPrerelease = releases.find((release) => release && release.prerelease === true);
const message = latestPrerelease?.tag_name || '-';

const badge = {
  schemaVersion: 1,
  label: 'beta',
  message,
  color: 'yellow'
};

await writeFile('.github/badges/beta.json', `${JSON.stringify(badge)}\n`, 'utf8');
console.log(`beta badge message: ${message}`);

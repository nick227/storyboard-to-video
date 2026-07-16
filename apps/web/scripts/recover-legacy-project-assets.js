const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../src/config/env');
const { ProjectStore } = require('../src/storage/project-store');
const { slugify } = require('../src/shared/text');

const projectId = process.argv[2];
const apply = process.argv.includes('--apply');
if (!projectId) throw new Error('Usage: node scripts/recover-legacy-project-assets.js <project-id> [--apply]');

const config = loadConfig(path.resolve(__dirname, '..'));
const store = new ProjectStore(config.paths.projects);
const projectPath = store.documentPath(projectId);
const project = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
const sources = [
  { field: 'versions', dir: config.paths.generated, prefix: '/generated/', extensions: /\.(png|jpe?g|webp|gif)$/i },
  { field: 'audioVersions', dir: config.paths.audio, prefix: '/audio/', extensions: /\.(wav|mp3|ogg|m4a)$/i },
  { field: 'videoVersions', dir: config.paths.videos, prefix: '/videos/', extensions: /\.(mp4|webm|mov)$/i },
];

let recovered = 0;
for (const scene of project.scenes || []) {
  const titleSlug = slugify(scene.title || 'scene');
  for (const source of sources) {
    if (!fs.existsSync(source.dir)) continue;
    const matches = fs.readdirSync(source.dir)
      .filter((fileName) => source.extensions.test(fileName))
      .filter((fileName) => fileName.match(/^\d+-([a-z0-9-]+)-\d+-[a-f0-9]+\.[^.]+$/)?.[1] === titleSlug)
      .sort((left, right) => fs.statSync(path.join(source.dir, left)).mtimeMs - fs.statSync(path.join(source.dir, right)).mtimeMs);
    const existing = new Map((scene[source.field] || []).map((version) => [path.basename(version.path || ''), version]));
    for (const fileName of matches) {
      if (existing.has(fileName)) continue;
      const stat = fs.statSync(path.join(source.dir, fileName));
      existing.set(fileName, {
        path: `${source.prefix}${encodeURIComponent(fileName)}`,
        ...(source.field !== 'audioVersions' ? { prompt: scene.prompt || '' } : {}),
        createdAt: stat.mtime.toISOString(),
      });
      recovered += 1;
    }
    scene[source.field] = [...existing.values()];
    const activeField = source.field === 'versions' ? 'activeVersionIndex' : source.field === 'audioVersions' ? 'activeAudioVersionIndex' : 'activeVideoVersionIndex';
    scene[activeField] = Math.max(0, scene[source.field].length - 1);
  }
  if (scene.videoVersions?.length) scene.activeVisualType = 'video';
  else if (scene.versions?.length) scene.activeVisualType = 'image';
}

if (!apply) {
  process.stdout.write(`Would recover ${recovered} legacy media versions. Re-run with --apply.\n`);
  process.exit(0);
}

const current = store.read(projectId);
const saved = store.write(projectId, { ...current, scenes: project.scenes }, { expectedRevision: current.revision, ownerId: current.ownerId });
process.stdout.write(`Recovered ${recovered} media versions into project ${projectId} at revision ${saved.revision}.\n`);

const { imageShot } = require('./scene-shots');

function textOf(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  for (const key of ['narrationText', 'text', 'value', 'content', 'output']) {
    if (typeof value[key] === 'string' && value[key]) return value[key];
  }
  return '';
}

/** Strip a project scene down to read-only public media fields. */
function publicSceneView(scene = {}, index = 0) {
  const shot = imageShot(scene);
  const image = Array.isArray(shot.versions) ? shot.versions[shot.activeVersionIndex] : null;
  const video = Array.isArray(shot.videoVersions) ? shot.videoVersions[shot.activeVideoVersionIndex] : null;
  const audio = Array.isArray(scene.audioVersions) ? scene.audioVersions[scene.activeAudioVersionIndex] : null;
  const subtitle = Array.isArray(scene.subtitleVersions)
    ? scene.subtitleVersions[scene.activeSubtitleVersionIndex]
    : null;
  const audioPath = audio?.path || null;
  const hasVideo = scene.activeVisualType === 'video' && Boolean(video?.path);

  return {
    id: scene.id || `scene-${index + 1}`,
    index,
    title: scene.title || `Scene ${index + 1}`,
    narrationText: textOf(scene.narrationText),
    imagePath: image?.path || null,
    videoPath: hasVideo ? video.path : null,
    audioPath,
    words: subtitle?.sourceAudioPath === audioPath ? (subtitle?.words || null) : null,
    captionStyle: subtitle?.style || 'classic',
  };
}

function publicProjectView(project) {
  if (!project) return null;
  const scenes = Array.isArray(project.scenes) ? project.scenes.map(publicSceneView) : [];
  return {
    id: project.id,
    title: project.title || 'Untitled',
    scenes,
  };
}

module.exports = { publicSceneView, publicProjectView };

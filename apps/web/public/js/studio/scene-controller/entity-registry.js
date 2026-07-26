import { textValue } from '../../core/text-values.js';
import { imageShot, setActiveImageVersion, setActiveVideoVersion, setImagePrompt } from '../../core/scene-shots.js';

export const ENTITY_CONFIG = {
  action: {
    title: 'Still Action',
    kind: 'text',
    fieldLabel: 'Still action — what the still depicts',
    getValue: (scene) => textValue(scene.beat, ['beat']),
    setValue: (scene, value) => { scene.beat = value; },
  },
  prompt: {
    title: 'Image Prompt',
    kind: 'text',
    fieldLabel: 'Visual prompt',
    getValue: (scene) => textValue(scene.prompt, ['prompt']),
    setValue: (scene, value) => { setImagePrompt(scene, value); },
  },
  dialogue: {
    title: 'Spoken Narration',
    kind: 'text',
    fieldLabel: 'Spoken Narration',
    getValue: (scene) => textValue(scene.narrationText, ['narrationText']),
    setValue: (scene, value) => { scene.narrationText = value; scene.narrationIsFallback = false; },
  },
  image: {
    title: 'Image',
    kind: 'image',
    versions: (scene) => imageShot(scene).versions,
    activeIndex: (scene) => imageShot(scene).activeVersionIndex,
    selectVersion: (scene, vIndex) => { setActiveImageVersion(scene, vIndex); scene.activeVisualType = 'image'; },
  },
  audio: {
    title: 'Audio',
    kind: 'audio',
    versions: (scene) => scene.audioVersions || [],
    activeIndex: (scene) => scene.activeAudioVersionIndex,
    selectVersion: (scene, vIndex) => { scene.activeAudioVersionIndex = vIndex; },
  },
  video: {
    title: 'Video',
    kind: 'video',
    versions: (scene) => imageShot(scene).videoVersions || [],
    activeIndex: (scene) => imageShot(scene).activeVideoVersionIndex,
    selectVersion: (scene, vIndex) => { setActiveVideoVersion(scene, vIndex); scene.activeVisualType = 'video'; },
  },
  subtitle: {
    title: 'Subtitles',
    kind: 'subtitle',
    versions: (scene) => scene.subtitleVersions || [],
    activeIndex: (scene) => scene.activeSubtitleVersionIndex,
    selectVersion: (scene, vIndex) => { scene.activeSubtitleVersionIndex = vIndex; },
  },
};

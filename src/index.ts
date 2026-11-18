import { SpatialCanvasSystem, VoiceOrb, SynthButton, ClearButton, IdeaCard } from './spatialCanvas.js';
import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { PanelSystem } from './panel.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  world.registerSystem(PanelSystem);

  world
    .registerComponent(VoiceOrb)
    .registerComponent(SynthButton)
    .registerComponent(ClearButton)
    .registerComponent(IdeaCard)
    .registerSystem(SpatialCanvasSystem);
});
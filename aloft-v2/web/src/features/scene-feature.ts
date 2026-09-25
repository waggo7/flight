import { Color, Fog, PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import type { Feature } from '../engine/game-context';
import { serviceToken } from '../engine/service-registry';
import { FramePhase } from '../engine/system-phases';

// Owns the canvas, renderer, scene and camera, and draws the frame last.

export interface SceneService {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  /** The test API turns this off to advance many frames without drawing each one. */
  renderEnabled: boolean;
}

export const SceneToken = serviceToken<SceneService>('scene');

export const sceneFeature: Feature = {
  name: 'scene',
  install(ctx) {
    const host = document.getElementById('app') ?? document.body;
    const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: ctx.testMode });
    const pixelBudget = ctx.profile === 'phone' ? 1.6e6 : 3.2e6;
    const canvas = renderer.domElement;
    canvas.className = 'stage';
    host.prepend(canvas);

    const scene = new Scene();
    scene.background = new Color('#9fc4e0');
    scene.fog = new Fog('#bcd3e4', 600, 5200);
    const camera = new PerspectiveCamera(58, 1, 0.3, 30000);

    const resize = (): void => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(pixelBudget / Math.max(1, width * height)), 2);
      renderer.setPixelRatio(Math.max(0.5, ratio));
      renderer.setSize(width, height, false);
      camera.aspect = width / Math.max(1, height);
      camera.updateProjectionMatrix();
    };
    resize();
    window.addEventListener('resize', resize);

    const service = ctx.services.provide(SceneToken, { canvas, renderer, scene, camera, renderEnabled: true });
    ctx.systems.addFrame({
      name: 'render',
      phase: FramePhase.Render,
      frame() {
        if (service.renderEnabled) renderer.render(scene, camera);
      },
    });
  },
};

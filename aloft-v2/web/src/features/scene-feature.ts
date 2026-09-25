import { MathUtils, NoToneMapping, PCFShadowMap, PerspectiveCamera, Scene, Vector2, WebGLRenderer } from 'three';
import { QUALITY, type QualitySettings } from '../app/quality-profile';
import type { Feature } from '../engine/game-context';
import { serviceToken } from '../engine/service-registry';
import { FramePhase } from '../engine/system-phases';
import { PostPipeline } from '../present/render/post/post-pipeline';

// Owns the canvas, renderer, scene, camera and post pipeline, and draws the frame last.
// As v1: the scene renders HDR into the post pipeline's target and is tone-mapped only there
// (never renderer tone mapping); the pixel ratio follows a per-device pixel budget, and an
// adaptive render scale trades pixels for a steady frame rate.

export interface SceneService {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly post: PostPipeline;
  readonly quality: QualitySettings;
  /** The player asked for less motion: shakes and speed blur are scaled down (v1: 0.35 / 0.3). */
  readonly reducedMotion: boolean;
  /** Drawing-buffer size in pixels. */
  readonly drawingSize: Vector2;
  /** Pixels per unit of view-space size at distance 1 (for point-sprite sizing). */
  readonly projectionScale: number;
  /** The test API turns this off to advance many frames without drawing each one. */
  renderEnabled: boolean;
  draw(): void;
}

export const SceneToken = serviceToken<SceneService>('scene');

export const sceneFeature: Feature = {
  name: 'scene',
  install(ctx) {
    const quality = QUALITY[ctx.profile];
    const host = document.getElementById('app') ?? document.body;
    const renderer = new WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false, preserveDrawingBuffer: ctx.testMode });
    if (!renderer.capabilities.isWebGL2) throw new Error('Aloft needs WebGL 2. Try a recent Chrome, Edge, Firefox or Safari with hardware acceleration on.');
    renderer.autoClear = false; // the bloom upsample accumulates into each mip level
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
    renderer.toneMapping = NoToneMapping;
    const canvas = renderer.domElement;
    canvas.className = 'scene';
    host.prepend(canvas);

    const scene = new Scene();
    const camera = new PerspectiveCamera(42, 1, 0.3, 32000);
    const post = new PostPipeline(renderer);
    const drawingSize = new Vector2(1, 1);
    let renderScale = 1;

    const resize = (): void => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const budgetRatio = Math.sqrt(quality.pixelBudget / Math.max(1, width * height));
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.maxPixelRatio, budgetRatio) * renderScale);
      renderer.setSize(width, height, false);
      camera.aspect = width / Math.max(1, height);
      camera.updateProjectionMatrix();
      renderer.getDrawingBufferSize(drawingSize);
      post.setSize(drawingSize.x, drawingSize.y);
    };
    resize();
    window.addEventListener('resize', resize);

    const service = ctx.services.provide(SceneToken, {
      canvas, renderer, scene, camera, post, quality, drawingSize,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      get projectionScale() {
        return drawingSize.y / (2 * Math.tan(MathUtils.degToRad(camera.fov) / 2));
      },
      renderEnabled: true,
      draw() {
        post.render(scene, camera);
      },
    });

    // Adaptive resolution with hysteresis (v1): average frame time over 2 s windows.
    let windowTime = 0;
    let windowFrames = 0;
    ctx.systems.addFrame({
      name: 'render',
      phase: FramePhase.Render,
      frame(realDt) {
        if (service.renderEnabled) service.draw();
        if (ctx.testMode || ctx.loop.timeScale === 0) return;
        windowTime += realDt;
        windowFrames++;
        if (windowTime < 2) return;
        const average = windowTime / windowFrames;
        windowTime = 0;
        windowFrames = 0;
        if (average > 1 / 40 && renderScale > 0.55) {
          renderScale = Math.max(0.55, renderScale - 0.1);
          resize();
        } else if (average < 1 / 57 && renderScale < 1) {
          renderScale = Math.min(1, renderScale + 0.05);
          resize();
        }
      },
    });
  },
};

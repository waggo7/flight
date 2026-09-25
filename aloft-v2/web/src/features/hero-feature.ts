import { Mesh, Vector3 } from 'three';
import { IDLE_CONTROLS } from '../core/flight-model';
import type { Feature } from '../engine/game-context';
import { serviceToken } from '../engine/service-registry';
import { FramePhase } from '../engine/system-phases';
import { CapeCloth } from '../present/render/hero/cape-cloth';
import { HeroFigure } from '../present/render/hero/hero-figure';
import { CameraToken } from './camera-feature';
import { ControlsToken } from './controls-feature';
import { FlightToken } from './flight-feature';
import { SceneToken } from './scene-feature';

// v1's hero and cloth cape, posed from the interpolated flight state every frame. Hidden once
// the first-person view is mostly blended in. M6 replaces the rig with the data-driven one.

export interface HeroService {
  readonly figure: HeroFigure;
  readonly cape: CapeCloth;
}

export const HeroToken = serviceToken<HeroService>('hero');

const DOWN = new Vector3(0, -1, 0);

export const heroFeature: Feature = {
  name: 'hero',
  install(ctx) {
    const { scene } = ctx.services.require(SceneToken);
    const flight = ctx.services.require(FlightToken);
    const controls = ctx.services.require(ControlsToken);
    const rig = ctx.services.require(CameraToken);

    const figure = new HeroFigure();
    const cape = new CapeCloth();
    const capeMesh = new Mesh(cape.geometry, figure.capeMaterial);
    capeMesh.frustumCulled = false;
    capeMesh.castShadow = true;
    capeMesh.receiveShadow = true;
    scene.add(figure.root, capeMesh);
    ctx.services.provide(HeroToken, { figure, cape });

    const back = new Vector3();
    const settle = (): void => {
      figure.update(0, flight.view, IDLE_CONTROLS);
      cape.drape(figure.refreshCapeFrame(), DOWN, back.copy(flight.view.forward).negate());
      capeMesh.position.copy(figure.root.position);
    };
    settle();
    ctx.events.on('game:restart', settle);

    ctx.systems.addFrame({
      name: 'hero',
      phase: FramePhase.Present,
      frame(realDt) {
        const simDt = realDt * ctx.loop.timeScale;
        figure.update(simDt, flight.view, flight.active ? controls.current : IDLE_CONTROLS);
        cape.setAnchors(figure.refreshCapeFrame());
        cape.step(simDt, flight.view.velocity, flight.view.acceleration, figure.capsule);
        capeMesh.position.copy(figure.root.position);
        const visible = rig.firstPersonBlend <= 0.6;
        figure.root.visible = visible;
        capeMesh.visible = visible;
      },
    });
  },
};

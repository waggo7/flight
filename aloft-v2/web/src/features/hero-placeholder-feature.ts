import { CapsuleGeometry, Group, Mesh, MeshStandardMaterial, BoxGeometry } from 'three';
import type { Feature } from '../engine/game-context';
import { FramePhase } from '../engine/system-phases';
import { CameraToken } from './camera-feature';
import { FlightToken } from './flight-feature';
import { SceneToken } from './scene-feature';

// M0 stand-in hero: a capsule body that tips from upright (hover) to horizontal (flight) and a
// fist that shows which way is forward. M1 ports v1's hero; M6 replaces it with the new rig.

export const heroPlaceholderFeature: Feature = {
  name: 'hero-placeholder',
  install(ctx) {
    const { scene } = ctx.services.require(SceneToken);
    const flight = ctx.services.require(FlightToken);
    const rig = ctx.services.require(CameraToken);

    const root = new Group();
    const body = new Group();
    root.add(body);
    const suit = new MeshStandardMaterial({ color: '#ebe5da', roughness: 0.5 });
    const cape = new MeshStandardMaterial({ color: '#a3121c', roughness: 0.6 });
    body.add(new Mesh(new CapsuleGeometry(0.22, 1.2, 6, 14), suit));
    const fist = new Mesh(new BoxGeometry(0.14, 0.14, 0.14), cape);
    fist.position.set(0, 0.95, 0);
    body.add(fist);
    const capeSheet = new Mesh(new BoxGeometry(0.5, 1.1, 0.02), cape);
    capeSheet.position.set(0, -0.1, -0.2);
    body.add(capeSheet);
    scene.add(root);

    ctx.systems.addFrame({
      name: 'hero-placeholder',
      phase: FramePhase.Present,
      frame() {
        const view = flight.view;
        root.position.copy(view.position);
        root.quaternion.copy(view.quaternion);
        body.rotation.x = (1 - view.hoverBlend) * (Math.PI / 2);
        root.visible = rig.firstPersonBlend < 0.6;
      },
    });
  },
};

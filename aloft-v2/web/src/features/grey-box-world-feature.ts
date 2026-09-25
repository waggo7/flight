import {
  BoxGeometry, CircleGeometry, Color, DirectionalLight, HemisphereLight, InstancedMesh, Matrix4, Mesh,
  MeshLambertMaterial, MeshStandardMaterial, PlaneGeometry, Quaternion, Vector3,
} from 'three';
import type { Feature } from '../engine/game-context';
import { createGreyBoxCity, GreyBoxWorld, ISLAND_GROUND, ISLAND_RADIUS } from '../sim/grey-box-world';
import { SceneToken } from './scene-feature';
import { WorldToken } from './world-token';

// M0 stand-in: flat island, sea and box towers, so flight can be tested before the real city
// (M1) and physics (M2) arrive.

export const greyBoxWorldFeature: Feature = {
  name: 'grey-box-world',
  install(ctx) {
    const { scene } = ctx.services.require(SceneToken);
    const boxes = createGreyBoxCity(ctx.random.stream('grey-box-city'));
    ctx.services.provide(WorldToken, new GreyBoxWorld(boxes));

    scene.add(new HemisphereLight('#dbe9f5', '#6b6258', 1.2));
    const sun = new DirectionalLight('#fff1dc', 2.2);
    sun.position.set(-600, 900, 400);
    scene.add(sun);

    const sea = new Mesh(new PlaneGeometry(20000, 20000), new MeshLambertMaterial({ color: '#3d6f8f' }));
    sea.rotation.x = -Math.PI / 2;
    scene.add(sea);
    const island = new Mesh(new CircleGeometry(ISLAND_RADIUS, 96), new MeshLambertMaterial({ color: '#8f8a7f' }));
    island.rotation.x = -Math.PI / 2;
    island.position.y = ISLAND_GROUND;
    scene.add(island);

    const towers = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: '#c9c3b8', roughness: 0.85 }), boxes.length);
    const matrix = new Matrix4();
    const size = new Vector3();
    const centre = new Vector3();
    const tint = new Color();
    const shade = ctx.random.stream('grey-box-shade');
    boxes.forEach((box, i) => {
      size.subVectors(box.max, box.min);
      centre.addVectors(box.min, box.max).multiplyScalar(0.5);
      towers.setMatrixAt(i, matrix.compose(centre, new Quaternion(), size));
      towers.setColorAt(i, tint.setHSL(0.08, 0.06, shade.range(0.55, 0.8)));
    });
    scene.add(towers);
  },
};

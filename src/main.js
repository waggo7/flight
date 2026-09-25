import * as THREE from 'three';
import './styles.css';
import { SUN_DIRECTION, PALETTE, atmosphereUniforms } from './atmosphere.js';
import { createSkyDome, createSkyEnvironment } from './sky-dome.js';
import { IslandTerrain } from './island-terrain.js';
import { createOcean } from './ocean-surface.js';
import { CitySkyline } from './city-skyline.js';
import { CloudField } from './cloud-field.js';
import { SparkTrails } from './spark-trails.js';
import { HeroFigure } from './hero-figure.js';
import { CapeCloth } from './cape-cloth.js';
import { FlightModel } from './flight-model.js';
import { InputControls } from './input-controls.js';
import { ChaseCamera } from './chase-camera.js';
import { SpeedEffects } from './speed-effects.js';
import { PostPipeline } from './post-pipeline.js';
import { FlightAudio } from './flight-audio.js';
import { HudOverlay } from './hud-overlay.js';
import { clamp, damp, smoothstep } from './scalar-math.js';

const TEST_MODE = new URLSearchParams(location.search).has('test');
const COARSE_POINTER = matchMedia('(pointer: coarse)').matches;
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
const QUALITY = COARSE_POINTER
  ? { maxPixelRatio: 1.5, pixelBudget: 1.4e6, shadowSize: 1024, cloudDetail: 1, cloudCount: 110 }
  : { maxPixelRatio: 2, pixelBudget: 3.2e6, shadowSize: 2048, cloudDetail: 2, cloudCount: 150 };
const SPAWN = { position: new THREE.Vector3(-60, 190, -980), yaw: 0.09 };
const IDLE_INPUT = Object.freeze({ steerX: 0, steerY: 0, boost: false, brake: false });
const SETTINGS_KEY = 'aloft-settings';
const HINTS_KEY = 'aloft-hints-seen';

const hud = new HudOverlay();
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

function readStored(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable (private mode, sandboxed frames); settings just won't persist.
  }
}

async function boot() {
  const canvas = document.getElementById('scene');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    if (!renderer.capabilities.isWebGL2) throw new Error('WebGL2 unavailable');
  } catch {
    hud.showFatal('Aloft needs WebGL 2. Try a recent Chrome, Edge, Firefox or Safari with hardware acceleration on.');
    return;
  }
  renderer.autoClear = false;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.NoToneMapping;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.3, 32000);

  hud.setLoading('Raising the city…');
  await nextFrame();
  const terrain = new IslandTerrain();
  const city = new CitySkyline(terrain);
  await nextFrame();
  hud.setLoading('Gathering clouds…');
  await nextFrame();
  const clouds = new CloudField({ detail: QUALITY.cloudDetail, count: QUALITY.cloudCount });
  const ocean = createOcean(terrain.createDepthTexture());
  const sparks = new SparkTrails({ city, terrain, clouds });
  await nextFrame();

  scene.add(createSkyDome(), terrain.mesh, terrain.trees, ocean.mesh, city.group, clouds.mesh, sparks.group);
  scene.environment = createSkyEnvironment(renderer);
  scene.environmentIntensity = 0.85;

  const sun = new THREE.DirectionalLight(PALETTE.sunLight, 3.1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(QUALITY.shadowSize, QUALITY.shadowSize);
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 3800;
  sun.shadow.bias = -0.00008;
  sun.shadow.normalBias = 0.6;
  sun.shadow.radius = 2.5;
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight('#a4b8e8', '#5b473b', 0.3));

  const hero = new HeroFigure();
  scene.add(hero.root);
  const cape = new CapeCloth();
  const capeMesh = new THREE.Mesh(cape.geometry, hero.capeMaterial);
  capeMesh.frustumCulled = false;
  capeMesh.castShadow = true;
  capeMesh.receiveShadow = true;
  scene.add(capeMesh);

  const world = {
    groundHeight: (x, z) => terrain.heightAt(x, z),
    collideSphere: (p, r, n) => city.collideSphere(p, r, n),
    nearestSurface: (p, d) => city.nearestSurface(p, d),
    raycast: (origin, direction, distance) => city.raycast(origin, direction, distance),
  };
  const flight = new FlightModel(world);
  const input = new InputControls(canvas);
  const chase = new ChaseCamera(camera);
  const effects = new SpeedEffects(scene);
  const post = new PostPipeline(renderer);
  const audio = new FlightAudio();

  // ----- settings -------------------------------------------------------

  const settings = readStored(SETTINGS_KEY, { sensitivity: 1, invertY: false, firstPerson: false, sound: true });
  const applySettings = () => {
    input.sensitivity = settings.sensitivity;
    input.invertY = settings.invertY;
    chase.setMode(settings.firstPerson ? 'first' : 'chase');
    audio.setMuted(!settings.sound);
    hud.applySettings(settings);
    writeStored(SETTINGS_KEY, settings);
  };
  applySettings();
  hud.on('settings', (next) => {
    Object.assign(settings, next);
    applySettings();
  });

  // ----- world state ----------------------------------------------------

  let state = 'title';
  let time = 0;
  let flash = 0;
  let cloudVeil = 0;
  let introTarget = 1;
  let wasBoosting = false;
  let testControls = null;
  const hintsSeen = new Set(readStored(HINTS_KEY, { keys: [] }).keys);
  const coach = { flightTime: 0, steerTime: 0, boostTime: 0, collected: 0, hovered: false, shownAt: 0 };

  flight.reset(SPAWN.position, SPAWN.yaw);
  chase.snapTo(flight);
  hero.update(0, flight, IDLE_INPUT);
  cape.drape(hero.refreshCapeFrame(), new THREE.Vector3(0, -1, 0), flight.forward.clone().negate());
  hud.setSparks(0, sparks.total);

  const markHint = (key) => {
    if (hintsSeen.has(key)) return;
    hintsSeen.add(key);
    writeStored(HINTS_KEY, { keys: [...hintsSeen] });
    hud.clearHint(key);
  };

  function hintText(key) {
    const touch = input.device === 'touch';
    const pad = input.device === 'gamepad';
    switch (key) {
      case 'steer':
        return touch ? 'Drag on the left to steer' : pad ? 'Left stick to steer' : 'Move the mouse to steer — or use WASD';
      case 'boost':
        return touch ? 'Hold the right side to boost' : pad ? 'Hold A or the right trigger to boost' : 'Hold click or Space to boost';
      case 'sparks':
        return 'Fly through the glowing sparks';
      case 'hover':
        return touch ? 'Hold Hover to slow down and float' : pad ? 'Hold B or the left trigger to hover' : 'Hold right-click or Shift to slow down and hover';
      default:
        return '';
    }
  }

  function updateCoach(dt, controls) {
    if (state !== 'flying') return;
    coach.flightTime += dt;
    if (Math.hypot(controls.steerX, controls.steerY) > 0.35) coach.steerTime += dt;
    if (controls.boost) coach.boostTime += dt;
    if (coach.steerTime > 0.8) markHint('steer');
    if (coach.boostTime > 1) markHint('boost');
    if (coach.collected > 0 || coach.flightTime > 40) markHint('sparks');
    if (coach.hovered) markHint('hover');
    const order = [
      ['steer', 2.5],
      ['boost', 6],
      ['sparks', 12],
      ['hover', 28],
    ];
    const next = order.find(([key, after]) => !hintsSeen.has(key) && coach.flightTime > after);
    if (next) hud.showHint(next[0], hintText(next[0]));
    else hud.clearHint();
  }

  // ----- state changes ---------------------------------------------------

  function startFlight() {
    if (state !== 'title') return;
    audio.start().then(() => audio.setMuted(!settings.sound));
    state = 'flying';
    introTarget = 0;
    input.setEnabled(true);
    hud.showFlight();
    flight.launch();
    document.activeElement?.blur?.();
  }

  function pause() {
    if (state !== 'flying') return;
    state = 'paused';
    input.setEnabled(false);
    hud.showPause();
  }

  function resume() {
    if (state !== 'paused') return;
    state = 'flying';
    input.setEnabled(true);
    hud.showFlight();
    audio.start();
    document.activeElement?.blur?.();
  }

  hud.on('start', startFlight);
  hud.on('resume', resume);
  hud.on('pause', pause);
  hud.on('touchButton', (name, pressed) => input.setTouchButton(name, pressed));
  input.on('pause', () => (state === 'flying' ? pause() : resume()));
  input.on('confirm', () => (state === 'title' ? startFlight() : resume()));
  input.on('toggle-view', () => {
    settings.firstPerson = !settings.firstPerson;
    applySettings();
  });
  input.on('toggle-sound', () => {
    settings.sound = !settings.sound;
    applySettings();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
  });

  // ----- events -----------------------------------------------------------

  function onFlightEvent(event) {
    const motion = REDUCED_MOTION ? 0.35 : 1;
    switch (event.type) {
      case 'launch':
        effects.onLaunch(flight.position, flight.forward);
        audio.whoosh(1);
        chase.kick(5 * motion);
        chase.shake(0.25 * motion);
        break;
      case 'boom':
        effects.onBoom(flight.position, flight.forward);
        audio.boom();
        chase.kick(9 * motion);
        chase.shake(0.55 * motion);
        flash = 0.28 * motion;
        break;
      case 'impact':
        effects.onImpact(event.point, event.normal, event.strength);
        audio.thud(event.strength);
        chase.shake((0.25 + event.strength * 0.5) * motion);
        break;
      case 'splash':
        effects.onSplash(event.point, event.strength);
        audio.splash(event.strength);
        chase.shake(0.2 * motion);
        break;
      case 'hover':
        coach.hovered = true;
        break;
      case 'edge':
        hud.toast('Turning back toward the city');
        break;
    }
  }

  function onSparkEvent(event) {
    if (event.type === 'respawn') {
      hud.setSparks(0, sparks.total);
      hud.toast('The sparks have returned');
      return;
    }
    coach.collected++;
    effects.burstSparks(event.position);
    audio.chime(event.streak);
    hud.setSparks(sparks.collected, sparks.total, true);
    if (event.allDone) {
      audio.trailComplete(5);
      hud.toast('Every spark found', 4.5);
    } else if (event.trailDone) {
      audio.trailComplete(3);
      hud.toast(`Trail complete · ${event.trailsDone} of ${sparks.trails.length}`);
    }
  }

  // ----- sun shadow that follows the hero ----------------------------------

  const lightForward = SUN_DIRECTION.clone().negate();
  const lightRight = new THREE.Vector3().crossVectors(lightForward, new THREE.Vector3(0, 1, 0)).normalize();
  const lightUp = new THREE.Vector3().crossVectors(lightRight, lightForward).normalize();
  const shadowFocus = new THREE.Vector3();
  function updateSunShadow() {
    const altitude = Math.max(0, flight.position.y - 40);
    const extent = Math.round(clamp(180 + altitude * 0.55, 180, 640) / 40) * 40;
    const shadowCamera = sun.shadow.camera;
    if (shadowCamera.right !== extent) {
      shadowCamera.left = -extent;
      shadowCamera.right = extent;
      shadowCamera.top = extent;
      shadowCamera.bottom = -extent;
      shadowCamera.updateProjectionMatrix();
    }
    shadowFocus.copy(flight.position).addScaledVector(flight.forward, 40);
    const texel = (2 * extent) / sun.shadow.mapSize.x;
    const x = Math.round(shadowFocus.dot(lightRight) / texel) * texel;
    const y = Math.round(shadowFocus.dot(lightUp) / texel) * texel;
    const z = shadowFocus.dot(lightForward);
    shadowFocus.copy(lightRight).multiplyScalar(x).addScaledVector(lightUp, y).addScaledVector(lightForward, z);
    sun.target.position.copy(shadowFocus);
    sun.position.copy(shadowFocus).addScaledVector(SUN_DIRECTION, 1800);
    sun.target.updateMatrixWorld();
  }

  // ----- sizing ------------------------------------------------------------

  let renderScale = 1;
  const drawingSize = new THREE.Vector2();
  function resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const budgetRatio = Math.sqrt(QUALITY.pixelBudget / (width * height));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, QUALITY.maxPixelRatio, budgetRatio) * renderScale);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.getDrawingBufferSize(drawingSize);
    post.setSize(drawingSize.x, drawingSize.y);
  }
  window.addEventListener('resize', resize);
  resize();

  // Adaptive resolution: trade pixels for a steady frame rate, with hysteresis.
  let frameAccumulator = 0;
  let frameCount = 0;
  function adaptResolution(dt) {
    if (TEST_MODE || state === 'paused') return;
    frameAccumulator += dt;
    frameCount++;
    if (frameAccumulator < 2) return;
    const average = frameAccumulator / frameCount;
    frameAccumulator = 0;
    frameCount = 0;
    if (average > 1 / 40 && renderScale > 0.55) {
      renderScale = Math.max(0.55, renderScale - 0.1);
      resize();
    } else if (average < 1 / 57 && renderScale < 1) {
      renderScale = Math.min(1, renderScale + 0.05);
      resize();
    }
  }

  // ----- the frame -----------------------------------------------------------

  function step(dt) {
    const simDt = state === 'paused' ? 0 : dt;
    time += simDt;
    atmosphereUniforms.uTime.value = time;

    input.update(dt);
    hud.setDevice(input.device);
    const controls = testControls ?? (state === 'flying' ? input.state : IDLE_INPUT);

    flight.update(simDt, controls);
    for (const event of flight.takeEvents()) onFlightEvent(event);
    if (controls.boost && !wasBoosting && flight.mode === 'flying' && state === 'flying') audio.whoosh(0.6);
    wasBoosting = controls.boost;

    hero.update(simDt, flight, controls);
    cape.setAnchors(hero.refreshCapeFrame());
    cape.step(simDt, flight.velocity, flight.acceleration, hero.capsule);
    capeMesh.position.copy(hero.root.position);
    const hideBody = chase.firstPersonBlend > 0.6;
    hero.root.visible = !hideBody;
    capeMesh.visible = !hideBody;

    chase.intro = damp(chase.intro, introTarget, introTarget === 0 ? 1.7 : 3, dt);
    if (state !== 'paused') chase.update(dt, flight, world);

    ocean.follow(camera);
    city.update(time);
    clouds.update(simDt, flight.position, flight.velocity);
    if (state === 'flying') for (const event of sparks.update(simDt, time, flight.position, camera)) onSparkEvent(event);
    else sparks.update(0, time, new THREE.Vector3(1e6, 1e6, 1e6), camera);

    const projectionScale = drawingSize.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    effects.update(simDt, time, { camera, flight, projectionScale });
    updateSunShadow();
    updateCoach(simDt, controls);

    const motion = REDUCED_MOTION ? 0.3 : 1;
    const heroCloud = clouds.immersion(flight.position);
    cloudVeil = damp(cloudVeil, clouds.immersion(camera.position) * 0.82, 7, dt);
    flash = damp(flash, 0, 5, dt);
    const speedBlur = (smoothstep(60, 140, flight.speed) * flight.boostBlend * 0.55 + flight.surfaceRush * 0.18) * motion;
    post.settings.uSpeedBlur.value = speedBlur;
    post.settings.uCloud.value = cloudVeil;
    post.settings.uFlash.value = flash;
    post.settings.uTime.value = time;

    audio.update(dt, { speed: flight.speed, rush: flight.surfaceRush, cloud: heroCloud, active: state === 'flying' });
    hud.update(dt, {
      speed: flight.speed,
      altitude: flight.groundClearance,
      input,
      device: input.device,
      flying: state === 'flying',
      camera,
      nextSpark: sparks.nearestUncollected(flight.position),
    });
  }

  const render = () => post.render(scene, camera);

  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    step(dt);
    render();
    adaptResolution(dt);
  }

  // Warm up shaders before the first visible frame so the title fades in smoothly.
  renderer.compile(scene, camera);
  step(0);
  render();
  hud.ready();

  if (TEST_MODE) {
    window.__aloft = {
      THREE,
      flight,
      chase,
      hero,
      cape,
      city,
      clouds,
      sparks,
      camera,
      renderer,
      input,
      get state() {
        return state;
      },
      start: startFlight,
      pause,
      resume,
      setControls(controls) {
        testControls = controls ? { ...IDLE_INPUT, ...controls } : null;
      },
      advance(frames = 1, dt = 1 / 60) {
        for (let i = 0; i < frames; i++) step(dt);
        render();
      },
      render,
    };
  } else {
    requestAnimationFrame(frame);
  }
}

boot();

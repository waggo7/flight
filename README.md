# Aloft

A superhero flight over a golden-hour city. Launch from a rooftop hover, carve down avenues
between glass towers, punch through clouds, skim the sea, and break into a shockwave at full speed.

Built with Three.js. No downloads: the city, islands, clouds, hero, cape and sound are all
generated in the browser.

## Controls

| | Mouse + keyboard | Touch | Gamepad |
|---|---|---|---|
| **Steer** | Move the mouse (the screen centre is neutral) · WASD / arrows | Drag with the left thumb | Left stick |
| **Boost** | Hold click · Space | Hold the right side · Boost | A · right trigger |
| **Slow & hover** | Hold right-click · Shift | Hover button | B · left trigger |
| **View** | V (chase / first person) | Pause menu | Y |
| **Pause** | Esc · P | ❚❚ button | Start |

Release the stick and the hero levels out on their own. Hold boost to reach full speed; let go
and they glide back to a calm cruise. Steering sensitivity and invert up/down are in the pause menu.

**Goal (optional):** gather the glowing sparks. They're laid out in trails: an avenue run, a spiral
round the twisting tower, a crown on the needle tower, a cloud-top line, a sea skim, a mountain ring
and a dive column.

## Run it

```bash
npm install
npm run dev      # local dev server
npm run build    # dist/index.html — a single file you can open or host anywhere
npm test         # flight model + cape physics tests
```

Needs a browser with WebGL 2 (current Chrome, Edge, Firefox, Safari).

## How it's made

- **Flight feel:** yaw is rate-controlled, pitch is attitude-controlled, so the hero never tumbles.
  Speed has three calm levels (hover, cruise, boost), and dives trade altitude for speed.
  All tuning lives in `src/flight-tuning.js`.
- **Look:** HDR rendering, shared golden-hour haze on every material, mip-chain bloom and ACES tone mapping.
  Windows are drawn in the shader, and the sea reflects the sky.
- **Cape:** a position-based cloth simulated in the hero's moving frame, so it streams cleanly at 400 km/h.

// MicroPython programs (SPIKE 3 API) that get installed on the hub.

export const PORTS = ['A', 'B', 'C', 'D', 'E', 'F'];

// Each direction is [left factor, right factor]; "turn" factors use the turning speed.
export const DIRECTIONS = {
  f:  { left: 1, right: 1 },
  b:  { left: -1, right: -1 },
  l:  { left: -1, right: 1, spin: true },
  r:  { left: 1, right: -1, spin: true },
  fl: { left: 0.35, right: 1 },
  fr: { left: 1, right: 0.35 },
  bl: { left: -0.35, right: -1 },
  br: { left: -1, right: -0.35 },
};
export const DIR_ORDER = ['f', 'b', 'l', 'r', 'fl', 'fr', 'bl', 'br'];
export const HORN = 'horn';
export const PROGRAM_COUNT = DIR_ORDER.length + 1; // + horn

const MAX_DEG_PER_SEC = 1000;

export function slotFor(base, key) {
  const i = key === HORN ? DIR_ORDER.length : DIR_ORDER.indexOf(key);
  return base + i;
}

export function driveProgram(dir, cfg) {
  const d = DIRECTIONS[dir];
  const pct = d.spin ? cfg.turn : cfg.speed;
  const v = (f, rev) => Math.round(f * pct / 100 * MAX_DEG_PER_SEC * (rev ? -1 : 1));
  const l = v(d.left, cfg.revLeft);
  const r = v(d.right, cfg.revRight);
  return `from hub import port
import motor, runloop

async def main():
    motor.run(port.${cfg.leftPort}, ${l})
    motor.run(port.${cfg.rightPort}, ${r})
    while True:
        await runloop.sleep_ms(1000)

runloop.run(main())
`;
}

export function hornProgram() {
  return `from hub import sound
import runloop

async def main():
    await sound.beep(440, 150, 100)
    await sound.beep(554, 250, 100)

runloop.run(main())
`;
}

export const SAMPLE_CODE = `from hub import port, light_matrix
import motor, runloop

async def main():
    await light_matrix.write("Hi!")
    # drive forward for 1 second, then spin
    motor.run(port.A, -500)
    motor.run(port.B, 500)
    await runloop.sleep_ms(1000)
    motor.run(port.A, 400)
    await runloop.sleep_ms(800)
    motor.stop(port.A)
    motor.stop(port.B)
    print("done")

runloop.run(main())
`;

/** Stable signature of everything that affects installed programs. */
export function configSignature(cfg) {
  return JSON.stringify([1, cfg.leftPort, cfg.rightPort, cfg.revLeft, cfg.revRight, cfg.speed, cfg.turn, cfg.slotBase]);
}

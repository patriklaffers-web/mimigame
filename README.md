# SPIKE Car Remote

A web app to drive a car built on a LEGO® Education SPIKE™ hub (Prime or Essential)
over Bluetooth. It runs in the browser, with nothing to install.

## Features

- **Hold-to-drive pad** with 8 directions: forward, back, spin left/right and four curves. Releasing stops the car.
- **Keyboard** (WASD / arrow keys, Space = stop, H = horn) and **gamepad** (left stick or d-pad, A = horn).
- **Speed and turning sliders.**
- **Car setup**: pick the left/right motor ports and reverse either motor.
- **Live sensors**: battery, motor position/speed, distance, color and force sensors.
- **Run your own Python**: upload a program to any slot and see `print()` output in the console.

## Requirements

- A hub on the **SPIKE App 3** firmware. This is the default if you've used the current SPIKE app.
- **Chrome or Edge** on Windows, macOS, Linux, ChromeOS or Android. On iPhone/iPad, use the
  [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055) browser. Safari and Firefox
  don't support Web Bluetooth.
- The page must be served over **HTTPS** or from `localhost`.

## Running it

**GitHub Pages:** in the repo, go to *Settings → Pages* and deploy from this branch's root. Then open the URL on your phone or laptop.

**Locally:**

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

Then:

1. Turn the hub on and press its Bluetooth button. The light starts blinking.
2. Click **Connect hub** and pick the hub.
3. The first time you connect, the app installs its drive programs, which takes a few seconds.
4. Drive! If forward goes backwards, toggle both *Reverse* boxes. If left and right are swapped, swap the ports.

## How it works

The app speaks LEGO's [SPIKE Prime BLE protocol](https://lego.github.io/spike-prime-docs/).
The firmware can't take live motor commands over BLE. So on connect, the app uploads one small
MicroPython program per direction (plus a horn) into **program slots 10–18** (configurable).
Holding a button starts that slot. Releasing it stops the program, which stops the motors.
Starting a slot is a single small message, so the car reacts quickly.

⚠️ Installing overwrites whatever is stored in those slots on the hub.

Changing the speed sliders or car setup re-installs the programs automatically.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | UI and styles |
| `app.js` | UI logic: connecting, installing, driving, telemetry |
| `spike.js` | BLE protocol: COBS framing, CRC32, messages, `Hub` class |
| `programs.js` | The MicroPython programs uploaded to the hub |
| `test/` | Protocol tests against vectors from LEGO's reference Python code (`npm test`) |

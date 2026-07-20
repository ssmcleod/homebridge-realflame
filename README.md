# homebridge-realflame

A [Homebridge](https://homebridge.io) plugin that exposes a **Real Flame WiFi Interface MKII** heater (Millennium Electronics' "Modulating Valve MKII" WiFi module, used across several white-labelled fireplace/heater brands) to Apple Home as a heat-only thermostat.

> **Unofficial and unaffiliated.** This plugin was built by reverse-engineering the local network protocol used by the "Real Flame Fire MKII" Android app (`com.millec.realflamethermostatmkii`), via static analysis of the publicly distributed APK. It is not affiliated with, endorsed by, or supported by Real Flame, Millennium Electronics, or any related company. The protocol is undocumented and could change without notice in a firmware update. Use at your own risk — this plugin can turn on a gas/electric heating appliance in your home.

## What it does

- Exposes the heater as a HomeKit **Thermostat** (heat-only — no cool/auto options)
- **On/off** toggle and **target temperature** (10–35°C), matching how the official Real Flame app itself is used day to day
- **Current temperature** reading from the unit's own sensor
- Talks to the heater directly over your local network — no cloud account, no internet dependency, no Real Flame account required
- Automatically discovers the heater on your network via its own UDP broadcast protocol (or you can pin a static IP in config)

## Requirements

- The heater's WiFi Interface MKII module must already be set up and connected to your home WiFi network (via the Real Flame app's normal setup flow)
- Homebridge must be on the same local network/subnet as the heater — the discovery mechanism relies on IPv4 broadcast, which doesn't cross routers/VLANs

## Installation

```
npm install -g homebridge-realflame
```

(or, until published to npm, install directly from this repo: `npm install github:ssmcleod/homebridge-realflame`)

## Configuration

Add a platform block to your Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "homebridge-realflame.RealFlame",
      "name": "Heater"
    }
  ]
}
```

`name` is the display name shown in the Home app. That's it — no other fields are required; the plugin will discover the heater automatically on startup.

### Optional: static IP

If auto-discovery doesn't work on your network (e.g. client isolation between WiFi and wired segments, or multiple VLANs), you can skip discovery entirely by setting the heater's IP directly:

```json
{
  "platform": "homebridge-realflame.RealFlame",
  "name": "Heater",
  "ip": "10.0.1.58"
}
```

Setting a DHCP reservation for the heater on your router is recommended either way, so its IP doesn't change.

## How it works

The WiFi Interface MKII module speaks a simple plain-text protocol, no encryption, no authentication:

- **Discovery**: the app broadcasts `MWI070011` via UDP to port `3001` (both the global broadcast address and your subnet's directed broadcast); the module replies via UDP to port `3005` with its name and MAC address.
- **Status**: a plain TCP connection to port `3000`, sending `MWIL10`, gets back a comma-separated, hex-encoded status line (`MWIL11,<tempSetting>,<flameSetting>,...,<tempReading>,<state>,<opState>,...`).
- **Control**: sending `MWIL20` + hex-encoded mode/temperature/flame/time bytes over the same TCP port sets the unit's state; it responds with a short `MWIL2,` acknowledgement.

This plugin re-implements just enough of that protocol to support on/off and target temperature. The full command set (flame-level-only mode, timer/schedule programming, LED colour control) is not implemented, since it isn't needed for basic thermostat control in HomeKit — contributions welcome if you want to extend it.

## Known limitations

- The WiFi module's embedded TCP/WiFi stack is occasionally flaky (observed intermittent packet loss and connection timeouts in testing) — the plugin polls every 30 seconds and simply retries on the next cycle rather than treating a single failed poll as fatal.
- The heater also has a separate RF remote control that can drive it independently, and appears to run its own onboard timer/schedule logic (`opState` value `3`, "Ex Managed Mode") that isn't fully reverse-engineered. The plugin's target-temperature display tracks the same state the official app shows, which can differ slightly from what the physical remote displays when the unit is running a scheduled program.

## License

MIT

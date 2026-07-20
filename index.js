'use strict';

const realflame = require('./lib/realflame-client.js');

const PLUGIN_NAME = 'homebridge-realflame';
const PLATFORM_NAME = 'RealFlame';

const POLL_INTERVAL_MS = 30000;

module.exports = (api) => {
	api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, RealFlamePlatform);
};

// Dynamic platform hosting a single Real Flame heater as a HomeKit Thermostat
// (heat-only): on/off + target temperature, matching how the Real Flame app
// itself is actually used day to day.
class RealFlamePlatform {
	constructor(log, config, api) {
		this.log = log;
		this.config = config || {};
		this.api = api;
		this.hap = api.hap;
		this.cachedAccessories = new Map();
		this.ip = this.config.ip; // optional static override; otherwise auto-discovered

		this.api.on('didFinishLaunching', () => this._didFinishLaunching());
	}

	configureAccessory(platformAccessory) {
		this.cachedAccessories.set(platformAccessory.UUID, platformAccessory);
	}

	async _didFinishLaunching() {
		if (!this.ip) {
			try {
				const found = await realflame.discover();
				this.ip = found.ip;
				this.log.info(`Discovered Real Flame heater '${found.name}' at ${found.ip} (${found.mac})`);
			} catch (err) {
				this.log.error(`Failed to discover Real Flame heater: ${err.message}. ` +
					`You can also set 'ip' explicitly in config.json for this platform.`);
				return;
			}
		}

		const name = this.config.name || 'Heater';
		const uuid = this.hap.uuid.generate(`homebridge-realflame:${this.ip}`);
		const existing = this.cachedAccessories.get(uuid);
		const platformAccessory = existing || new this.api.platformAccessory(name, uuid);
		platformAccessory.context.ip = this.ip;

		this.accessory = new RealFlameThermostatAccessory(this, platformAccessory, name);

		if (!existing) {
			this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [platformAccessory]);
		}

		// clear out any stale cached accessory left over from a previous IP/UUID
		const stale = [...this.cachedAccessories.values()].filter(pa => pa.UUID !== uuid);
		if (stale.length > 0) {
			this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
		}
	}
}

class RealFlameThermostatAccessory {
	constructor(platform, platformAccessory, name) {
		this.log = platform.log;
		this.hap = platform.hap;
		this.ip = platform.ip;
		this.platformAccessory = platformAccessory;

		this.lastStatus = null;
		this.targetTemperature = realflame.MIN_TEMP;

		const infoService = platformAccessory.getService(this.hap.Service.AccessoryInformation) ||
			platformAccessory.addService(this.hap.Service.AccessoryInformation);
		infoService.setCharacteristic(this.hap.Characteristic.Manufacturer, 'Real Flame / Millennium Electronics');
		infoService.setCharacteristic(this.hap.Characteristic.Model, 'WiFi Interface MKII');
		infoService.setCharacteristic(this.hap.Characteristic.SerialNumber, this.ip);

		this.service = platformAccessory.getService(this.hap.Service.Thermostat) ||
			platformAccessory.addService(this.hap.Service.Thermostat, name);

		// this unit only heats -- restrict the Home app to Off/Heat, no Cool/Auto
		this.service.getCharacteristic(this.hap.Characteristic.TargetHeatingCoolingState)
			.setProps({ validValues: [0, 1] })
			.onGet(this.getTargetHeatingCoolingState.bind(this))
			.onSet(this.setTargetHeatingCoolingState.bind(this));

		this.service.getCharacteristic(this.hap.Characteristic.CurrentHeatingCoolingState)
			.onGet(this.getCurrentHeatingCoolingState.bind(this));

		this.service.getCharacteristic(this.hap.Characteristic.TargetTemperature)
			.setProps({ minValue: realflame.MIN_TEMP, maxValue: realflame.MAX_TEMP, minStep: 1 })
			.onGet(this.getTargetTemperature.bind(this))
			.onSet(this.setTargetTemperature.bind(this));

		this.service.getCharacteristic(this.hap.Characteristic.CurrentTemperature)
			.onGet(this.getCurrentTemperature.bind(this));

		this.service.getCharacteristic(this.hap.Characteristic.TemperatureDisplayUnits)
			.onGet(() => this.hap.Characteristic.TemperatureDisplayUnits.CELSIUS)
			.onSet(() => {});

		this._poll();
		this.pollTimer = setInterval(() => this._poll(), POLL_INTERVAL_MS);
	}

	_clampTemp(value) {
		return Math.max(realflame.MIN_TEMP, Math.min(realflame.MAX_TEMP, value));
	}

	async _poll() {
		try {
			const status = await realflame.getStatus(this.ip);
			this.lastStatus = status;
			this.targetTemperature = this._clampTemp(status.tempSetting);

			const isOn = status.opState !== realflame.MODE_OFF;
			this.service.getCharacteristic(this.hap.Characteristic.TargetHeatingCoolingState).updateValue(isOn ? 1 : 0);
			this.service.getCharacteristic(this.hap.Characteristic.CurrentHeatingCoolingState).updateValue(isOn ? 1 : 0);
			this.service.getCharacteristic(this.hap.Characteristic.TargetTemperature).updateValue(this.targetTemperature);
			this.service.getCharacteristic(this.hap.Characteristic.CurrentTemperature).updateValue(status.tempReading);
		} catch (err) {
			this.log.debug(`Real Flame poll failed: ${err.message}`);
		}
	}

	async getTargetHeatingCoolingState() {
		const status = this.lastStatus || await realflame.getStatus(this.ip);
		return status.opState === realflame.MODE_OFF ? 0 : 1;
	}

	async getCurrentHeatingCoolingState() {
		return this.getTargetHeatingCoolingState();
	}

	async setTargetHeatingCoolingState(value) {
		const mode = value === 0 ? realflame.MODE_OFF : realflame.MODE_MANUAL_TEMP;
		await realflame.setState(this.ip, {
			mode,
			tempLevel: this._clampTemp(this.targetTemperature),
			flameLevel: realflame.MIN_FLAME,
		});
		await this._poll();
	}

	async getTargetTemperature() {
		if (this.lastStatus) {
			return this._clampTemp(this.lastStatus.tempSetting);
		}
		const status = await realflame.getStatus(this.ip);
		return this._clampTemp(status.tempSetting);
	}

	async setTargetTemperature(value) {
		this.targetTemperature = this._clampTemp(value);

		const currentlyOn = this.lastStatus && this.lastStatus.opState !== realflame.MODE_OFF;
		if (!currentlyOn) {
			// nothing to send yet -- this will be applied next time the unit is turned on
			return;
		}

		await realflame.setState(this.ip, {
			mode: realflame.MODE_MANUAL_TEMP,
			tempLevel: this.targetTemperature,
			flameLevel: realflame.MIN_FLAME,
		});
		await this._poll();
	}

	async getCurrentTemperature() {
		if (this.lastStatus) {
			return this.lastStatus.tempReading;
		}
		const status = await realflame.getStatus(this.ip);
		return status.tempReading;
	}
}

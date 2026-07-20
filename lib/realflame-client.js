'use strict';

// Protocol reverse-engineered from the "Real Flame Fire MKII" Android app
// (com.millec.realflamethermostatmkii, shared codebase across Millennium
// Electronics' various "MKII" fireplace/heater brands) and verified live
// against a real Real Flame WiFi Interface MKII unit.
//
// - discovery: UDP broadcast 'MWI070011' to port 3001, device replies on
//   port 3005 with a '07' message containing its name and MAC address
// - control: plain-text TCP on port 3000, one connection per request
//     status request:  'MWIL10'
//     status response: 'MWIL11,<tempSet>,<flameSet>,<unused>,<tempReading>,
//                        <state>,<opState>,<currentFlame>,<currentFan>,
//                        <timerSlot>,<timerDay>,<commsStatus>,<ledR>,<ledG>,<ledB>,'
//       (all fields are hex-encoded bytes)
//     set command:      'MWIL20' + hex(mode) + hex(tempLevel) + hex(flameLevel)
//                        + hex(day) + hex(hour) + hex(minute) + hex(second)
//                        + hex(ledR) + hex(ledG) + hex(ledB)
//     set response:      'MWIL2,' (ack)

const dgram = require('dgram');
const net = require('net');
const os = require('os');

const DISCOVERY_BROADCAST_PORT = 3001;
const DISCOVERY_REPLY_PORT = 3005;
const DISCOVERY_PAYLOAD = 'MWI070011';
const CONTROL_PORT = 3000;

const MODE_MANUAL_TEMP = 0;
const MODE_MANUAL_FLAME = 1;
const MODE_TIMER = 2;
const MODE_EX_MANAGED = 3;
const MODE_OFF = 4;

const MIN_TEMP = 10;
const MAX_TEMP = 35;
const MIN_FLAME = 1;
const MAX_FLAME = 7;

// computes the subnet broadcast address for every non-internal IPv4 interface,
// since a plain 255.255.255.255 broadcast doesn't reliably reach WiFi clients
// on every network -- the device only answered once we also tried the
// subnet-directed broadcast (eg. 10.0.1.255) in testing.
function getBroadcastAddresses() {
	const addresses = new Set(['255.255.255.255']);
	const interfaces = os.networkInterfaces();

	for (const name of Object.keys(interfaces)) {
		for (const iface of interfaces[name]) {
			if (iface.family === 'IPv4' && !iface.internal && iface.netmask) {
				const ipParts = iface.address.split('.').map(Number);
				const maskParts = iface.netmask.split('.').map(Number);
				const broadcastParts = ipParts.map((octet, i) => (octet | (~maskParts[i] & 0xFF)) & 0xFF);
				addresses.add(broadcastParts.join('.'));
			}
		}
	}

	return [...addresses];
}

// broadcasts the discovery payload and resolves with the first valid reply
function discover(timeoutMs = 5000) {
	return new Promise((resolve, reject) => {
		const socket = dgram.createSocket('udp4');
		let settled = false;

		const finish = (err, result) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			socket.close();
			if (err) {
				reject(err);
			} else {
				resolve(result);
			}
		};

		const timer = setTimeout(() => finish(new Error('RealFlame discovery timed out')), timeoutMs);

		socket.on('error', err => finish(err));

		socket.on('message', (msg, rinfo) => {
			const text = msg.toString('ascii');
			if (!text.startsWith('MWI')) {
				return;
			}

			const type = text.substring(3, 5);
			if (type !== '07' && type !== '05' && type !== '03') {
				return;
			}

			const fields = text.split(',');
			const result = { ip: rinfo.address };
			if (type === '07' && fields.length > 6) {
				result.name = fields[4];
				result.mac = fields[5];
			}

			finish(null, result);
		});

		socket.bind(DISCOVERY_REPLY_PORT, () => {
			socket.setBroadcast(true);
			const payload = Buffer.from(DISCOVERY_PAYLOAD, 'ascii');
			for (const address of getBroadcastAddresses()) {
				socket.send(payload, DISCOVERY_BROADCAST_PORT, address);
			}
		});
	});
}

// opens a fresh TCP connection, sends payload, and resolves with whatever
// text comes back (matches the app's own one-shot-per-request behaviour)
function sendTcpRequest(ip, payload, timeoutMs = 3000) {
	return new Promise((resolve, reject) => {
		let settled = false;
		let response = '';

		const finish = (err, result) => {
			if (settled) {
				return;
			}
			settled = true;
			socket.destroy();
			if (err) {
				reject(err);
			} else {
				resolve(result);
			}
		};

		const socket = net.createConnection({ host: ip, port: CONTROL_PORT }, () => {
			socket.write(payload);
		});

		socket.setTimeout(timeoutMs);
		socket.on('data', chunk => {
			response += chunk.toString('ascii');
		});
		socket.on('timeout', () => finish(new Error('RealFlame TCP request timed out')));
		socket.on('error', err => finish(err));
		socket.on('close', () => finish(response ? null : new Error('RealFlame TCP connection closed with no response'), response));
	});
}

function parseStatus(response) {
	const trimmed = response.trim();
	if (!trimmed.startsWith('MWIL1')) {
		throw new Error(`unexpected RealFlame status response: '${trimmed}'`);
	}

	const fields = trimmed.split(',');
	const hex = i => parseInt(fields[i], 16);

	return {
		tempSetting: hex(1),
		flameSetting: hex(2),
		tempReading: hex(4),
		state: hex(5),
		opState: hex(6),
		currentFlameSetting: hex(7),
		currentFanLevel: hex(8),
		autoTimerSlot: hex(9),
		autoTimerDay: hex(10),
		commsStatus: hex(11),
		ledRed: fields.length > 14 ? hex(12) * 2 : 0,
		ledGreen: fields.length > 14 ? hex(13) * 2 : 0,
		ledBlue: fields.length > 14 ? hex(14) * 2 : 0,
	};
}

function buildSetCommand({ mode, tempLevel, flameLevel, ledRed = 0, ledGreen = 0, ledBlue = 0 }) {
	const now = new Date();
	const javaDay = now.getDay(); // 0=Sun..6=Sat, matches java.util.Date.getDay()
	const dayByte = (javaDay - 1) & 0xFF;
	const hex2 = n => (n & 0xFF).toString(16).toUpperCase().padStart(2, '0');

	return 'MWIL20' +
		hex2(mode) +
		hex2(tempLevel) +
		hex2(flameLevel) +
		hex2(dayByte) +
		hex2(now.getHours()) +
		hex2(now.getMinutes()) +
		hex2(now.getSeconds()) +
		hex2(ledRed) +
		hex2(ledGreen) +
		hex2(ledBlue);
}

async function getStatus(ip) {
	const response = await sendTcpRequest(ip, 'MWIL10');
	return parseStatus(response);
}

async function setState(ip, state) {
	const command = buildSetCommand(state);
	const response = await sendTcpRequest(ip, command);
	if (!response.trim().startsWith('MWIL2')) {
		throw new Error(`unexpected RealFlame command response: '${response}'`);
	}
	return response;
}

module.exports = {
	discover,
	getStatus,
	setState,
	MODE_MANUAL_TEMP,
	MODE_MANUAL_FLAME,
	MODE_TIMER,
	MODE_EX_MANAGED,
	MODE_OFF,
	MIN_TEMP,
	MAX_TEMP,
	MIN_FLAME,
	MAX_FLAME,
};

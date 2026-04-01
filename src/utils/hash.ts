const BASE64_URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const SHORT_HASH_BYTE_LENGTH = 8;

const SHA256_INITIAL_STATE = new Uint32Array([
	0x6a09e667,
	0xbb67ae85,
	0x3c6ef372,
	0xa54ff53a,
	0x510e527f,
	0x9b05688c,
	0x1f83d9ab,
	0x5be0cd19,
]);

const SHA256_ROUND_CONSTANTS = new Uint32Array([
	0x428a2f98,
	0x71374491,
	0xb5c0fbcf,
	0xe9b5dba5,
	0x3956c25b,
	0x59f111f1,
	0x923f82a4,
	0xab1c5ed5,
	0xd807aa98,
	0x12835b01,
	0x243185be,
	0x550c7dc3,
	0x72be5d74,
	0x80deb1fe,
	0x9bdc06a7,
	0xc19bf174,
	0xe49b69c1,
	0xefbe4786,
	0x0fc19dc6,
	0x240ca1cc,
	0x2de92c6f,
	0x4a7484aa,
	0x5cb0a9dc,
	0x76f988da,
	0x983e5152,
	0xa831c66d,
	0xb00327c8,
	0xbf597fc7,
	0xc6e00bf3,
	0xd5a79147,
	0x06ca6351,
	0x14292967,
	0x27b70a85,
	0x2e1b2138,
	0x4d2c6dfc,
	0x53380d13,
	0x650a7354,
	0x766a0abb,
	0x81c2c92e,
	0x92722c85,
	0xa2bfe8a1,
	0xa81a664b,
	0xc24b8b70,
	0xc76c51a3,
	0xd192e819,
	0xd6990624,
	0xf40e3585,
	0x106aa070,
	0x19a4c116,
	0x1e376c08,
	0x2748774c,
	0x34b0bcb5,
	0x391c0cb3,
	0x4ed8aa4a,
	0x5b9cca4f,
	0x682e6ff3,
	0x748f82ee,
	0x78a5636f,
	0x84c87814,
	0x8cc70208,
	0x90befffa,
	0xa4506ceb,
	0xbef9a3f7,
	0xc67178f2,
]);

export function hashUtf8ToBase64Url64(value: string): string {
	const digest = sha256(new TextEncoder().encode(value));
	return encodeBase64Url(digest.subarray(0, SHORT_HASH_BYTE_LENGTH));
}

function sha256(message: Uint8Array): Uint8Array {
	const paddedLength = Math.ceil((message.length + 9) / 64) * 64;
	const padded = new Uint8Array(paddedLength);
	padded.set(message);
	padded[message.length] = 0x80;

	const bitLengthHigh = Math.floor(message.length / 0x20000000);
	const bitLengthLow = (message.length << 3) >>> 0;
	writeUint32BigEndian(padded, padded.length - 8, bitLengthHigh);
	writeUint32BigEndian(padded, padded.length - 4, bitLengthLow);

	const state = new Uint32Array(SHA256_INITIAL_STATE);
	const schedule = new Uint32Array(64);

	for (let offset = 0; offset < padded.length; offset += 64) {
		for (let index = 0; index < 16; index += 1) {
			const wordOffset = offset + (index * 4);
			schedule[index] = (
				(padded[wordOffset]! << 24)
				| (padded[wordOffset + 1]! << 16)
				| (padded[wordOffset + 2]! << 8)
				| padded[wordOffset + 3]!
			) >>> 0;
		}

		for (let index = 16; index < 64; index += 1) {
			schedule[index] = (
				schedule[index - 16]!
				+ smallSigma0(schedule[index - 15]!)
				+ schedule[index - 7]!
				+ smallSigma1(schedule[index - 2]!)
			) >>> 0;
		}

		let a = state[0]!;
		let b = state[1]!;
		let c = state[2]!;
		let d = state[3]!;
		let e = state[4]!;
		let f = state[5]!;
		let g = state[6]!;
		let h = state[7]!;

		for (let index = 0; index < 64; index += 1) {
			const temp1 = (
				h
				+ bigSigma1(e)
				+ choose(e, f, g)
				+ SHA256_ROUND_CONSTANTS[index]!
				+ schedule[index]!
			) >>> 0;
			const temp2 = (bigSigma0(a) + majority(a, b, c)) >>> 0;

			h = g;
			g = f;
			f = e;
			e = (d + temp1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (temp1 + temp2) >>> 0;
		}

		state[0] = (state[0]! + a) >>> 0;
		state[1] = (state[1]! + b) >>> 0;
		state[2] = (state[2]! + c) >>> 0;
		state[3] = (state[3]! + d) >>> 0;
		state[4] = (state[4]! + e) >>> 0;
		state[5] = (state[5]! + f) >>> 0;
		state[6] = (state[6]! + g) >>> 0;
		state[7] = (state[7]! + h) >>> 0;
	}

	const digest = new Uint8Array(32);
	for (let index = 0; index < state.length; index += 1) {
		writeUint32BigEndian(digest, index * 4, state[index]!);
	}

	return digest;
}

function encodeBase64Url(bytes: Uint8Array): string {
	let output = "";

	for (let index = 0; index < bytes.length; index += 3) {
		const remaining = bytes.length - index;
		const byte0 = bytes[index]!;
		const byte1 = remaining > 1 ? bytes[index + 1]! : 0;
		const byte2 = remaining > 2 ? bytes[index + 2]! : 0;
		const chunk = (byte0 << 16) | (byte1 << 8) | byte2;

		output += BASE64_URL_ALPHABET[(chunk >>> 18) & 0x3f] ?? "";
		output += BASE64_URL_ALPHABET[(chunk >>> 12) & 0x3f] ?? "";
		if (remaining > 1) {
			output += BASE64_URL_ALPHABET[(chunk >>> 6) & 0x3f] ?? "";
		}
		if (remaining > 2) {
			output += BASE64_URL_ALPHABET[chunk & 0x3f] ?? "";
		}
	}

	return output;
}

function writeUint32BigEndian(target: Uint8Array, offset: number, value: number): void {
	target[offset] = (value >>> 24) & 0xff;
	target[offset + 1] = (value >>> 16) & 0xff;
	target[offset + 2] = (value >>> 8) & 0xff;
	target[offset + 3] = value & 0xff;
}

function choose(x: number, y: number, z: number): number {
	return (x & y) ^ (~x & z);
}

function majority(x: number, y: number, z: number): number {
	return (x & y) ^ (x & z) ^ (y & z);
}

function bigSigma0(value: number): number {
	return rotateRight(value, 2) ^ rotateRight(value, 13) ^ rotateRight(value, 22);
}

function bigSigma1(value: number): number {
	return rotateRight(value, 6) ^ rotateRight(value, 11) ^ rotateRight(value, 25);
}

function smallSigma0(value: number): number {
	return rotateRight(value, 7) ^ rotateRight(value, 18) ^ (value >>> 3);
}

function smallSigma1(value: number): number {
	return rotateRight(value, 17) ^ rotateRight(value, 19) ^ (value >>> 10);
}

function rotateRight(value: number, bits: number): number {
	return (value >>> bits) | (value << (32 - bits));
}

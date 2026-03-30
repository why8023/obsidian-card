import { existsSync, readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
const releaseTag = process.env.GITHUB_REF_NAME ?? process.argv[2] ?? manifest.version;

if (!/^\d+\.\d+\.\d+$/.test(releaseTag)) {
	throw new Error(`Release tag must be plain SemVer without a leading "v": ${releaseTag}`);
}

if (manifest.version !== releaseTag) {
	throw new Error(`manifest.json version ${manifest.version} does not match release tag ${releaseTag}.`);
}

if (typeof manifest.minAppVersion !== "string" || manifest.minAppVersion.length === 0) {
	throw new Error("manifest.json must define minAppVersion.");
}

if (versions[manifest.version] !== manifest.minAppVersion) {
	throw new Error(
		`versions.json entry for ${manifest.version} must equal manifest minAppVersion ${manifest.minAppVersion}.`,
	);
}

for (const requiredAsset of ["manifest.json", "main.js"]) {
	if (!existsSync(requiredAsset)) {
		throw new Error(`Missing required release asset: ${requiredAsset}`);
	}
}

import { existsSync, readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const versions = JSON.parse(readFileSync("versions.json", "utf8"));

function resolveReleaseTag() {
	const explicitTag = process.argv[2]?.trim();
	if (explicitTag) {
		return explicitTag;
	}

	const githubRef = process.env.GITHUB_REF?.trim() ?? "";
	if (githubRef.startsWith("refs/tags/")) {
		return githubRef.slice("refs/tags/".length);
	}

	if (process.env.GITHUB_REF_TYPE === "tag") {
		return process.env.GITHUB_REF_NAME?.trim() ?? "";
	}

	return manifest.version;
}

const releaseTag = resolveReleaseTag().replace(/^refs\/tags\//, "").trim();
const semverMatch = /^v?(\d+\.\d+\.\d+)$/.exec(releaseTag);

if (!semverMatch) {
	throw new Error(`Release tag must be SemVer, optionally prefixed with "v": ${releaseTag}`);
}

const normalizedReleaseTag = semverMatch[1];

if (manifest.version !== normalizedReleaseTag) {
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

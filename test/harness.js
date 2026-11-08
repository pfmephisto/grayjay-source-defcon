// Smoke test: loads DefconScript.js with stubbed Grayjay globals and live HTTP (via curl).
// Usage: [PLATFORM=android] node test/harness.js [year ...]
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let requests = 0;
const http = {
	GET(url, headers, auth, bytes) {
		requests++;
		const args = ['-sSL', '--fail', '-m', '60'];
		for (const [k, v] of Object.entries(headers || {})) args.push('-H', `${k}: ${v}`);
		args.push(url);
		try {
			const buf = execFileSync('curl', args, { maxBuffer: 1 << 28 });
			return { isOk: true, code: 200, body: bytes ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) : buf.toString('utf8') };
		} catch (e) {
			return { isOk: false, code: 404, body: bytes ? new ArrayBuffer(0) : '' };
		}
	},
};
class Plain { constructor(o) { Object.assign(this, o); } }
class Pager { constructor(results, hasMore) { this.results = results; this.hasMore = hasMore; } }
class Pos { constructor(...a) { this.args = a; } }
class DashVideoBase { constructor(o) { this.name = o.name; this.codec = o.codec; this.duration = o.duration; this.url = o.url; } }
class DashAudioBase { constructor(o) { this.name = o.name; this.codec = o.codec; this.duration = o.duration; this.url = o.url; } }
class UnMux { constructor(v, a) { this.videoSources = v; this.audioSources = a; } }
const ctx = {
	source: {}, http, console, bridge: { buildPlatform: process.env.PLATFORM || 'desktop', log() {} },
	ScriptException: class extends Error {},
	PlatformID: Pos, Thumbnail: Pos, Thumbnails: Pos, PlatformAuthorLink: Pos, RatingLikes: Pos, ResultCapabilities: Pos,
	Type: { Feed: { Mixed: 'm' }, Order: { Chronological: 'c' } },
	PlatformVideo: Plain, PlatformVideoDetails: Plain, PlatformChannel: Plain, VideoUrlSource: Plain, VideoSourceDescriptor: Plain,
	DashManifestRawSource: DashVideoBase, DashManifestRawAudioSource: DashAudioBase, UnMuxVideoSourceDescriptor: UnMux,
	VideoPager: Pager, ChannelPager: Pager, ContentPager: Pager, CommentPager: Pager,
	Uint8Array, DataView, Float64Array, Uint32Array, Int32Array, ArrayBuffer,
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'DefconScript.js'), 'utf8') + '\n;this.__ns = { loadTalks, listConferences };', ctx);
const s = ctx.source;
s.enable({ id: 'test-id' }, {});

const years = process.argv.slice(2).map(Number);
let fail = 0;
const check = (ok, msg) => { if (!ok) { fail++; console.log('FAIL', msg); } else console.log('ok  ', msg); };
const desktop = ctx.bridge.buildPlatform === 'desktop';

const home = s.getHome();
check(home.results.length > 0 && home.hasMore, `home page 1: ${home.results.length} talks, e.g. "${home.results[0]?.name}"`);
const confs = ctx.__ns.listConferences();
check(confs.length >= 30 && confs[0].n > confs[confs.length - 1].n, `conferences: ${confs.length}, newest DEF CON ${confs[0].n}`);

for (const n of years) {
	const url = `https://media.defcon.org/DEF%20CON%20${n}/`;
	check(s.isChannelUrl(url), `isChannelUrl DEF CON ${n}`);
	const ch = s.getChannel(url);
	const talks = s.getChannelContents(url).results;
	if (!talks.length) { console.log(`skip DEF CON ${n}: no video folder (audio-only year)`); continue; }
	check(talks.length > 5, `DEF CON ${n}: ${talks.length} talks (thumbnail: ${String(ch.thumbnail).slice(-24)})`);
	const t = talks[Math.floor(talks.length / 2)];
	check(s.isContentDetailsUrl(t.url), `isContentDetailsUrl ${t.url.slice(-60)}`);
	const d = s.getContentDetails(t.url);
	const q = d.name.split(/\s+/).find((w) => w.length > 5) || d.name;
	check(s.searchChannelContents(url, q).results.length >= 1, `searchChannelContents "${q}"`);
	check(d.subtitles.every((x) => typeof x.getSubtitles === 'function'), `subtitles are plugin-fetched (${d.subtitles.length})`);
	if (desktop) {
		const v = d.video.videoSources && d.video.videoSources[0];
		const isDash = d.video.audioSources && d.video.audioSources.length === 1;
		check(isDash, `DEF CON ${n}: Desktop gets a generated stream (${v && v.name}, dur=${d.duration}s)`);
		if (isDash) {
			const vx = v.getRequestExecutor(), ax = d.video.audioSources[0].getRequestExecutor();
			const init = vx.executeRequest('https://grayjay.internal/video/init.mp4', {});
			const seg = vx.executeRequest('https://grayjay.internal/video/seg-2.m4s', {});
			const aseg = ax.executeRequest('https://grayjay.internal/audio/seg-2.m4s', {});
			const tag = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
			check(tag(init, 4) === 'ftyp' && tag(seg, 4) === 'moof' && tag(aseg, 4) === 'moof', `init=${init.length}B video seg=${seg.length}B audio seg=${aseg.length}B`);
			check(/<SegmentTimeline><S /.test(v.generate()) && /mimeType="video\/mp4"/.test(v.generate()), 'manifest has a timeline');
		}
	} else {
		let status = '?';
		try { status = execFileSync('curl', ['-sSIL', '-o', '/dev/null', '-w', '%{http_code}', '-m', '30', d.url], { encoding: 'utf8' }); } catch (e) {}
		check(status === '200', `HEAD ${status} for "${d.name.slice(0, 60)}"`);
	}
}
console.log(`requests: ${requests}; failures: ${fail}`);
process.exit(fail ? 1 : 0);

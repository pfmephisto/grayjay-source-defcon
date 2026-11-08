// media.defcon.org plugin for Grayjay
//
// The site is a plain nginx "fancyindex" directory listing, so there is no API: talks come from scraping
// each conference's "video" folder. (The per-conference podcast feeds under "DEF CON rss/" are not
// used: their enclosure URLs predate a file rename and 404.) One conference == one Grayjay channel.
// Talks have no per-video thumbnail, so the conference logo stands in.

const PLATFORM = 'DEF CON Media';
const BASE_URL = 'https://media.defcon.org';
const VIDEO_EXT = /\.(mp4|m4v|mkv|webm|mov)$/i;

let _config = {};
let _settings = {};

// In-memory caches. The server states it has limited bandwidth, so every listing is fetched once.
let _conferences = null; // [{ n, name, url }] newest first
const _talkCache = {}; // n -> [talk]
const _captionCache = {}; // n -> { basename: [subtitle] }

// Lifecycle

source.enable = function (conf, settings) {
	_config = conf;
	_settings = settings ?? {};
};
source.disable = function () {};
source.saveState = function () {
	return '';
};

// Capabilities

const BASIC_CAPS = function () {
	return new ResultCapabilities([Type.Feed.Mixed], [Type.Order.Chronological], []);
};
source.getSearchCapabilities = BASIC_CAPS;
source.getSearchChannelContentsCapabilities = BASIC_CAPS;
source.getChannelCapabilities = BASIC_CAPS;

// Home / search

source.getHome = function () {
	return new DefconTalkPager(listConferences(), null, 0);
};
source.searchSuggestions = function () {
	return [];
};
source.search = function (query) {
	return new DefconTalkPager(listConferences(), query, 0);
};
source.searchChannels = function (query) {
	var q = (query || '').toLowerCase();
	var confs = listConferences().filter(function (c) {
		return c.name.toLowerCase().indexOf(q) !== -1;
	});
	return new ChannelPager(
		confs.map(function (c) {
			return mapConferenceToChannel(c, true);
		}),
		false,
	);
};
source.searchChannelContents = function (channelUrl, query) {
	var n = conferenceNumberFromUrl(channelUrl);
	if (n === null) throw new ScriptException('Invalid conference URL');
	var q = (query || '').toLowerCase();
	var talks = loadTalks(n).filter(function (t) {
		return t.title.toLowerCase().indexOf(q) !== -1 || t.description.toLowerCase().indexOf(q) !== -1;
	});
	return new VideoPager(talks.map(mapTalkToVideo), false);
};

// Channels

source.isChannelUrl = function (url) {
	return conferenceNumberFromUrl(url) !== null && !VIDEO_EXT.test(url);
};

source.getChannel = function (url) {
	var n = conferenceNumberFromUrl(url);
	if (n === null) throw new ScriptException('Invalid conference URL: ' + url);
	return mapConferenceToChannel({ n: n, name: 'DEF CON ' + n, url: conferenceUrl(n) });
};

source.getChannelContents = function (url) {
	var n = conferenceNumberFromUrl(url);
	if (n === null) throw new ScriptException('Invalid conference URL: ' + url);
	return new VideoPager(loadTalks(n).map(mapTalkToVideo), false);
};

// Content details

source.isContentDetailsUrl = function (url) {
	return url.indexOf('media.defcon.org/') !== -1 && VIDEO_EXT.test(stripQuery(url));
};

source.getContentDetails = function (url) {
	url = normalizeUrl(url);
	var n = conferenceNumberFromUrl(url);
	var talk = null;
	if (n !== null) {
		var talks = loadTalks(n);
		for (var i = 0; i < talks.length; i++) {
			if (talks[i].url === url) {
				talk = talks[i];
				break;
			}
		}
	}
	if (!talk) talk = talkFromFile(n, url, 0, 0, '');

	var dash = null;
	if (isDesktop()) {
		try {
			dash = dashDescriptor(talk);
		} catch (e) {
			bridge.log('DEF CON: stream conversion unavailable, using the direct URL: ' + e);
		}
	}
	if (dash && !talk.duration) talk.duration = dash.duration;
	var info = n !== null ? transcriptInfo(n, talk.url) : null;
	if (info && info.duration) talk.duration = info.duration;
	if (info && info.excerpt) talk.description += '\n\nTranscript (auto-generated, excerpt):\n' + info.excerpt + '…';
	var logo = n !== null ? conferenceLogo(n) : '';
	var details = new PlatformVideoDetails({
		id: new PlatformID(PLATFORM, talk.url, _config.id),
		name: talk.title,
		thumbnails: new Thumbnails(logo ? [new Thumbnail(logo, 720)] : [new Thumbnail('', 0)]),
		author: authorLink(n),
		datetime: talk.datetime,
		duration: talk.duration,
		viewCount: 0,
		url: talk.url,
		shareUrl: talk.url,
		isLive: false,
		description: talk.description,
		video: dash ? dash.descriptor : new VideoSourceDescriptor([
			new VideoUrlSource({
				url: talk.url,
				name: videoLabel(talk),
				width: n !== null && n >= 25 ? 1920 : 0, // 1080p confirmed for DEF CON 27 and 33; older years vary
				height: n !== null && n >= 25 ? 1080 : 0,
				container: containerFor(talk.url),
				codec: 'av1', // every sampled file (DEF CON 9-33) is AV1 video + Opus audio in MP4
				bitrate: talk.size && talk.duration ? Math.round((talk.size * 8) / talk.duration) : 0,
				duration: talk.duration,
			}),
		]),
		rating: new RatingLikes(0),
		subtitles: n !== null ? subtitlesFor(n, talk.url) : [],
	});

	if (n !== null) {
		var self = talk.url;
		details.getContentRecommendations = function () {
			var siblings = loadTalks(n).filter(function (t) {
				return t.url !== self;
			});
			shuffle(siblings);
			return new ContentPager(siblings.slice(0, 25).map(mapTalkToVideo), false);
		};
	}
	return details;
};

source.getComments = function () {
	return new CommentPager([], false);
};
source.getSubComments = function () {
	return new CommentPager([], false);
};

// Pagers: one conference per page, newest first. With a query, keep going until something matches.

class DefconTalkPager extends VideoPager {
	constructor(confs, query, index) {
		var results = [];
		var i = index;
		var q = query ? query.toLowerCase() : null;
		while (i < confs.length && results.length === 0) {
			var talks = loadTalks(confs[i].n);
			if (q) {
				talks = talks.filter(function (t) {
					return t.title.toLowerCase().indexOf(q) !== -1 || t.description.toLowerCase().indexOf(q) !== -1;
				});
			}
			results = results.concat(talks);
			i++;
		}
		super(results.map(mapTalkToVideo), i < confs.length);
		this._confs = confs;
		this._query = query;
		this._index = i;
	}
	nextPage() {
		return new DefconTalkPager(this._confs, this._query, this._index);
	}
}

// Conference discovery

function conferenceUrl(n) {
	return BASE_URL + '/' + encodeURIComponent('DEF CON ' + n) + '/';
}

function listConferences() {
	if (_conferences) return _conferences;
	var entries = listDir(BASE_URL + '/');
	var confs = [];
	for (var i = 0; i < entries.length; i++) {
		var m = entries[i].name.match(/^DEF CON (\d+)\/$/);
		if (m) confs.push({ n: parseInt(m[1], 10), name: 'DEF CON ' + m[1], url: conferenceUrl(m[1]) });
	}
	confs.sort(function (a, b) {
		return b.n - a.n;
	});
	_conferences = confs;
	return confs;
}

function conferenceNumberFromUrl(url) {
	var m = decodeURIComponentSafe(url).match(/media\.defcon\.org\/DEF CON (\d+)(?:\/|$|\?|#)/);
	return m ? parseInt(m[1], 10) : null;
}

function conferenceDatetime(n) {
	// DEF CON 1 was held in 1993, one per year since; August is close enough for ordering.
	return Math.floor(Date.UTC(1992 + n, 7, 8) / 1000);
}

// Thumbnails and channel icons are the conference logos on media.defcon.org, and nothing else: no third-party
// service and nothing hosted elsewhere. Known limitation: Grayjay Desktop downloads thumbnails itself with an
// HTTP/1.1 client and gives plugins no say in it (video segments, by contrast, go through the plugin's
// RequestExecutor), and media.defcon.org resets every HTTP/1.1 connection, so Desktop cannot display them. They
// show up on clients whose image loader speaks HTTP/2, and on Desktop if either side changes.
const _serverLogoCache = {};

function isDesktop() {
	try {
		return typeof bridge !== 'undefined' && bridge.buildPlatform === 'desktop';
	} catch (e) {
		return false;
	}
}

// The logo file on media.defcon.org (PNG/JPEG preferred over WebP), or '' when the conference has none.
function serverLogo(n) {
	if (_serverLogoCache[n] !== undefined) return _serverLogoCache[n];
	var logo = '';
	try {
		var entries = listDir(conferenceUrl(n)).filter(function (e) {
			return /logo[^/]*\.(png|jpg|jpeg|webp)$/i.test(e.name);
		});
		entries.sort(function (a, b) {
			var wa = /\.webp$/i.test(a.name) ? 1 : 0;
			var wb = /\.webp$/i.test(b.name) ? 1 : 0;
			return wa - wb || a.name.length - b.name.length;
		});
		if (entries.length) logo = conferenceUrl(n) + encodeURIComponent(entries[0].name);
	} catch (e) {}
	_serverLogoCache[n] = logo;
	return logo;
}

// bulk: a list of every conference. Finding each logo costs one directory listing, so on Desktop, where the
// logo could not be displayed anyway, a bulk list skips them (no requests); everywhere else it resolves them.
function conferenceLogo(n, bulk) {
	if (isDesktop() && bulk) return '';
	return serverLogo(n);
}

function mapConferenceToChannel(conf, bulk) {
	var logo = conferenceLogo(conf.n, bulk);
	return new PlatformChannel({
		id: new PlatformID(PLATFORM, 'DEF CON ' + conf.n, _config.id),
		name: conf.name,
		thumbnail: logo,
		banner: logo,
		subscribers: 0,
		description: 'Recorded talks from ' + conf.name + ' (' + (1992 + conf.n) + ').',
		url: conferenceUrl(conf.n),
		links: { Website: 'https://defcon.org/' },
	});
}

function authorLink(n) {
	if (n === null) return new PlatformAuthorLink(new PlatformID(PLATFORM, 'defcon', _config.id), 'DEF CON', BASE_URL, '');
	return new PlatformAuthorLink(
		new PlatformID(PLATFORM, 'DEF CON ' + n, _config.id),
		'DEF CON ' + n,
		conferenceUrl(n),
		conferenceLogo(n),
	);
}

// Talks

function loadTalks(n) {
	if (_talkCache[n]) return _talkCache[n];
	var talks = [];
	talks = talksFromListing(n);
	talks.sort(function (a, b) {
		return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
	});
	_talkCache[n] = talks;
	return talks;
}

function talksFromListing(n) {
	var dir = findVideoDir(n);
	if (!dir) return [];
	var entries = listDir(dir);
	var talks = [];
	for (var i = 0; i < entries.length; i++) {
		var e = entries[i];
		if (!VIDEO_EXT.test(e.name)) continue;
		talks.push(talkFromFile(n, dir + encodeURIComponent(e.name), e.size, 0, e.name));
	}
	return talks;
}

// The video folder is "DEF CON N video and slides" (19+) or "DEF CON N video" (7-18); skip
// "video team" (B-roll) folders.
function findVideoDir(n) {
	var entries = listDir(conferenceUrl(n));
	var best = null;
	for (var i = 0; i < entries.length; i++) {
		var name = entries[i].name;
		if (name.charAt(name.length - 1) !== '/') continue;
		if (!/video/i.test(name) || /team|captions/i.test(name)) continue;
		if (/video and slides\/$/i.test(name) || !best) best = name;
	}
	return best ? conferenceUrl(n) + encodeURIComponent(best.slice(0, -1)) + '/' : null;
}

function talkFromFile(n, url, size, duration, fileName) {
	var file = fileName || decodeURIComponentSafe(url.substring(url.lastIndexOf('/') + 1));
	var title = file.replace(VIDEO_EXT, '');
	if (n !== null) title = title.replace(new RegExp('^DEF CON ' + n + '\\s*-\\s*'), '');
	return {
		url: url,
		title: title || file,
		description: 'File: ' + file + '\n\nSource: ' + url,
		size: size,
		duration: duration,
		datetime: n !== null ? conferenceDatetime(n) : 0,
	};
}

function mapTalkToVideo(t) {
	var n = conferenceNumberFromUrl(t.url);
	var logo = n !== null ? conferenceLogo(n) : '';
	return new PlatformVideo({
		id: new PlatformID(PLATFORM, t.url, _config.id),
		name: t.title,
		thumbnails: new Thumbnails(logo ? [new Thumbnail(logo, 720)] : [new Thumbnail('', 0)]),
		author: authorLink(n),
		datetime: t.datetime,
		duration: t.duration,
		viewCount: 0,
		url: t.url,
		isLive: false,
	});
}

function videoLabel(t) {
	var ext = (t.url.match(/\.([a-z0-9]+)(?:\?|$)/i) || [])[1] || 'mp4';
	var label = ext.toUpperCase() + ' (AV1)';
	if (t.size) label += ' ' + (t.size / 1048576).toFixed(0) + ' MiB';
	return label;
}

function containerFor(url) {
	var ext = (stripQuery(url).match(/\.([a-z0-9]+)$/i) || [])[1] || 'mp4';
	return { mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', mov: 'video/quicktime' }[ext.toLowerCase()] || 'video/mp4';
}

// Captions live in "<video folder> captions/" as "<basename>.<lang>.<ext>". They are Whisper auto-transcripts;
// which of vtt/srt/txt/tsv/json exist varies by year (DEF CON 34 has all, DEF CON 27 mostly srt+txt). Offer one
// track per language: VTT if present, else SRT.

const LANG_NAMES = { eng: 'English', deu: 'Deutsch', fra: 'Français', spa: 'Español' };

function captionIndex(n) {
	if (_captionCache[n]) return _captionCache[n];
	var map = {};
	try {
		var dir = findVideoDir(n);
		var sub = dir
			? listDir(dir).filter(function (e) {
					return /captions\/$/i.test(e.name);
				})[0]
			: null;
		if (sub) {
			var capDir = dir + encodeURIComponent(sub.name.slice(0, -1)) + '/';
			listDir(capDir).forEach(function (e) {
				var m = e.name.match(/^(.*?)(?:\.([a-z]{2,3}))?\.(vtt|srt)$/i);
				if (!m) return;
				var lang = (m[2] || '').toLowerCase();
				var ext = m[3].toLowerCase();
				var byLang = (map[m[1]] = map[m[1]] || {});
				// vtt wins over srt for the same language
				if (!byLang[lang] || ext === 'vtt') byLang[lang] = { url: capDir + encodeURIComponent(e.name), ext: ext, lang: lang };
			});
		}
	} catch (e) {}
	_captionCache[n] = map;
	return map;
}

function captionsFor(n, videoUrl) {
	var base = decodeURIComponentSafe(videoUrl.substring(videoUrl.lastIndexOf('/') + 1)).replace(VIDEO_EXT, '');
	var byLang = captionIndex(n)[base] || {};
	return Object.keys(byLang).map(function (k) {
		return byLang[k];
	});
}

const TS = /(?:\d+:)?\d+:\d+[.,]\d+/g;

// The .srt files are not all SubRip: DEF CON 27's use YouTube's SBV layout ("00:00:00.167,00:00:05.172" on its
// own line, no "-->"). Convert whatever we get to WebVTT so the player can parse it.
function toVtt(text) {
	text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
	if (/^WEBVTT/.test(text)) return text;
	var stamp = function (t) {
		return t.replace(',', '.');
	};
	var out = ['WEBVTT', ''];
	text.split('\n').forEach(function (line) {
		var sbv = line.match(/^(\d+:\d+:\d+[.,]\d+),(\d+:\d+:\d+[.,]\d+)$/);
		if (sbv) out.push(stamp(sbv[1]) + ' --> ' + stamp(sbv[2]));
		else if (line.indexOf('-->') !== -1) out.push(line.replace(/(\d),(\d)/g, '$1.$2'));
		else if (/^\d+$/.test(line.trim())) return; // SRT cue number
		else out.push(line);
	});
	return out.join('\n');
}

function subtitlesFor(n, videoUrl) {
	return captionsFor(n, videoUrl).map(function (c) {
		var url = c.url;
		var sub = {
			name: (LANG_NAMES[c.lang] || c.lang.toUpperCase() || 'Captions') + ' (auto-generated)',
			url: url,
			format: 'text/vtt',
			language: { eng: 'en', deu: 'de', fra: 'fr', spa: 'es' }[c.lang] || c.lang,
		};
		// Always fetched by the plugin: the app downloads subtitles with an HTTP/1.1 client, which the server resets.
		sub.getSubtitles = function () {
			return toVtt(fetchText(url));
		};
		return sub;
	});
}

// One fetch of the first caption file gives the real duration (last timestamp) and a transcript excerpt.
function transcriptInfo(n, videoUrl) {
	var caps = captionsFor(n, videoUrl);
	if (!caps.length) return null;
	try {
		var text = fetchText(caps[0].url);
		var stamps = text.match(TS);
		var duration = 0;
		if (stamps && stamps.length) {
			duration = Math.round(
				stamps[stamps.length - 1]
					.replace(',', '.')
					.split(':')
					.map(parseFloat)
					.reduce(function (a, p) {
						return a * 60 + p;
					}, 0),
			);
		}
		var lines = text
			.split(/\r?\n/)
			.map(function (l) {
				return l.replace(/^\uFEFF/, '').trim();
			})
			.filter(function (l) {
				return l && l !== 'WEBVTT' && !/^\d+$/.test(l) && !(l.match(TS) || []).length;
			});
		return { duration: duration, excerpt: lines.join(' ').replace(/\s+/g, ' ').slice(0, 900) };
	} catch (e) {
		return null;
	}
}

// ---------------------------------------------------------------------------------------------------------
// Progressive MP4 -> fragmented MP4, on the fly.
//
// media.defcon.org serves plain progressive MP4s (ftyp, moov, mdat; no sidx, no fragments) and sends
// "Cross-Origin-Resource-Policy: same-origin", so Grayjay Desktop's browser player cannot load them from the
// server directly. Desktop will, however, play a DashManifestRawSource whose segments come from a plugin
// RequestExecutor (that is how the YouTube plugin streams). So the plugin reads the file's index (moov, about
// 1 MB), describes it as DASH, and answers init/segment requests itself by fetching byte ranges of the
// original file and wrapping the samples in moof+mdat boxes. Nothing is stored or transcoded.
// ---------------------------------------------------------------------------------------------------------

const SEGMENT_SECONDS = 6;
const _mp4Cache = {};

function u32(b, o) {
	return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}
function i32(b, o) {
	return (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
}
function u64(b, o) {
	return u32(b, o) * 4294967296 + u32(b, o + 4);
}
function cc(b, o) {
	return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

function mp4Boxes(buf, start, end) {
	var out = [];
	var p = start;
	while (p + 8 <= end) {
		var size = u32(buf, p);
		var hdr = 8;
		if (size === 1) {
			size = u64(buf, p + 8);
			hdr = 16;
		} else if (size === 0) size = end - p;
		if (size < hdr || p + size > end) break;
		out.push({ type: cc(buf, p + 4), start: p, hdr: hdr, end: p + size, payload: p + hdr });
		p += size;
	}
	return out;
}
function mp4Child(buf, box, type) {
	var l = mp4Boxes(buf, box.payload, box.end);
	for (var i = 0; i < l.length; i++) if (l[i].type === type) return l[i];
	return null;
}

// --- box writers ---

function be32(n) {
	return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}
function be64(n) {
	return concatBytes([be32(Math.floor(n / 4294967296)), be32(n >>> 0)]);
}
function be16(n) {
	return new Uint8Array([(n >>> 8) & 255, n & 255]);
}
function concatBytes(parts) {
	var len = 0;
	for (var i = 0; i < parts.length; i++) len += parts[i].length;
	var out = new Uint8Array(len);
	var p = 0;
	for (i = 0; i < parts.length; i++) {
		out.set(parts[i], p);
		p += parts[i].length;
	}
	return out;
}
function str4(s) {
	return new Uint8Array([s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)]);
}
function zeros(n) {
	return new Uint8Array(n);
}
function mkBox(type, parts) {
	var body = concatBytes(parts);
	return concatBytes([be32(8 + body.length), str4(type), body]);
}
function mkFull(type, version, flags, parts) {
	return mkBox(type, [new Uint8Array([version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255])].concat(parts));
}
var IDENTITY_MATRIX = concatBytes([be32(0x00010000), be32(0), be32(0), be32(0), be32(0x00010000), be32(0), be32(0), be32(0), be32(0x40000000)]);

// --- parsing ---

function httpRange(url, start, end) {
	var r = http.GET(url, { Range: 'bytes=' + start + '-' + end }, false, true);
	if (!r.isOk) throw new ScriptException('HTTP ' + r.code + ' reading ' + url + ' bytes ' + start + '-' + end);
	return new Uint8Array(r.body);
}

// Returns the moov box bytes (including header) of a progressive MP4.
function mp4ReadMoov(url) {
	var head = httpRange(url, 0, 65535);
	var p = 0;
	for (var guard = 0; guard < 8; guard++) {
		var h = p + 16 <= head.length ? head.subarray(p, p + 16) : httpRange(url, p, p + 15);
		var size = u32(h, 0);
		var type = cc(h, 4);
		if (size === 1) size = u64(h, 8);
		if (size < 8) break;
		if (type === 'moov') {
			if (size > 64 * 1024 * 1024) throw new ScriptException('moov too large');
			return p + size <= head.length ? head.subarray(p, p + size) : httpRange(url, p, p + size - 1);
		}
		p += size;
	}
	throw new ScriptException('No moov box found (not a progressive MP4?)');
}

function parseTrack(buf, trak) {
	var tkhd = mp4Child(buf, trak, 'tkhd');
	var mdia = mp4Child(buf, trak, 'mdia');
	var mdhd = mdia && mp4Child(buf, mdia, 'mdhd');
	var hdlr = mdia && mp4Child(buf, mdia, 'hdlr');
	var minf = mdia && mp4Child(buf, mdia, 'minf');
	var stbl = minf && mp4Child(buf, minf, 'stbl');
	if (!tkhd || !mdhd || !hdlr || !minf || !stbl) return null;
	var tv = buf[tkhd.payload];
	var mv = buf[mdhd.payload];
	var track = {
		handler: cc(buf, hdlr.payload + 8),
		timescale: u32(buf, mdhd.payload + (mv === 1 ? 20 : 12)),
		width: u32(buf, tkhd.end - 8) / 65536,
		height: u32(buf, tkhd.end - 4) / 65536,
		hdlrBox: buf.subarray(hdlr.start, hdlr.end),
		dinfBox: null,
		mediaHeaderBox: null,
		stsdBox: null,
		entry: null,
		_tv: tv,
	};
	var dinf = mp4Child(buf, minf, 'dinf');
	if (dinf) track.dinfBox = buf.subarray(dinf.start, dinf.end);
	var mh = mp4Child(buf, minf, 'vmhd') || mp4Child(buf, minf, 'smhd');
	if (mh) track.mediaHeaderBox = buf.subarray(mh.start, mh.end);
	var stsd = mp4Child(buf, stbl, 'stsd');
	if (!stsd) return null;
	track.stsdBox = buf.subarray(stsd.start, stsd.end);
	var entryStart = stsd.payload + 8;
	track.entry = { type: cc(buf, entryStart + 4), start: entryStart, end: entryStart + u32(buf, entryStart) };

	var sttsB = mp4Child(buf, stbl, 'stts');
	var cttsB = mp4Child(buf, stbl, 'ctts');
	var stscB = mp4Child(buf, stbl, 'stsc');
	var stszB = mp4Child(buf, stbl, 'stsz');
	var stcoB = mp4Child(buf, stbl, 'stco');
	var co64B = mp4Child(buf, stbl, 'co64');
	var stssB = mp4Child(buf, stbl, 'stss');
	if (!sttsB || !stscB || !stszB || !(stcoB || co64B)) return null;

	var n = u32(buf, stszB.payload + 8);
	var fixed = u32(buf, stszB.payload + 4);
	var sizes = new Uint32Array(n);
	for (var i = 0; i < n; i++) sizes[i] = fixed || u32(buf, stszB.payload + 12 + i * 4);

	var durations = new Uint32Array(n);
	var dts = new Float64Array(n);
	var cnt = u32(buf, sttsB.payload + 4);
	var s = 0;
	var t = 0;
	for (i = 0; i < cnt; i++) {
		var c = u32(buf, sttsB.payload + 8 + i * 8);
		var d = u32(buf, sttsB.payload + 12 + i * 8);
		for (var k = 0; k < c && s < n; k++) {
			durations[s] = d;
			dts[s] = t;
			t += d;
			s++;
		}
	}
	var cto = new Int32Array(n);
	if (cttsB) {
		cnt = u32(buf, cttsB.payload + 4);
		s = 0;
		for (i = 0; i < cnt; i++) {
			var cc2 = u32(buf, cttsB.payload + 8 + i * 8);
			var off = i32(buf, cttsB.payload + 12 + i * 8);
			for (k = 0; k < cc2 && s < n; k++) cto[s++] = off;
		}
		track.hasCtts = true;
	}
	var sync = new Uint8Array(n);
	if (stssB) {
		cnt = u32(buf, stssB.payload + 4);
		for (i = 0; i < cnt; i++) sync[u32(buf, stssB.payload + 8 + i * 4) - 1] = 1;
	} else sync.fill(1);

	var chunkCount = u32(buf, (stcoB || co64B).payload + 4);
	var runs = u32(buf, stscB.payload + 4);
	var offsets = new Float64Array(n);
	s = 0;
	for (var r = 0; r < runs; r++) {
		var first = u32(buf, stscB.payload + 8 + r * 12);
		var per = u32(buf, stscB.payload + 12 + r * 12);
		var last = r + 1 < runs ? u32(buf, stscB.payload + 8 + (r + 1) * 12) - 1 : chunkCount;
		for (var ch = first; ch <= last; ch++) {
			var o = stcoB ? u32(buf, stcoB.payload + 8 + (ch - 1) * 4) : u64(buf, co64B.payload + 8 + (ch - 1) * 8);
			for (k = 0; k < per && s < n; k++) {
				offsets[s] = o;
				o += sizes[s];
				s++;
			}
		}
	}
	track.n = n;
	track.sizes = sizes;
	track.durations = durations;
	track.dts = dts;
	track.cto = cto;
	track.sync = sync;
	track.offsets = offsets;
	track.totalDuration = t;
	return track;
}

function av1CodecString(buf, entry) {
	// visual sample entry: 8 byte box header + 78 bytes, then child boxes (av1C ...)
	var kids = mp4Boxes(buf, entry.start + 8 + 78, entry.end);
	for (var i = 0; i < kids.length; i++) {
		if (kids[i].type === 'av1C') {
			var b1 = buf[kids[i].payload + 1];
			var b2 = buf[kids[i].payload + 2];
			var profile = b1 >> 5;
			var level = b1 & 31;
			var tier = b2 >> 7 ? 'H' : 'M';
			var depth = (b2 >> 5) & 1 ? 12 : (b2 >> 6) & 1 ? 10 : 8;
			return 'av01.' + profile + '.' + (level < 10 ? '0' : '') + level + tier + '.' + (depth < 10 ? '0' : '') + depth;
		}
	}
	return 'av01.0.08M.08';
}

// Cut points: video at keyframes roughly SEGMENT_SECONDS apart; audio at the first sample at or after each
// video cut time, so the two streams stay aligned within one audio frame.
function planSegments(video, audio) {
	var vcuts = [0];
	for (var i = 1; i < video.n; i++) {
		if (video.sync[i] && (video.dts[i] - video.dts[vcuts[vcuts.length - 1]]) / video.timescale >= SEGMENT_SECONDS) vcuts.push(i);
	}
	var acuts = [0];
	var a = 0;
	for (var j = 1; j < vcuts.length; j++) {
		var tv = video.dts[vcuts[j]] / video.timescale;
		while (a < audio.n && audio.dts[a] / audio.timescale < tv) a++;
		var ai = Math.min(a, audio.n);
		if (ai > acuts[acuts.length - 1]) acuts.push(ai);
	}
	return { video: vcuts, audio: acuts };
}

function mp4Model(url) {
	if (_mp4Cache[url]) return _mp4Cache[url];
	var buf = mp4ReadMoov(url);
	var moov = mp4Boxes(buf, 0, buf.length)[0];
	var video = null;
	var audio = null;
	mp4Boxes(buf, moov.payload, moov.end).forEach(function (b) {
		if (b.type !== 'trak') return;
		var t = parseTrack(buf, b);
		if (!t) return;
		if (t.handler === 'vide' && (!video || t.n > video.n)) video = t;
		else if (t.handler === 'soun' && (!audio || t.n > audio.n)) audio = t;
	});
	if (!video || !audio || video.n < 2) throw new ScriptException('Need one video and one audio track');
	if (video.entry.type !== 'av01') video.codec = video.entry.type;
	else video.codec = av1CodecString(buf, video.entry);
	audio.codec = audio.entry.type === 'Opus' ? 'opus' : 'mp4a.40.2';
	audio.sampleRate = audio.entry.type === 'Opus' ? 48000 : u32(buf, audio.entry.start + 8 + 24) >>> 16;
	[video, audio].forEach(function (t) {
		var bytes = 0;
		for (var i = 0; i < t.n; i++) bytes += t.sizes[i];
		t.bitrate = Math.max(1000, Math.round((bytes * 8) / (t.totalDuration / t.timescale)));
	});
	var plan = planSegments(video, audio);
	var model = { url: url, video: video, audio: audio, plan: plan, duration: Math.max(video.totalDuration / video.timescale, audio.totalDuration / audio.timescale) };
	_mp4Cache[url] = model;
	return model;
}

// --- init segment (ftyp + moov with empty sample tables) ---

function fmp4Init(track, isVideo) {
	var ftyp = mkBox('ftyp', [str4('iso5'), be32(512), str4('iso5'), str4('iso6'), str4('mp41'), str4('av01')]);
	var mvhd = mkFull('mvhd', 0, 0, [be32(0), be32(0), be32(1000), be32(0), be32(0x00010000), be16(0x0100), zeros(10), IDENTITY_MATRIX, zeros(24), be32(2)]);
	var tkhd = mkFull('tkhd', 0, 3, [
		be32(0), be32(0), be32(1), be32(0), be32(0), zeros(8), be16(0), be16(0), be16(isVideo ? 0 : 0x0100), be16(0), IDENTITY_MATRIX,
		be32(Math.round(track.width * 65536)), be32(Math.round(track.height * 65536)),
	]);
	var mdhd = mkFull('mdhd', 0, 0, [be32(0), be32(0), be32(track.timescale), be32(0), be16(0x55c4), be16(0)]);
	var stbl = mkBox('stbl', [
		track.stsdBox,
		mkFull('stts', 0, 0, [be32(0)]),
		mkFull('stsc', 0, 0, [be32(0)]),
		mkFull('stsz', 0, 0, [be32(0), be32(0)]),
		mkFull('stco', 0, 0, [be32(0)]),
	]);
	var dinf = track.dinfBox || mkBox('dinf', [mkFull('dref', 0, 0, [be32(1), mkFull('url ', 0, 1, [])])]);
	var minf = mkBox('minf', [track.mediaHeaderBox, dinf, stbl]);
	var mdia = mkBox('mdia', [mdhd, track.hdlrBox, minf]);
	var trak = mkBox('trak', [tkhd, mdia]);
	var trex = mkFull('trex', 0, 0, [be32(1), be32(1), be32(0), be32(0), be32(0)]);
	var moov = mkBox('moov', [mvhd, trak, mkBox('mvex', [trex])]);
	return concatBytes([ftyp, moov]);
}

// --- media segment: samples [a, b) of one track as moof + mdat ---

function fmp4Segment(url, track, isVideo, a, b, seq) {
	var count = b - a;
	var minOff = Infinity;
	var maxEnd = 0;
	var payloadSize = 0;
	for (var i = a; i < b; i++) {
		if (track.offsets[i] < minOff) minOff = track.offsets[i];
		if (track.offsets[i] + track.sizes[i] > maxEnd) maxEnd = track.offsets[i] + track.sizes[i];
		payloadSize += track.sizes[i];
	}
	var chunk = httpRange(url, minOff, maxEnd - 1);
	var perSample = track.hasCtts ? 16 : 12;
	var trunFlags = 0x000001 | 0x000100 | 0x000200 | 0x000400 | (track.hasCtts ? 0x000800 : 0);
	var trunSize = 12 + 8 + count * perSample;
	var moofSize = 8 + 16 + 8 + 16 + 20 + trunSize;
	var trun = new Uint8Array(trunSize);
	var dv = new DataView(trun.buffer);
	dv.setUint32(0, trunSize);
	trun.set(str4('trun'), 4);
	dv.setUint32(8, trunFlags); // version 0 in the top byte
	dv.setUint32(12, count);
	dv.setInt32(16, moofSize + 8);
	var payload = new Uint8Array(payloadSize);
	var p = 20;
	var w = 0;
	for (i = a; i < b; i++) {
		dv.setUint32(p, track.durations[i]);
		dv.setUint32(p + 4, track.sizes[i]);
		dv.setUint32(p + 8, !isVideo || track.sync[i] ? 0x02000000 : 0x01010000);
		if (track.hasCtts) {
			dv.setInt32(p + 12, track.cto[i]);
		}
		p += perSample;
		var from = track.offsets[i] - minOff;
		payload.set(chunk.subarray(from, from + track.sizes[i]), w);
		w += track.sizes[i];
	}
	// version 1 (signed composition offsets) when needed
	if (track.hasCtts) dv.setUint32(8, 0x01000000 | trunFlags);
	var mfhd = mkFull('mfhd', 0, 0, [be32(seq)]);
	var tfhd = mkFull('tfhd', 0, 0x020000, [be32(1)]);
	var tfdt = mkFull('tfdt', 1, 0, [be64(track.dts[a])]);
	var traf = mkBox('traf', [tfhd, tfdt, trun]);
	var moof = mkBox('moof', [mfhd, traf]);
	if (moof.length !== moofSize) throw new ScriptException('moof size mismatch ' + moof.length + ' vs ' + moofSize);
	return concatBytes([moof, be32(8 + payloadSize), str4('mdat'), payload]);
}

// --- DASH manifest ---

function isoDuration(sec) {
	var h = Math.floor(sec / 3600);
	var m = Math.floor((sec % 3600) / 60);
	var s = sec - h * 3600 - m * 60;
	return 'PT' + h + 'H' + m + 'M' + s.toFixed(3) + 'S';
}

// Grayjay rewrites every media/initialization attribute inside each <Representation> to its proxy, matching
// by stale offsets, so each representation carries trailing padding (YouTube's plugin does the same).
var MPD_PADDING = new Array(2400).join(' ');

function dashFor(model, kind) {
	var isVideo = kind === 'video';
	var track = isVideo ? model.video : model.audio;
	var cuts = isVideo ? model.plan.video : model.plan.audio;
	var timeline = '';
	for (var j = 0; j < cuts.length; j++) {
		var a = cuts[j];
		var b = j + 1 < cuts.length ? cuts[j + 1] : track.n;
		if (b <= a) continue;
		timeline += '<S t="' + track.dts[a] + '" d="' + (track.dts[b - 1] + track.durations[b - 1] - track.dts[a]) + '"/>';
	}
	var bandwidth = track.bitrate;
	var rep = isVideo
		? '<Representation id="1" mimeType="video/mp4" codecs="' + track.codec + '" startWithSAP="1" bandwidth="' + bandwidth + '" width="' + track.width + '" height="' + track.height + '">'
		: '<Representation id="2" mimeType="audio/mp4" codecs="' + track.codec + '" startWithSAP="1" bandwidth="' + bandwidth + '" audioSamplingRate="' + track.sampleRate + '">';
	var prefix = 'https://grayjay.internal/' + kind;
	return (
		'<?xml version="1.0" encoding="UTF-8"?>\n' +
		'<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-live:2011" minBufferTime="PT1.5S" type="static" mediaPresentationDuration="' + isoDuration(model.duration) + '">\n' +
		'<Period id="0" duration="' + isoDuration(model.duration) + '">\n' +
		'<AdaptationSet segmentAlignment="true"' + (isVideo ? '' : ' lang="und"') + '>\n' +
		rep + '\n' +
		'<SegmentTemplate timescale="' + track.timescale + '" startNumber="1" media="' + prefix + '/seg-$Number$.m4s" initialization="' + prefix + '/init.mp4">\n' +
		'<SegmentTimeline>' + timeline + '</SegmentTimeline>\n' +
		'</SegmentTemplate>\n' +
		MPD_PADDING + '\n' +
		'</Representation>\n' +
		'</AdaptationSet>\n' +
		'</Period>\n' +
		'</MPD>\n'
	);
}

// The executor Grayjay calls for every init/segment request of one stream.
function fmp4Executor(model, kind) {
	var isVideo = kind === 'video';
	var track = isVideo ? model.video : model.audio;
	var cuts = isVideo ? model.plan.video : model.plan.audio;
	return {
		executeRequest: function (url) {
			if (/init\.mp4/.test(url)) return fmp4Init(track, isVideo);
			var m = url.match(/seg-(\d+)\.m4s/);
			if (!m) throw new ScriptException('Unexpected segment request: ' + url);
			var idx = parseInt(m[1], 10) - 1;
			var a = cuts[idx];
			var b = idx + 1 < cuts.length ? cuts[idx + 1] : track.n;
			if (a === undefined || b <= a) throw new ScriptException('Segment out of range: ' + url);
			return fmp4Segment(model.url, track, isVideo, a, b, idx + 1);
		},
		cleanup: function () {},
	};
}

// Source classes. The engine calls generate() for the manifest and getRequestExecutor() for every segment.
var DefconDashVideo = null;
var DefconDashAudio = null;
if (typeof DashManifestRawSource !== 'undefined' && typeof DashManifestRawAudioSource !== 'undefined') {
	DefconDashVideo = class extends DashManifestRawSource {
		constructor(obj, model) {
			super(obj);
			// the base class does not copy these, but the engine requires them
			this.width = obj.width;
			this.height = obj.height;
			this.priority = obj.priority ?? false;
			this.container = 'video/mp4';
			this._model = model;
		}
		generate() {
			return dashFor(this._model, 'video');
		}
		getRequestExecutor() {
			return fmp4Executor(this._model, 'video');
		}
	};
	DefconDashAudio = class extends DashManifestRawAudioSource {
		constructor(obj, model) {
			super(obj);
			this.priority = obj.priority ?? false;
			this.container = 'audio/mp4';
			this._model = model;
		}
		generate() {
			return dashFor(this._model, 'audio');
		}
		getRequestExecutor() {
			return fmp4Executor(this._model, 'audio');
		}
	};
}

// Desktop only: a stream the app can proxy. Returns null when the file cannot be converted, so the caller
// falls back to the direct URL.
function dashDescriptor(talk) {
	if (!DefconDashVideo) return null;
	var model = mp4Model(talk.url);
	var duration = Math.round(model.duration);
	return {
		duration: duration,
		descriptor: new UnMuxVideoSourceDescriptor(
			[
				new DefconDashVideo(
					{ name: model.video.height + 'p AV1', url: talk.url, width: model.video.width, height: model.video.height, codec: model.video.codec, bitrate: model.video.bitrate, duration: duration, priority: true },
					model,
				),
			],
			[new DefconDashAudio({ name: 'Opus', url: talk.url, codec: model.audio.codec, bitrate: model.audio.bitrate, duration: duration, priority: true }, model)],
		),
	};
}

// Fancyindex parsing: rows look like
//   <a href="DEF%20CON%2032/" title="DEF CON 32">DEF CON 32/</a></td><td class="size">-</td>
// Absolute links (nav bar, footer) and "../" are skipped.

function listDir(url) {
	var html = fetchText(url);
	var re = /<a href="([^"]+)" title="[^"]*">[^<]*<\/a><\/td><td class="size">([^<]*)<\/td>/g;
	var out = [];
	var m;
	while ((m = re.exec(html))) {
		var href = m[1];
		if (/^[a-z]+:\/\//i.test(href) || href.indexOf('../') === 0 || href.charAt(0) === '/' || href.charAt(0) === '?') continue;
		out.push({ name: decodeURIComponentSafe(decodeEntities(href)), size: parseSize(m[2]) });
	}
	return out;
}

function parseSize(s) {
	var m = (s || '').trim().match(/^([\d.]+)\s*(B|KiB|MiB|GiB|TiB)$/);
	if (!m) return 0;
	return Math.round(parseFloat(m[1]) * { B: 1, KiB: 1024, MiB: 1048576, GiB: 1073741824, TiB: 1099511627776 }[m[2]]);
}

// Utilities

function fetchText(url) {
	var resp = http.GET(url, {});
	if (!resp.isOk) throw new ScriptException('HTTP ' + resp.code + ' for ' + url);
	return resp.body;
}

function decodeEntities(s) {
	return (s || '')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;|&#39;/g, "'")
		.replace(/&#(\d+);/g, function (_, d) {
			return String.fromCharCode(parseInt(d, 10));
		})
		.replace(/&amp;/g, '&');
}

// Make a URL fetchable: https, with path segments percent-encoded.
function normalizeUrl(url) {
	url = url.replace(/^http:\/\/media\.defcon\.org/, 'https://media.defcon.org');
	if (url.indexOf('%') === -1 || /\s/.test(url)) {
		var i = url.indexOf('/', 'https://'.length);
		url = url.substring(0, i) + url.substring(i).split('/').map(function (seg) {
			return seg.indexOf('%') === -1 ? encodeURIComponent(seg) : seg;
		}).join('/');
	}
	return url;
}

function stripQuery(url) {
	return url.split('?')[0].split('#')[0];
}

function decodeURIComponentSafe(s) {
	try {
		return decodeURIComponent(s);
	} catch (e) {
		return s;
	}
}

function shuffle(a) {
	for (var i = a.length - 1; i > 0; i--) {
		var j = Math.floor(Math.random() * (i + 1));
		var t = a[i];
		a[i] = a[j];
		a[j] = t;
	}
}

#!/usr/bin/env node
console.log(process.version);
const crypto = require('crypto');
const fs = require('fs');
const {readFileSync} = fs;
const readline = require('readline');
const sanitizeFilename = require('sanitize-filename');
const ID3Writer = require('browser-id3-writer');
const {join} = require('path');
const {promisify} = require('util');
const prompt = require('prompt');
const ask = promisify(prompt.get);
const request = require('request').defaults({
	jar: true,
	headers: {
		'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/62.0.3202.75 Safari/537.36',
		'Content-Language': 'en-US',
		'Cache-Control': 'max-age=0',
		'Accept': '*/*',
		'Accept-Charset': 'utf-8,ISO-8859-1;q=0.7,*;q=0.3',
		'Accept-Language': 'de-DE,de;q=0.8,en-US;q=0.6,en;q=0.4'
	}
});
const apiUrl = 'http://www.deezer.com/ajax/gw-light.php';
const apiQueries = {
	api_version: '1.0',
	api_token: 'null',
	input: '3'
};

const choose = async (arr, stringifyFunc=id) => {
	for(let i = 0; i < arr.length; i++){
		console.log(i + ') ' + stringifyFunc(arr[i]));
	}
	const i = (await ask('number')).number;
	
	if(i >= arr.length){
		throw new Error('Given index is not defined!');
	}
	return arr[i];
};

const fetch = opts => new Promise((resolve, reject) => {
	request(opts, (err, resp, body) => {
		if(err){
			reject(err);
		}else{
			resolve(body);
		}
	});
});

const getBuffer = url => fetch({url, encoding:null});

const login = (mail, password) => new Promise((resolve, reject) => {
	request.get({url: apiUrl, qs: Object.assign({method:'deezer.getUserData'}, apiQueries), json: true}, (function(err, res, body) {
  		if(!err && res.statusCode == 200) {
			apiQueries.api_token = body.results.checkForm;
			request.post({url: 'https://www.deezer.com/ajax/action.php', form: {type:'login',mail,password,checkFormLogin:body.results.checkFormLogin}}, (function(err, res, body) {
				if(err || res.statusCode != 200) {
					reject(new Error('Unable to load deezer.com'));
				}else if(body.indexOf('success') > -1){
					resolve();
				}else{
					reject(new Error('Incorrect email or password.'));
				}
			}));
		} else {
			reject(new Error('Unable to load deezer.com'));
		}
	}));
});

const getBlowfishKey = trackInfos => {
	const SECRET = 'g4el58wc0zvf9na1';

	const idMd5 = crypto.createHash('md5').update(trackInfos.SNG_ID, 'ascii').digest('hex');
	let bfKey = '';

	for(let i = 0; i < 16; i++){
		bfKey += String.fromCharCode(idMd5.charCodeAt(i) ^ idMd5.charCodeAt(i + 16) ^ SECRET.charCodeAt(i));
	}

	return bfKey;
};

const getTrackUrl = (trackInfos, fileFormat) => {
	const step1 = [trackInfos.MD5_ORIGIN, fileFormat, trackInfos.SNG_ID, trackInfos.MEDIA_VERSION].join('¤');

	let step2 = crypto.createHash('md5').update(step1, 'ascii').digest('hex')+'¤'+step1+'¤';
	while(step2.length%16 > 0 ) step2 += ' ';

	const step3 = crypto.createCipheriv('aes-128-ecb','jo6aey6haid2Teih', '').update(step2, 'ascii', 'hex');
	const cdn = trackInfos.MD5_ORIGIN[0]; // random number between 0 and f
	
	return 'http://e-cdn-proxy-' + cdn + '.deezer.com/mobile/1/' + step3;
};

const streamTrack = (trackInfos, url, bfKey, stream) => new Promise((resolve, reject) => {
	request.get({url, encoding: null}, function(err, res, body) {
		if(res.statusCode !== 200){
			return reject(new Error('not OK'));
		}

		const source = Buffer.from(body, 'binary');
		console.log(source.length);

		let i = 0;
		let position = 0;

		const destBuffer = Buffer.alloc(source.length);
		
		while(position < source.length) {
			var chunk;
			if ((source.length - position) >= 2048) {
				chunk_size = 2048;
			} else {
				chunk_size = source.length - position;
			}
			chunk = Buffer.alloc(chunk_size);
			source.copy(chunk, 0, position, position + chunk_size);
			if(i % 3 > 0 || chunk_size < 2048){
				//Do nothing
			}else{
				var cipher = crypto.createDecipheriv('bf-cbc', bfKey, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
				cipher.setAutoPadding(false);
				chunk = cipher.update(chunk, 'binary', 'binary') + cipher.final();
			}
			destBuffer.write(chunk.toString('binary'), position, 'binary');
			position += chunk_size;
			i++;
		}
		
		stream.write(destBuffer);
		stream.end();
		stream.on('close', resolve);
	});
});



const getTrackInfos = trackId =>
	fetch('https://www.deezer.com/track/'  + trackId)
		.then(htmlString => {
			const PLAYER_INIT = htmlString.match(/__DZR_APP_STATE__\s*=\s*({.+?})\s*<\/script>/);
			try{
				return JSON.parse(PLAYER_INIT[1]).DATA;
			}catch(err){
				return undefined;
			}
		});

const getMetadata = async (trackInfos, albumData) => {
	const coverImageBuffer = await getBuffer(albumData.cover_xl).catch(() => undefined);

	const metadata = {
		TIT2: (trackInfos.SNG_TITLE + ' ' + trackInfos.VERSION).trim(),
		TALB: albumData.title,
		TPE1: trackInfos.ARTISTS.map(ARTIST => ARTIST.ART_NAME),
		TPE2: albumData.artist.name,
		TCOM: trackInfos.SNG_CONTRIBUTORS.composer || [],
		TCON: albumData.genres.data.map(genre => genre.name),
		TPOS: trackInfos.DISK_NUMBER,
		TRCK: trackInfos.TRACK_NUMBER + '/' + albumData.tracks.data.length,
		TYER: parseInt(trackInfos.PHYSICAL_RELEASE_DATE),
		TPUB: albumData.label
	};

	if(coverImageBuffer){
		metadata.APIC = {
			type: 3,
			data: coverImageBuffer,
			description: (albumData.title.replace(/[^\w\s]/g, '').trim() + ' cover image').trim()
		};
	}

	return metadata;
};



const downloadTrack = async track => {
	readline.clearLine(process.stdout, 0);
	readline.cursorTo(process.stdout, 0);
	
	const basicArtist = track.artist.name;
	const basicTitle = track.title;
	
	const basicFilename = sanitizeFilename(basicArtist + ' - ' + basicTitle);
	const extensions = ['mp3', 'flac'];
	const filenames = extensions.map(extension => basicFilename + '.' + extension);
	const existsFilename = filenames.find(fs.existsSync);

	if(existsFilename){
		process.stdout.write(existsFilename + ' already exists. Skipping...\n');
		return;
	}

	process.stdout.write('Fetching track data...');
	const trackInfos = await getTrackInfos(track.id).catch(err => {
		if(typeof track.alternative === 'object'){
			return getTrackInfos(track.alternative.id);
		}else{
			throw err;
		}
	}).catch(() => {
		process.stdout.write('\rError occured on track info fetching! Track ID: ' + track.id + '\n');
	});
	
	if(typeof trackInfos === 'undefined') return;
	process.stdout.write('\rFetching album data...');
	const albumData = await fetch('https://api.deezer.com/album/' + trackInfos.ALB_ID).then(JSON.parse).catch(() => { process.stdout.write('\rError occured on album data fetching! Track ID: ' + track.id + '\n'); });
	if(typeof albumData === 'undefined') return;
	process.stdout.write('\rExtracting fetched metadata...');
	const metadata = await getMetadata(trackInfos, albumData).catch(console.error);
	if(typeof metadata === 'undefined') return;
	readline.clearLine(process.stdout, 0);
	const mainArtist = metadata.TPE1.includes(metadata.TPE2) ? metadata.TPE2 : metadata.TPE1[0];

	process.stdout.write('\r' + basicArtist + ' - ' + basicTitle + '\n');
	
	const format =
		(flac && trackInfos.FILESIZE_FLAC) ? 9 :
		(trackInfos.FILESIZE_MP3_320) ? 3 :
		(trackInfos.FILESIZE_MP3_256) ? 5 :
		1;

	const filename = basicFilename + '.' +  (format === 9 ? 'flac' : 'mp3');

	const url = getTrackUrl(trackInfos, format);
	const bfKey = getBlowfishKey(trackInfos);

	let writeStream;
	try{
		writeStream = fs.createWriteStream(filename, {flags: 'wx'});
	}catch(err){
		console.log(err);
		process.stdout.write(filename + ' appeared while fetched the metadatas. Skipping...\n');
		return;
	}

	try{
		await streamTrack(trackInfos, url, bfKey, writeStream);
	}catch(err){
		console.error(err);
		fs.unlink(filename, () => {});
		return;
	}
	
	process.stdout.write('\rAdding tags...');
	if(format !== 9){
		const songBuffer = fs.readFileSync(filename);
		const writer = new ID3Writer(songBuffer);
		Object.keys(metadata).forEach(key => {
			writer.setFrame(key, metadata[key]);
		});
		writer.addTag();
		const taggedSongBuffer = Buffer.from(writer.arrayBuffer);
		fs.writeFileSync(filename, taggedSongBuffer);
	}

	process.stdout.write('\rDownloaded!   \n');
};

const downloadTracks = async url => {
	process.stdout.write('Fetching tracks...');
	const x = await fetch(url + '&limit=100').then(JSON.parse);
	for(const track of x.data){
		await downloadTrack(track);
	}
	if(typeof x.next === 'string'){
		return await downloadTracks(x.next);
	}else{
		return;
	}
};

const handleAlbumDownload = async albumId =>
	await downloadTracks('https://api.deezer.com/album/' + albumId + '/tracks');

const handleTrackDownload = async trackId =>
	await fetch('https://api.deezer.com/track/' + trackId).then(JSON.parse).then(downloadTrack);


const removeBy = (arr,predicate) => {
	const results = [];
	for(let i = arr.length - 1; i >= 0; i--){
		if(predicate(arr[i])){
			results.push(...arr.splice(i, 1));
		}
	}
	return results;
};

const search = (type, q) =>
	fetch(`https://api.deezer.com/search/${type}?q=${
		encodeURIComponent(
			typeof q === 'string' ? q :
			Object.entries(q)
				.filter(
					([key, value]) => value
				)
				.map(
					([key, value]) => `${key}:"${value}"`
				).join(' ')
		)
	}`)
	.then(JSON.parse)
	.then(res => res.data);


let debug = false;
const args = process.argv.slice(2);
const options = removeBy(args, arg => arg.startsWith('-'));
const [command] = args.splice(0, 1);
const flac = options.includes('--flac') || options.includes('-f');
const help = `
usage: mdown <type> <attrs> [--flac]
if type = song or s: attrs are track, artist, album
if type = album or a: attrs are album, artist
example: mdown album 'dark side of the moon' 'pink floyd'
`.trim();
const missingCreds = `
Missing credential file!
Create the creds file (${join(__dirname, 'creds.txt')}) then format it like this:
yourdeezeremail
yourdeezerpass
`.trim();


(async function(){
	if(!command || args.length === 0 || options.includes('-h') || options.includes('--help')){
		throw help;
	}

	let email, password;
	try{
		[email, password] = readFileSync(join(__dirname, 'creds.txt'), 'utf8').split('\n');
		if(!email || !password) throw 'no email / password!';
	}catch(err){
		throw missingCreds;
	}

	await login(email, password);
	switch(command){
		case 'album':
		case 'a':
			await search('album', {album: args[0], artist: args[1]})
				.then(albums => {
					if(albums.length === 0){
						throw 'No album found!';
					}
					return albums;
				})
				.then(albums => choose(albums, album => album.artist.name + ' - ' + album.title))
				.then(album => handleAlbumDownload(album.id));
			break;
		case 'song':
		case 's':
			await search('track', {track: args[0], artist: args[1], album: args[2]})
				.then(tracks => {
					if(tracks.length === 0){
						throw 'No song found!';
					}
					return tracks;
				})
				.then(songs => choose(songs, song => `${song.artist.name} - ${song.title} (${song.album.title})`))
				.then(song => handleTrackDownload(song.id));
			break;
		default:
			throw help;
	}
})().catch(err => {
	if(debug) throw err;
	console.error(typeof err !== 'object' ? err : err.message);
	process.exitCode = 1;
});
#!/usr/bin/env node
const crypto = require('crypto');
const inspect = require('util').inspect;
const fs = require('fs');
const readline = require('readline');
const sanitizeFilename = require('sanitize-filename');
const ID3Writer = require('browser-id3-writer');
const {default: fetch} = require('node-fetch');
const querystring = require('querystring');
const {join} = require('path');


let global_sid;

const getDeezerImage = (type, id) =>
	'https://e-cdns-images.dzcdn.net/images/' + type + '/' + id + '/500x500.jpg';

const concurrently = async (arr, callback) => {
	const results = [];
	for(const elem of arr){
		results.push(await callback(elem));
	}
	return results;
};

const getBuffer = url => fetch(url).then(response => response.buffer());

const getSid = (mail, password) => {
	var data = querystring.stringify({
		type: 'login',
		mail,
		password
	});

	return fetch('https://www.deezer.com/ajax/action.php', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			'Content-Length': Buffer.byteLength(data)
		},
		body: data
	}).then(res => {
		return new Map(res.headers.get('set-cookie').split(';').map(cookie => cookie.split('='))).get('sid')
	});
};

const getBlowfishKey = trackInfos => {
	const SECRET = 'g4el58wc0zvf9na1';

	const idMd5 = crypto.createHash('md5').update(trackInfos.SNG_ID, 'ascii').digest('hex');
	let bfKey = '';

	for(let i = 0; i < 16; i++){
		bfKey += String.fromCharCode(idMd5.charCodeAt(i) ^ idMd5.charCodeAt(i + 16) ^ SECRET.charCodeAt(i));
	}

	return bfKey;
}

const getTrackUrl = trackInfos => {
	const fileFormat = (trackInfos.FILESIZE_MP3_320) ? 3 : (trackInfos.FILESIZE_MP3_256) ? 5 : 1;

	const step1 = [trackInfos.MD5_ORIGIN, fileFormat, trackInfos.SNG_ID, trackInfos.MEDIA_VERSION].join('¤');

	let step2 = crypto.createHash('md5').update(step1, "ascii").digest('hex')+'¤'+step1+'¤';
	while(step2.length%16 > 0 ) step2 += ' ';

	const step3 = crypto.createCipheriv('aes-128-ecb','jo6aey6haid2Teih', '').update(step2, 'ascii', 'hex');
	const cdn = trackInfos.MD5_ORIGIN[0]; // random number between 0 and f
	
	return 'http://e-cdn-proxy-' + cdn + '.deezer.com/mobile/1/' + step3;
}

const streamTrack = (trackInfos, url, bfKey, stream) => new Promise((resolve, reject) => {
	fetch(url).then(response => {
		if(response.status !== 200){
			return reject(new Error('not OK'));
		}

		const contentLength = Number(response.headers.get('content-length'));
		let i = 0;
		let percent = 0;

		response.body.on('error', reject);
		response.body.on('readable', () => {
			let chunk;
			while(chunk = response.body.read(2048)) {
				let newPercent = Math.floor(2048 * 100 * i / contentLength);
				if(percent !== newPercent){
					process.stdout.write('\r' + newPercent + '%');
				}

				if(i % 3 > 0 || chunk.length < 2048) {
					stream.write(chunk);
				}
				else {
					const bfDecrypt = crypto.createDecipheriv('bf-cbc', bfKey, "\x00\x01\x02\x03\x04\x05\x06\x07");
					bfDecrypt.setAutoPadding(false);

					let chunkDec = bfDecrypt.update(chunk.toString('hex'), 'hex', 'hex');
					chunkDec += bfDecrypt.final('hex');
					stream.write(chunkDec, 'hex');
				}
				i++;
			}
		});
		response.body.on('end', () => {
			process.stdout.write('\r100%');
			stream.end();
			resolve(trackInfos);
		});
	});
});



const getTrackInfos = trackId =>
	fetch('https://www.deezer.com/track/'  + trackId, {headers: {cookie: 'sid='+global_sid}})
		.then(resp => resp.text())
		.then(htmlString => {
			const PLAYER_INIT = htmlString.match(/track: ({.+}),/);
			try{
				return JSON.parse(PLAYER_INIT[1]).data[0];
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
	const filename = sanitizeFilename(basicArtist + ' - ' + basicTitle + '.mp3');
	if(fs.existsSync(filename)){
		process.stdout.write(filename + ' already exists. Skipping...\n');
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
	const albumData = await fetch('https://api.deezer.com/album/' + trackInfos.ALB_ID).then(resp => resp.json()).catch(() => { process.stdout.write('\rError occured on album data fetching! Track ID: ' + track.id + '\n'); });
	if(typeof albumData === 'undefined') return;
	process.stdout.write('\rExtracting fetched metadata...');
	const metadata = await getMetadata(trackInfos, albumData).catch(console.error);
	if(typeof metadata === 'undefined') return;
	readline.clearLine(process.stdout, 0);
	const mainArtist = metadata.TPE1.includes(metadata.TPE2) ? metadata.TPE2 : metadata.TPE1[0];

	process.stdout.write('\r' + basicArtist + ' - ' + basicTitle + '\n');
	
	const url = getTrackUrl(trackInfos);
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
	const songBuffer = fs.readFileSync(filename);
	const writer = new ID3Writer(songBuffer);
	Object.keys(metadata).forEach(key => {
		writer.setFrame(key, metadata[key]);
	});
	writer.addTag();
	const taggedSongBuffer = Buffer.from(writer.arrayBuffer);
	fs.writeFileSync(filename, taggedSongBuffer);

	process.stdout.write('\rDownloaded!   ');
};

const downloadTracks = async url => {
	process.stdout.write('Fetching tracks...');
	const x = await fetch(url + '&limit=1000').then(resp => resp.json());
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
	
const handlePlaylistDownload = async playlistId => 
	await downloadTracks('https://api.deezer.com/playlist/' + playlistId + '/tracks');

const handleTrackDownload = async trackId =>
	await fetch('https://api.deezer.com/track/' + trackId).then(resp => resp.json()).then(downloadTrack);



const q = process.argv.slice(2).join(' ');
const data = fs.readFileSync(join(__dirname, 'data.txt'), 'utf8').split(/\r?\n/g);

getSid(...data)
	.then(sid => global_sid = sid)
	.then(() => fetch('https://api.deezer.com/search?q=' + encodeURIComponent(q)))
	.then(res => res.json())
	.then(res => res.data[0].id)
	.then(id => fetch('https://api.deezer.com/track/' + id))
	.then(resp => resp.json())
	.then(downloadTrack);
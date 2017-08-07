#!/usr/bin/env node

const crypto = require('crypto');
const inspect = require('util').inspect;
const fs = require('fs');
const http = require('http');
const https = require('https');
const readline = require('readline');
const urlLib = require('url');
const ID3Writer = require('./browser-id3-writer/browser-id3-writer');
const Duplex = require('stream').Duplex;
const tmpName = require('./tmp/tmp.js').tmpName;


const getDeezerImage = (type, id) =>
	'https://e-cdns-images.dzcdn.net/images/' + type + '/' + id + '/500x500.jpg';

const concurrently = async (arr, callback) => {
	const results = [];
	for(const elem of arr){
		results.push(await callback(elem));
	}
	return results;
};

const getImageBuffer = url => new Promise((resolve, reject) => {
	tmpName((err, path) => {
		const stream = fs.createWriteStream(path);
		https.get(url, res => {
			res.pipe(stream);
		});
		stream.on('close', () => {
			const buffer = fs.readFileSync(path);
			resolve(buffer);
			fs.unlink(path, err => {});
		});
	})
});

const request = (url, options = {}) => new Promise((resolve, reject) => {
	const urlParts = urlLib.parse(url);
	const lib = urlParts.protocol === 'http:' ? http : https;

	lib.get({
		host: urlParts.host,
		path: urlParts.path,
		headers: {
			'Accept-Language': 'en-US'
		}
	}, resp => {
		if(resp.statusCode >= 300 && resp.statusCode < 400){
			request(resp.headers.location, options).then(resolve).catch(reject);
			resp.destroy();	
		}else if(resp.statusCode === 200){
			let body = '';
			resp.on('data', chunk => {
				body += chunk;
			});
			resp.on('end', () => {
				if(options.buffer){
					resolve(Buffer.from(body));
				}else{
					resolve(body);
				}
			});
			resp.on('error', err => {
				reject(err);
			});
		}else{
			reject(resp);
		}
	});
});

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
	http.get(url, response => {

		const contentLength = Number(response.headers['content-length']);
		let i = 0;
		let percent = 0;

		response.on('readable', () => {
			let chunk;
			while(chunk = response.read(2048)) {
				let newPercent = Math.floor(2048 * 100 * i / Number(response.headers['content-length']));
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
		response.on('end', () => {
			process.stdout.write('\r100%');
			stream.end();
			resolve(trackInfos);
		});
	});
});



const getTrackInfos = trackId => request('https://www.deezer.com/track/'  + trackId).then(htmlString => {
	const PLAYER_INIT = htmlString.match(/track: ({.+}),/);
	return JSON.parse(PLAYER_INIT[1]).data[0];
});
const getAlbumData = albumId => request('https://api.deezer.com/album/' + albumId).then(JSON.parse);
const getPlaylistData = playlistId => request('https://api.deezer.com/playlist/' + playlistId).then(JSON.parse);

const getMetadata = async (trackInfos, albumData) => {
	const coverImageBuffer = await getImageBuffer(albumData.cover_big);

	return{
		TIT2: (trackInfos.SNG_TITLE + ' ' + trackInfos.VERSION).trim(),
		TALB: albumData.title,
		TPE1: trackInfos.ARTISTS.map(ARTIST => ARTIST.ART_NAME),
		TPE2: albumData.artist.name,
		TCOM: trackInfos.SNG_CONTRIBUTORS.composer || [],
		TCON: albumData.genres.data.map(genre => genre.name),
		TPOS: trackInfos.DISK_NUMBER,
		TRCK: trackInfos.TRACK_NUMBER + '/' + albumData.tracks.data.length,
		TYER: parseInt(trackInfos.PHYSICAL_RELEASE_DATE),
		WCOP: trackInfos.COPYRIGHT,
		TPUB: albumData.label,
		APIC: {
			type: 3,
			data: coverImageBuffer,
			description: (albumData.title.replace(/[^\w\s]/g, '').trim() + ' cover image').trim()
		}
	};
};



const downloadTrack = async trackId => {
	readline.clearLine(process.stdout, 0);
	readline.cursorTo(process.stdout, 0);
	process.stdout.write('Fetching track data...');
	const trackInfos = await getTrackInfos(trackId);
	process.stdout.write('\rFetching album data...');
	const albumData = await getAlbumData(trackInfos.ALB_ID);
	process.stdout.write('\rExtracting fetched metadata...');
	const metadata = await getMetadata(trackInfos, albumData);
	readline.clearLine(process.stdout, 0);
	const mainArtist = metadata.TPE1.includes(metadata.TPE2) ? metadata.TPE2 : metadata.TPE1[0];

	process.stdout.write('\r' + mainArtist + ' - ' + metadata.TIT2 + '\n');
	
	const url = getTrackUrl(trackInfos);
	const bfKey = getBlowfishKey(trackInfos);

	const fileName =
		(mainArtist + ' - ' + metadata.TIT2)
		.replace(/[|&;$%@"<>()+,]/g, '')
		+ '.mp3';

	const exists = fs.existsSync(fileName);
	if(exists){
		process.stdout.write('This song already exists. Skipping...\n');
		return;
	}
	
	await streamTrack(trackInfos, url, bfKey, fs.createWriteStream(fileName));
	
	process.stdout.write('\rAdding tags...');
	const songBuffer = fs.readFileSync(fileName);
	const writer = new ID3Writer(songBuffer);
	Object.keys(metadata).forEach(key => {
		writer.setFrame(key, metadata[key]);
	});
	writer.addTag();
	const taggedSongBuffer = Buffer.from(writer.arrayBuffer);
	fs.writeFileSync(fileName, taggedSongBuffer);

	process.stdout.write('\rDownloaded!   ');
};
const downloadAlbum = async albumId => {
	const albumData = await getAlbumData(albumId);
	for(const track of albumData.tracks.data){
		await downloadTrack(track.id);
	}
};
const downloadPlaylist = async playlistId => {
	const playlistData = await getPlaylistData(playlistId);
	for(const track of playlistData.tracks.data){
		await downloadTrack(track.id);
	}
};



const args = process.argv.slice(2);
const comm = args[0];
const ids = args.slice(1);

if(comm === 'album'){
	concurrently(ids, downloadAlbum);
}else if(comm === 'playlist'){
	concurrently(ids, downloadPlaylist);
}else if(comm === 'track'){
	concurrently(ids, downloadTrack);
}else{
	console.log(
`
Usage: dzdl <command> <id>
`
	);
}
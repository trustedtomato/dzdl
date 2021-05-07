#!/usr/bin/env node
const crypto = require('crypto')
const {
  readFileSync,
  existsSync,
  createWriteStream,
  unlink
} = require('fs')
const readline = require('readline')
const sanitizeFilename = require('sanitize-filename')
const id3 = require('node-id3')
const { promisify } = require('util')
const writeId3 = promisify(id3.write.bind(id3))
const { join } = require('path')
const prompts = require('prompts')
const tough = require('tough-cookie')
const baseRequest = require('request')
const FileCookieStore = require('./tough-cookie-store')
const pathLib = require('path')
const packageJson = JSON.parse(readFileSync(pathLib.join(__dirname, '/package.json'), 'utf-8'))

const jar = baseRequest.jar(new FileCookieStore(join(__dirname, 'cookies.json')))
const request = baseRequest.defaults({
  jar,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/62.0.3202.75 Safari/537.36',
    'Content-Language': 'en-US',
    'Cache-Control': 'max-age=0',
    Accept: '*/*',
    'Accept-Charset': 'utf-8,ISO-8859-1;q=0.7,*;q=0.3',
    'Accept-Language': 'de-DE,de;q=0.8,en-US;q=0.6,en;q=0.4'
  }
})

const apiUrl = 'http://www.deezer.com/ajax/gw-light.php'
const apiQueries = {
  api_version: '1.0',
  api_token: 'null',
  input: '3'
}

const fetch = opts => new Promise((resolve, reject) => {
  request(opts, (err, resp, body) => {
    if (err) {
      reject(err)
    } else {
      resolve(body)
    }
  })
})

const getBuffer = url => fetch({ url, encoding: null })

const callApi = method => new Promise((resolve, reject) => {
  request.get({
    url: apiUrl,
    qs: Object.assign({ method }, apiQueries),
    json: true
  }, (err, res, body) => {
    if (!err && res.statusCode === 200) {
      resolve(body.results)
    } else if (err && err.code === 'EAI_AGAIN') {
      reject(new Error('Cannot access deezer.com, check your internet connection!'))
    }
  })
})

const isLoggedIn = async () => {
  const userData = (await callApi('deezer.getUserData')).USER
  return !!userData.USER_ID
}

const login = () => isLoggedIn().then(async (loggedIn) => {
  if (loggedIn) return
  let initialArl = ''
  try {
    initialArl = readFileSync(join(__dirname, 'arl.txt'), { encoding: 'utf8' })
  } catch (err) {
    // continue as the file is just a helper for fucked up enviroments
  }
  const { arl } = await prompts({
    type: 'text',
    name: 'arl',
    message: 'What\'s your arl cookie\'s value?',
    initial: initialArl,
    validate: async (arl) => {
      const creation = new Date()
      const lastUsed = new Date(creation.valueOf())
      const expires = new Date(creation.valueOf())
      expires.setDate(expires.getDate() + 180)
      const cookie = tough.Cookie.fromJSON({
        key: 'arl',
        value: arl,
        expires: expires.toISOString(),
        maxAge: 15552000,
        domain: 'deezer.com',
        path: '/',
        httpOnly: true,
        hostOnly: false,
        creation: creation.toISOString(),
        lastAccessed: lastUsed.toISOString()
      }).toString()

      jar.setCookie(
        cookie,
        'https://www.deezer.com/'
      )

      const isArlUsable = await isLoggedIn()
      return isArlUsable ? true : 'Cannot login with this arl!'
    }
  })

  if (!arl) {
    throw new Error('No valid arl cookie value entered!')
  }
})

const getBlowfishKey = (trackInfos) => {
  const SECRET = 'g4el58wc0zvf9na1'

  const idMd5 = crypto.createHash('md5').update(trackInfos.SNG_ID, 'ascii').digest('hex')
  let bfKey = ''

  for (let i = 0; i < 16; i += 1) {
    bfKey += String.fromCharCode(
      idMd5.charCodeAt(i) ^
      idMd5.charCodeAt(i + 16) ^
      SECRET.charCodeAt(i)
    )
  }

  return bfKey
}

const getTrackUrl = (trackInfos, fileFormat) => {
  const step1 = [trackInfos.MD5_ORIGIN, fileFormat, trackInfos.SNG_ID, trackInfos.MEDIA_VERSION].join('¤')

  let step2 = `${crypto.createHash('md5').update(step1, 'ascii').digest('hex')}¤${step1}¤`
  while (step2.length % 16 > 0) step2 += ' '

  const step3 = crypto.createCipheriv('aes-128-ecb', 'jo6aey6haid2Teih', '').update(step2, 'ascii', 'hex')
  const cdn = trackInfos.MD5_ORIGIN[0] // random number between 0 and f

  return `http://e-cdn-proxy-${cdn}.deezer.com/mobile/1/${step3}`
}

const streamTrack = (trackInfos, url, bfKey, stream) => new Promise((resolve, reject) => {
  request.get({ url, encoding: null }, (err, res, body) => {
    if (err) {
      reject(err)
      return
    }

    if (res.statusCode !== 200) {
      reject(new Error('not OK'))
      return
    }

    const source = Buffer.from(body, 'binary')

    let i = 0
    let position = 0

    const destBuffer = Buffer.alloc(source.length)

    while (position < source.length) {
      const chunkSize = (source.length - position) ? 2048 : source.length - position
      let chunk
      chunk = Buffer.alloc(chunkSize)
      source.copy(chunk, 0, position, position + chunkSize)
      if (i % 3 > 0 || chunkSize < 2048) {
        // Do nothing
      } else {
        const cipher = crypto.createDecipheriv('bf-cbc', bfKey, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]))
        cipher.setAutoPadding(false)
        chunk = cipher.update(chunk, 'binary', 'binary') + cipher.final()
      }
      destBuffer.write(chunk.toString('binary'), position, 'binary')
      position += chunkSize
      i += 1
    }

    stream.write(destBuffer)
    stream.end()
    stream.on('close', resolve)
  })
})

const getTrackInfos = trackId => fetch(`https://www.deezer.com/track/${trackId}`)
  .then((htmlString) => {
    const PLAYER_INIT = htmlString.match(/__DZR_APP_STATE__\s*=\s*({.+?})\s*<\/script>/)
    try {
      return JSON.parse(PLAYER_INIT[1]).DATA
    } catch (err) {
      return undefined
    }
  })

const getMetadata = async (trackInfos, albumData) => {
  const coverImageBuffer = await getBuffer(albumData.cover_xl).catch(() => undefined)

  const metadata = {
    TIT2: `${trackInfos.SNG_TITLE} ${trackInfos.VERSION || ''}`.trim(),
    TALB: albumData.title,
    TPE1: trackInfos.ARTISTS.map(ARTIST => ARTIST.ART_NAME).join('/'),
    TPE2: albumData.artist.name,
    TCOM: (trackInfos.SNG_CONTRIBUTORS.composer || []).join('/'),
    TCON: albumData.genres.data.map(genre => genre.name).join('/'),
    TPOS: trackInfos.DISK_NUMBER,
    TRCK: `${trackInfos.TRACK_NUMBER}/${albumData.tracks.data.length}`,
    TYER: parseInt(trackInfos.PHYSICAL_RELEASE_DATE, 10),
    TPUB: albumData.label,
    TXXX: [{ description: 'dzdl-version', value: packageJson.version }]
  }

  if (coverImageBuffer) {
    metadata.APIC = {
      type: {
        id: 3,
        name: 'front cover'
      },
      imageBuffer: coverImageBuffer
    }
  }

  return metadata
}

const downloadTrack = async (track) => {
  readline.clearLine(process.stdout, 0)
  readline.cursorTo(process.stdout, 0)

  const basicArtist = track.artist
  const basicTitle = track.title
  const basicAlbum = track.album

  const basicFilename = sanitizeFilename(`${basicArtist} - ${basicTitle} (${basicAlbum})`)
  const extensions = ['mp3', 'flac']
  const filenames = extensions.map(extension => `${basicFilename}.${extension}`)
  const existsFilename = filenames.find(existsSync)

  if (existsFilename) {
    process.stdout.write(`${existsFilename} already exists. Skipping...\n`)
    return
  }

  process.stdout.write('Fetching track data...')
  const trackInfos = await getTrackInfos(track.id).catch((err) => {
    if (track.alternativeId) {
      return getTrackInfos(track.alternativeId)
    }
    throw err
  }).catch(() => {
    process.stdout.write(`\rError occured on track info fetching! Track ID: ${track.id}\n`)
  })

  if (typeof trackInfos === 'undefined') return
  process.stdout.write('\rFetching album data...')
  const albumData = await fetch(`https://api.deezer.com/album/${trackInfos.ALB_ID}`).then(JSON.parse).catch(() => { process.stdout.write(`\rError occured on album info fetching! Track ID: ${track.id}\n`) })
  if (typeof albumData === 'undefined') return
  process.stdout.write('\rExtracting fetched metadata...')
  const metadata = await getMetadata(trackInfos, albumData).catch(console.error)
  if (typeof metadata === 'undefined') return
  readline.clearLine(process.stdout, 0)
  // const mainArtist = metadata.TPE1.includes(metadata.TPE2) ? metadata.TPE2 : metadata.TPE1[0];

  process.stdout.write(`\r${basicFilename}\n`)

  const format =
    (flac && trackInfos.FILESIZE_FLAC) ? 9
      : (trackInfos.FILESIZE_MP3_320) ? 3
        : (trackInfos.FILESIZE_MP3_256) ? 5
          : 1

  const filename = `${basicFilename}.${format === 9 ? 'flac' : 'mp3'}`

  const url = getTrackUrl(trackInfos, format)
  const bfKey = getBlowfishKey(trackInfos)

  let writeStream
  try {
    writeStream = createWriteStream(filename, { flags: 'wx' })
  } catch (err) {
    console.error(err)
    process.stdout.write(`${filename} appeared while fetched the metadatas. Skipping...\n`)
    return
  }

  try {
    await streamTrack(trackInfos, url, bfKey, writeStream)
  } catch (err) {
    console.error(err)
    unlink(filename, () => {})
    return
  }

  process.stdout.write('\rAdding tags...')
  if (format !== 9) {
    await writeId3(metadata, filename)
  }

  process.stdout.write('\rDownloaded!   \n')
}

const downloadTracks = async (url, globalProperties = {}) => {
  process.stdout.write('Fetching tracks...')
  const x = await fetch(`${url}&limit=100`).then(JSON.parse)
  for (const track of x.data) {
    await downloadTrack({
      id: track.id,
      alternativeId: track.alternative && track.alternative.id,
      artist: track.artist.name,
      title: track.title,
      album: track.album && track.album.title,
      ...globalProperties
    })
  }
  if (typeof x.next === 'string') {
    return downloadTracks(x.next)
  }
  return undefined
}

const handleAlbumDownload = async album => downloadTracks(`https://api.deezer.com/album/${album.id}/tracks`, {
  album: album.title
})

const handleTrackDownload = async track => fetch(`https://api.deezer.com/track/${track.id}`)
  .then(JSON.parse)
  .then(track => ({
    id: track.id,
    alternativeId: track.alternative && track.alternative.id,
    artist: track.artist.name,
    title: track.title,
    album: track.album.title
  }))
  .then(downloadTrack)

const removeBy = (arr, predicate) => {
  const results = []
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (predicate(arr[i])) {
      results.push(...arr.splice(i, 1))
    }
  }
  return results
}

const search = (type, q) => fetch(`https://api.deezer.com/search/${type}?q=${
  encodeURIComponent(
    typeof q === 'string'
      ? q
      : Object.entries(q)
        .filter(
          ([, value]) => !!value
        )
        .map(
          ([key, value]) => `${key}:"${value}"`
        ).join(' ')
  )
}`)
  .then(JSON.parse)
  .then(res => res.data)

const debug = false
const args = process.argv.slice(2)
const options = removeBy(args, arg => arg.startsWith('-'))
const [command] = args.splice(0, 1)
const flac = options.includes('--flac') || options.includes('-f')
const help = `
usage: dzdl <type> <attrs> [--flac]
if type = song or s: attrs are track, artist, album
if type = album or a: attrs are album, artist
if type = playlist or p: attrs are query
if type = playlist-id or pid: attrs are the ID of the playlist
example: dzdl album 'dark side of the moon' 'pink floyd'

logging in: Currently you have to manually login
to Deezer and find the value of the 'arl' cookie.
I recommend using a separate account for this,
sharing your private details to a third-party service
is usually not the wisest idea.
`.trim();

(async function main () {
  if (!command || args.length === 0 || options.includes('-h') || options.includes('--help')) {
    throw help
  }

  await login()
  switch (command) {
    case 'album':
    case 'a': {
      await search('album', { album: args[0], artist: args[1] })
        .then((albums) => {
          if (albums.length === 0) {
            throw new Error('No album found!')
          }
          return albums
        })
        .then(albums => prompts({
          type: 'select',
          name: 'album',
          message: 'Pick an album',
          choices: albums.map(album => ({
            title: `${album.artist.name} - ${album.title}`,
            value: album
          }))
        }))
        .then(({ album }) => handleAlbumDownload(album))
      break
    }
    case 'song':
    case 's': {
      await search('track', { track: args[0], artist: args[1], album: args[2] })
        .then((tracks) => {
          if (tracks.length === 0) {
            throw new Error('No song found!')
          }
          return tracks
        })
        .then(songs => prompts({
          type: 'select',
          name: 'song',
          message: 'Pick a song',
          choices: songs.map(song => ({
            title: `${song.artist.name} - ${song.title} (${song.album.title})`,
            value: song
          }))
        }))
        .then(({ song }) => handleTrackDownload(song))
      break
    }
    case 'playlist':
    case 'p': {
      const playlists = await search('playlist', args[0])
      if (playlists.length === 0) {
        throw new Error('No playlist found!')
      }
      const { playlist } = await prompts({
        type: 'select',
        name: 'playlist',
        message: 'Pick a playlist',
        choices: playlists.map(playlist => ({
          title: `${playlist.title} (${playlist.user.name}, ${playlist.nb_tracks} tracks)`,
          value: playlist
        }))
      })
      await downloadTracks(`https://api.deezer.com/playlist/${playlist.id}/tracks`)
      break
    }
    case 'playlist-id':
    case 'pid': {
      await downloadTracks(`https://api.deezer.com/playlist/${args[0]}/tracks`)
      break
    }
    case 'migrate-to-2': {
      const paths = args
      const force = options.includes('--force') || options.includes('-f')
      require('./migrate-to-2')(paths, force)
      break
    }
    default: {
      throw help
    }
  }
}()).catch((err) => {
  if (debug) throw err
  console.error(typeof err !== 'object' ? err : err.message)
  process.exitCode = 1
})

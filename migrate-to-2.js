const id3 = require('node-id3');
const { promisify } = require('util');
const { rename } = require('fs/promises');
const readId3 = promisify(id3.read.bind(id3));
const updateId3 = promisify(id3.update.bind(id3));
const pathLib = require('path');
const sanitizeFilename = require('sanitize-filename');

module.exports = async (paths, force) => {
  for (const path of paths) {
    try {
      console.log(`Migrating ${path}...`);
      const id3 = await readId3(path);
      
      // get current version (defaults to 1.0.0)
      const userDefinedText = id3.userDefinedText || [];
      const dzdlVersionObject = userDefinedText.find(text => text.description === 'dzdl-version');
      const dzdlVersion = typeof dzdlVersionObject === 'object' ? dzdlVersionObject.value : '1.0.0';

      if (dzdlVersion.startsWith('1.') || force) {

        // migrate filename
        // In ID3v2.3 the artists are separated by /,
        // but since an artist's name may contain a slash (AC/DC),
        // we should rather default to the album artist.
        const artist = id3.artist.includes('/') ? id3.performerInfo : id3.artist;
        const newPath = pathLib.resolve(
          pathLib.dirname(path),
          sanitizeFilename(`${artist} - ${id3.title} (${id3.album}).mp3`)
        );
        await rename(path, newPath);

        // update version
        if (dzdlVersion !== '2.0.0') {
          userDefinedText.push({ description: 'dzdl-version', value: '2.0.0' });
          await updateId3({ userDefinedText }, newPath);
        }
      }
    } catch (err) {
      console.error(`Couldn't process the ID3 tag of ${path}!`, err);
    }
  }
};
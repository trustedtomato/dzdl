const https = require('https');
const fs = require('fs');

const download = url => new Promise((resolve, reject) => {
	const stream = fs.createWriteStream('temp.jpg');
	https.get(url, res => {
		res.pipe(stream);
	});
	stream.on('close', () => {
		resolve(fs.readFileSync('temp.jpg'));
		fs.unlinkSync('temp.jpg');
	});
});

(async function(){
	fs.writeFileSync('image.jpg', await download('https://upload.wikimedia.org/wikipedia/commons/2/24/Male_mallard_duck_2.jpg'))
}());
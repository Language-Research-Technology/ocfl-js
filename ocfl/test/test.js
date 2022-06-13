const fs = require('fs');
const stream = require('stream');
const crypto = require('crypto');
const hasha = require('hasha');

async function main() {
  var pt = new stream.PassThrough();
  pt.on('pipe', function(source) {
    //source.unpipe(this);
    console.log('on pipe');
    pt.pipe(hash);
    pt.pipe(output);
  });
  // pt.on('end', () => {
  //   console.log('pt end');
  // });
  //pt.on('close', () => { console.log('pt closed')});
  pt.on('newListener', (event, listener) => {
    console.log('e ' + event);
    //if (event==='close') console.log(listener.toString());
  });
  var hash = crypto.createHash('sha512').setEncoding('hex');
  hash.on('readable', () => {console.log('readable')});
  var input = fs.createReadStream('input'); 
  var output = fs.createWriteStream('output');
  const write = output.write;
  output.write = function(chunk, encoding, cb){
    hash.update(chunk, encoding);
    write.apply(output, arguments); 
  };
  output.on('finish', () => console.log('output finish'))
  output.on('close', ()=>{console.log('output close'); console.log(hash.digest('hex'));}); 
  output.on('close', ()=>console.log('close2')); 
  //pt.pipe(hash); pt.pipe(output); 
  //await stream.promises.pipeline(input, c);
  console.log('pipeline start');
  await stream.promises.pipeline(input, output);
  console.log('pipeline end');
  console.log(await hasha.fromFile('output'));
}
main().catch(e => {
  console.log(e);
});
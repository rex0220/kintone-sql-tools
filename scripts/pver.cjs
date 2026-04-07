// usage: node pver.js n
// npm run pver n
const shell = require('shelljs');
console.log('plugin version set start.');

function errMessage(pmsg) {
    const path = require('path');
    const basename = path.basename(process.argv[1]);
    console.error(pmsg);
    console.error(`Usage: node ${basename} version\n`);
}

if (process.argv.length < 3) {
    errMessage('ver option need error!\n');
    return 1;
}
const vno = process.argv[2];  // plugin version number
if (isNaN(Number(vno))) {
    errMessage('ver option:"' + vno + '" is not numeric error!\n');
    return 1;
}
console.log('plugin version set: '+vno);

shell.sed('-i', '(^ *"version": *)([0-9]+)', '$1'+vno, './*/manifest.json');
shell.sed('-i', '(-plugin)([0-9]+)', '$1'+vno, 'package.json');

console.log('plugin version set end.\n');
return 0;

"use strict";
var fs = require('fs-extra');

function showUsageAndExit() {
    const path = require('path');
    const basename = path.basename(process.argv[1]);
    console.error(`Usage: node ${basename} <sorce> <target>`);
    process.exit(1);
}

// for (let i = 0; i < process.argv.length; ++i) {
//     console.log(i + ': ' + process.argv[i]);
// }

const args = process.argv.slice(2);
if (args.length !== 2) {
    showUsageAndExit();
}

const filterFunc = (src, dest) => {
    // your logic here
    // it will be copied if return true
    // console.log('src', src);
    return src.split('\\').pop() !== 'manifest.json'
}

fs.copy(args[0], args[1], { filter: filterFunc }, err => {
    if (err) return console.error(err)
    console.log('dcopy success!');
})
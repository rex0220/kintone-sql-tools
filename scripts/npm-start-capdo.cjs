"use strict";
const runAll = require("npm-run-all");

runAll(["copy-capdo", "develop-capdo", "upload-capdo"], {
  parallel: false,
  stdout: process.stdout,
  stdin: process.stdin
}).catch(({results}) => {
  results
    .filter(({code}) => code)
    .forEach(({name}) => {
      console.log(`"npm run ${name}" was failed`);
    })
  ;
});

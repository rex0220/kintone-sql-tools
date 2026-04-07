"use strict";
const runAll = require("npm-run-all");

runAll(["copy-china", "develop-china", "upload-china"], {
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

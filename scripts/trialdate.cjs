// usage: node trialdate.js
// npm run tdate
const shell = require('shelljs');
const trial_date = '2025/12/31';
const trial_date1 = trial_date.replace(/\//g,'');
console.log('plugin trial date set start.');

console.log('plugin trial date set: '+trial_date);
// -try20221231.zip
shell.sed('-i', '\-try[0-9]{8}\.zip', '-try'+trial_date1+'.zip', './package.json');
shell.sed('-i', 'TRIAL_LDATE\: \'[0-9]{4}\/[0-9]{2}\/[0-9]{2}\'', 'TRIAL_LDATE\: \''+trial_date+'\'', './trial/desktop_js/rex0220_plugin_info.js');

console.log('plugin trial date set end.\n');
return 0;

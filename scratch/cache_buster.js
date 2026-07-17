const fs = require('fs');
const path = require('path');
function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    file = dir + '/' + file;
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory() && !file.includes('node_modules') && !file.includes('.git')) {
      results = results.concat(walk(file));
    } else if (file.endsWith('.html')) {
      results.push(file);
    }
  });
  return results;
}
const files = walk('.');
files.forEach(f => {
  let code = fs.readFileSync(f, 'utf8');
  if (code.includes('src="./app.js"') || code.match(/src="\.\/app\.js\?v=\d+"/)) {
    code = code.replace(/src="\.\/app\.js(\?v=\d+)?"/, 'src="./app.js?v=3"');
    fs.writeFileSync(f, code);
    console.log('Updated', f);
  }
});

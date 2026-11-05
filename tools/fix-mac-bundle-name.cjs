// electron-builder 26의 한글 이름 정규화 차이를 서명 전에 보정한다.
const path = require('node:path');
const { access } = require('node:fs/promises');
const { execFileSync } = require('node:child_process');

module.exports = async function fixMacBundleName(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const { productFilename, sanitizedProductName } = context.packager.appInfo;
  const contents = path.join(context.appOutDir, productFilename + '.app', 'Contents');
  const plist = path.join(contents, 'Info.plist');
  // Helper가 실제로 존재하는지 먼저 확인한다. 외부에 보이는 이름은 유지한다.
  await access(path.join(contents, 'Frameworks', sanitizedProductName + ' Helper.app'));
  const current = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleName', 'raw', '-o', '-', plist], { encoding: 'utf8' }).trimEnd();
  if (current === sanitizedProductName) return;

  execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleName', '-string', sanitizedProductName, plist]);
};

// 허용 폴더 시험용 임시 폴더 위치.
// 맥의 os.tmpdir()은 /private/var/folders/... 라서 앱 정책이 시스템 폴더(/private)로 보고 허용 폴더를 거부한다.
// 그래서 시스템 폴더가 아닌 프로젝트 안 .test-tmp/ 에 만든다 (.gitignore에 있음). 리눅스·윈도우에서도 그대로 쓸 수 있다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as policy from '../src/main/tools/policy';

export function tmpBase(): string {
  const sys = os.tmpdir();
  if (!policy.forbiddenRootReason(sys, { home: os.homedir() })) return sys;
  const dir = path.join(__dirname, '..', '.test-tmp');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

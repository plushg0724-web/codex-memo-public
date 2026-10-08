import fs = require('node:fs');
import path = require('node:path');
import {isDeepStrictEqual} from 'node:util';
import {errorMessage, hasErrorCode, isRecord} from './backup-types.cjs';
import type {Settings, SettingsStore} from './backup-types.cjs';

let temporarySequence = 0;

const fileVersion = (stat: fs.BigIntStats | null): string => stat
  ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
  : 'missing';

/** 설정 스냅샷은 여러 소비자가 재사용하므로 저장 없이 내용을 바꾸지 못하게 한다. */
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertSettings(value: unknown): asserts value is Settings {
  if (!isRecord(value)) throw Error('설정 파일은 JSON 객체여야 합니다.');
}

/** 변경되지 않은 설정은 재사용하고, 외부 수정은 열린 파일의 stat으로 감지한다. */
export function createSettingsStore(file: string): SettingsStore {
  let cached: {version: string; value: Settings} | null = null;

  function stat(): fs.BigIntStats | null {
    try { return fs.statSync(file, {bigint: true}); }
    catch (error) { if (hasErrorCode(error, 'ENOENT')) return null; throw error; }
  }

  function read(): Settings {
    const version = fileVersion(stat());
    if (cached?.version === version) return cached.value;
    let descriptor: number;
    try { descriptor = fs.openSync(file, 'r'); }
    catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error;
      cached = {version: 'missing', value: freeze({})};
      return cached.value;
    }
    try {
      const openedVersion = fileVersion(fs.fstatSync(descriptor, {bigint: true}));
      const text = fs.readFileSync(descriptor, 'utf8').replace(/^\uFEFF/, '');
      let value: unknown;
      try { value = JSON.parse(text); assertSettings(value); }
      catch (error) { throw Error(`설정 파일을 읽을 수 없습니다 (${file}): ${errorMessage(error)}`, {cause: error}); }
      cached = {version: openedVersion, value: freeze(value)};
      return cached.value;
    } finally { fs.closeSync(descriptor); }
  }

  /** 전체 설정을 교체한다. undefined 항목은 JSON 저장 규칙에 따라 제거된다. */
  function replace(value: Settings): Settings {
    assertSettings(value);
    const text = JSON.stringify(value, null, 2) + '\n';
    const next: unknown = JSON.parse(text);
    assertSettings(next);
    const current = read();
    if (isDeepStrictEqual(current, next)) return current;
    fs.mkdirSync(path.dirname(file), {recursive: true});
    const temporary = `${file}.${process.pid}.${++temporarySequence}.tmp`;
    try {
      fs.writeFileSync(temporary, text, {encoding: 'utf8', flag: 'wx'});
      fs.renameSync(temporary, file);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch { /* 저장 오류를 유지한다 */ }
      throw error;
    }
    // 저장 직후 다른 프로세스가 교체한 파일을 이 값으로 캐시하지 않는다.
    cached = null;
    return freeze(next);
  }

  function update(patch: Settings): Settings {
    assertSettings(patch);
    return replace({...read(), ...patch});
  }

  return {read, update, replace, invalidate: () => { cached = null; }};
}

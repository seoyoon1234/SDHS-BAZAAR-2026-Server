import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readSeedData, validateSeed, SEED_HEADERS } from '../scripts/validate-seed.js';

describe('DB-17 Seed CSV Validation', () => {
  const seedDir = path.resolve('seed-data');

  // 매 테스트마다 독립적인 데이터를 생성
  const getData = () => readSeedData(seedDir, true);

  it('예시 CSV 6개를 정상적으로 읽는다', () => {
    const data = getData();

    expect(data.buildings.length).toBeGreaterThan(0);
    expect(data.floors.length).toBeGreaterThan(0);
    expect(data.zones.length).toBeGreaterThan(0);
    expect(data.booths.length).toBeGreaterThan(0);
    expect(data.menus.length).toBeGreaterThan(0);
    expect(data.booth_locations.length).toBeGreaterThan(0);
  });

  it('정상 목업 데이터는 검증을 통과한다', () => {
    const data = getData();

    expect(validateSeed(data)).toEqual([]);
  });

  it('존재하지 않는 부스 코드를 차단한다', () => {
    const data = getData();

    data.menus[0].booth_code = '999999';

    const errors = validateSeed(data);

    expect(errors.some((message) => message.includes('존재하지 않는 부스 코드'))).toBe(true);
  });

  it('잘못된 메뉴 가격을 차단한다', () => {
    const data = getData();

    data.menus[0].price = '0';

    const errors = validateSeed(data);

    expect(errors.some((message) => message.includes('가격은 1~100000'))).toBe(true);
  });

  it('부스 코드가 숫자 6자리가 아니면 차단한다', () => {
    const data = getData();

    data.booths[0].booth_code = 'ABC123';

    const errors = validateSeed(data);

    expect(errors.some((message) => message.includes('부스 코드는 숫자 6자리'))).toBe(true);
  });

  it('일반 부스에 학년과 반이 없으면 차단한다', () => {
    const data = getData();

    data.booths[0].type = 'normal';
    data.booths[0].grade = '';
    data.booths[0].class_no = '';

    const errors = validateSeed(data);

    expect(errors.some((message) => message.includes('학년 또는 반 오류'))).toBe(true);
  });

  it('잘못된 hidden 값을 차단한다', () => {
    const data = getData();

    data.booths[0].hidden = 'maybe';

    const errors = validateSeed(data);

    expect(errors.some((message) => message.includes('hidden 값 오류'))).toBe(true);
  });

  it('잘못된 부스 위치 좌표를 차단한다', () => {
    const data = getData();

    data.booth_locations[0].x = '1.5';

    const errors = validateSeed(data);

    expect(errors.some((message) => message.includes('x 좌표 오류'))).toBe(true);
  });

  it('존재하지 않는 층을 참조하면 차단한다', () => {
    const data = getData();

    data.zones[0].floor_level = '99';

    const errors = validateSeed(data);

    expect(errors.some((message) => message.includes('존재하지 않는 층'))).toBe(true);
  });

  it('CSV 헤더가 잘못되면 파일 읽기를 거부한다', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'bazaar-seed-'));

    try {
      for (const table of Object.keys(SEED_HEADERS)) {
        const filename = `${table}.example.csv`;
        const source = readFileSync(path.join(seedDir, filename), 'utf8');

        writeFileSync(path.join(tempDir, filename), source, 'utf8');
      }

      // 건물 CSV의 헤더를 의도적으로 손상
      writeFileSync(
        path.join(tempDir, 'buildings.example.csv'),
        'wrong_header\n테스트건물\n',
        'utf8',
      );

      expect(() => readSeedData(tempDir, true)).toThrow('CSV 헤더가 일치하지 않습니다.');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

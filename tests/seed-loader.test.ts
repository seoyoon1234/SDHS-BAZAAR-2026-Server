import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  execute: vi.fn(),
  beginTransaction: vi.fn(),
  commit: vi.fn(),
  rollback: vi.fn(),
  release: vi.fn(),
}));

vi.mock('../src/config/env.js', () => ({
  loadEnv: () => ({
    DB_NAME: 'sdhs_bazaar_seed_test',
  }),
}));

vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({
    getConnection: () =>
      Promise.resolve({
        query: mocks.query,
        execute: mocks.execute,
        beginTransaction: mocks.beginTransaction,
        commit: mocks.commit,
        rollback: mocks.rollback,
        release: mocks.release,
      }),
  }),
  closePool: vi.fn(),
}));

import { loadSeed } from '../scripts/load-seed.js';
import { readSeedData, validateSeed } from '../scripts/validate-seed.js';

describe('DB-17 Seed Loader', () => {
  const seedDir = path.resolve('seed-data');

  const getData = () => readSeedData(seedDir, true);

  let nextId: number;

  beforeEach(() => {
    vi.clearAllMocks();
    nextId = 1;

    // 적재 대상 테이블이 모두 비어 있는 상황
    mocks.query.mockResolvedValue([[{ count: 0 }]]);

    // MySQL INSERT 및 학급 조회 결과를 흉내 냄
    mocks.execute.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id') && sql.includes('FROM classes')) {
        return Promise.resolve([[{ id: 23 }]]);
      }

      if (sql.includes('INSERT INTO')) {
        return Promise.resolve([{ insertId: nextId++ }]);
      }

      return Promise.resolve([{ affectedRows: 1 }]);
    });
  });

  it('정상 데이터 적재 시 COMMIT을 실행한다', async () => {
    const data = getData();

    expect(validateSeed(data)).toEqual([]);

    await loadSeed(data);

    expect(mocks.beginTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.commit).toHaveBeenCalledTimes(1);
    expect(mocks.rollback).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledTimes(1);

    const sqlStatements = mocks.execute.mock.calls.map((call) => String(call[0]));

    expect(sqlStatements.some((sql) => sql.includes('INSERT INTO buildings'))).toBe(true);

    expect(sqlStatements.some((sql) => sql.includes('INSERT INTO floors'))).toBe(true);

    expect(sqlStatements.some((sql) => sql.includes('INSERT INTO zones'))).toBe(true);

    expect(sqlStatements.some((sql) => sql.includes('INSERT INTO booths'))).toBe(true);

    expect(sqlStatements.some((sql) => sql.includes('INSERT INTO menus'))).toBe(true);

    expect(sqlStatements.some((sql) => sql.includes('UPDATE booths'))).toBe(true);

    expect(sqlStatements.some((sql) => sql.includes('INSERT INTO booth_locations'))).toBe(true);
  });

  it('메뉴 INSERT 실패 시 ROLLBACK하고 COMMIT하지 않는다', async () => {
    const data = getData();

    mocks.execute.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id') && sql.includes('FROM classes')) {
        return Promise.resolve([[{ id: 23 }]]);
      }

      // 앞 단계는 성공시키고 메뉴 저장 단계에서 의도적으로 실패
      if (sql.includes('INSERT INTO menus')) {
        return Promise.reject(new Error('TEST_MENU_INSERT_FAILURE'));
      }

      if (sql.includes('INSERT INTO')) {
        return Promise.resolve([{ insertId: nextId++ }]);
      }

      return Promise.resolve([{ affectedRows: 1 }]);
    });

    await expect(loadSeed(data)).rejects.toThrow('TEST_MENU_INSERT_FAILURE');

    expect(mocks.beginTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.rollback).toHaveBeenCalledTimes(1);
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('기존 데이터가 있으면 적재를 중단한다', async () => {
    const data = getData();

    mocks.query.mockResolvedValue([[{ count: 1 }]]);

    await expect(loadSeed(data)).rejects.toThrow('테이블에 이미 데이터가 있습니다.');

    expect(mocks.rollback).toHaveBeenCalledTimes(1);
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });
});

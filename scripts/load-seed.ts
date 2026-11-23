import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ResultSetHeader, RowDataPacket } from 'mysql2';

import { loadEnv } from '../src/config/env.js';
import { closePool, getPool } from '../src/db/pool.js';
import { readSeedData, validateSeed, type SeedData } from './validate-seed.js';

interface IdRow extends RowDataPacket {
  id: number;
}

interface CountRow extends RowDataPacket {
  count: number;
}

const TABLES = ['buildings', 'floors', 'zones', 'booths', 'menus', 'booth_locations'] as const;

const key = (...values: string[]): string => JSON.stringify(values);

const toBool = (value: string): boolean => ['true', '1'].includes(value.toLowerCase());

function requiredId(values: Map<string, number>, lookup: string, description: string): number {
  const id = values.get(lookup);

  if (id === undefined) {
    throw new Error(`${description}: 연결할 ID를 찾지 못했습니다.`);
  }

  return id;
}

export async function loadSeed(data: SeedData): Promise<void> {
  const env = loadEnv();

  // 실수로 운영 DB를 변경하지 않도록 제한
  if (!env.DB_NAME.endsWith('_test')) {
    throw new Error('안전 차단: _test로 끝나는 테스트 DB에서만 실행할 수 있습니다.');
  }

  const pool = getPool();
  const connection = await pool.getConnection();

  const buildings = new Map<string, number>();
  const floors = new Map<string, number>();
  const zones = new Map<string, number>();
  const booths = new Map<string, number>();

  let transactionStarted = false;

  try {
    await connection.beginTransaction();
    transactionStarted = true;

    // 재실행 시 중복 데이터 생성을 방지
    // 기존 데이터가 있다면 자동 삭제하지 않고 중단
    for (const table of TABLES) {
      const [rows] = await connection.query<CountRow[]>(`SELECT COUNT(*) AS count FROM ${table}`);

      if (rows[0].count > 0) {
        throw new Error(`${table} 테이블에 이미 데이터가 있습니다. 적재를 중단합니다.`);
      }
    }

    // 1. 건물
    for (const row of data.buildings) {
      const [result] = await connection.execute<ResultSetHeader>(
        `INSERT INTO buildings (name, sort_order)
         VALUES (?, ?)`,
        [row.name, Number(row.sort_order)],
      );

      buildings.set(row.name, result.insertId);
    }

    // 2. 층
    for (const row of data.floors) {
      const buildingId = requiredId(buildings, row.building_name, '건물');

      const [result] = await connection.execute<ResultSetHeader>(
        `INSERT INTO floors
         (building_id, level, label, map_image_url, width_m, height_m)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          buildingId,
          Number(row.level),
          row.label,
          row.map_image_url,
          Number(row.width_m),
          Number(row.height_m),
        ],
      );

      floors.set(key(row.building_name, row.level), result.insertId);
    }

    // 3. 구역
    for (const row of data.zones) {
      const floorId = requiredId(floors, key(row.building_name, row.floor_level), '층');

      const [result] = await connection.execute<ResultSetHeader>(
        `INSERT INTO zones (floor_id, name)
         VALUES (?, ?)`,
        [floorId, row.name],
      );

      zones.set(key(row.building_name, row.floor_level, row.name), result.insertId);
    }

    // 4. 부스
    for (const row of data.booths) {
      let classId: number | null = null;

      if (row.type === 'normal') {
        const [classes] = await connection.execute<IdRow[]>(
          `SELECT id
           FROM classes
           WHERE grade = ?
             AND class_no = ?
             AND deleted_at IS NULL`,
          [Number(row.grade), Number(row.class_no)],
        );

        if (classes.length !== 1) {
          throw new Error(`${row.name}: 학급을 정확히 하나 찾을 수 없습니다.`);
        }

        classId = classes[0].id;
      }

      const [result] = await connection.execute<ResultSetHeader>(
        `INSERT INTO booths
         (class_id, name, category, type,
          open_time, close_time, booth_code,
          description, hidden)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          classId,
          row.name,
          row.category,
          row.type,
          row.open_time,
          row.close_time,
          row.booth_code,
          row.description,
          toBool(row.hidden),
        ],
      );

      booths.set(row.booth_code, result.insertId);
    }

    // 5. 메뉴
    for (const row of data.menus) {
      const boothId = requiredId(booths, row.booth_code, '부스');

      await connection.execute(
        `INSERT INTO menus
         (booth_id, name, description, price,
          on_sale, sort_order, image_url)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          boothId,
          row.name,
          row.description || null,
          Number(row.price),
          toBool(row.on_sale),
          Number(row.sort_order),
          row.image_url || null,
        ],
      );
    }

    // 6. 판매 중 메뉴 기준 최소 가격 및 메뉴 수
    for (const boothId of booths.values()) {
      await connection.execute(
        `UPDATE booths b
         SET
           b.min_price = (
             SELECT MIN(m.price)
             FROM menus m
             WHERE m.booth_id = b.id
               AND m.on_sale = TRUE
               AND m.deleted_at IS NULL
           ),
           b.menu_count = (
             SELECT COUNT(*)
             FROM menus m
             WHERE m.booth_id = b.id
               AND m.on_sale = TRUE
               AND m.deleted_at IS NULL
           )
         WHERE b.id = ?`,
        [boothId],
      );
    }

    // 7. 부스 지도 위치
    for (const row of data.booth_locations) {
      const boothId = requiredId(booths, row.booth_code, '부스');

      const floorId = requiredId(floors, key(row.building_name, row.floor_level), '층');

      const zoneId = row.zone_name
        ? requiredId(zones, key(row.building_name, row.floor_level, row.zone_name), '구역')
        : null;

      await connection.execute(
        `INSERT INTO booth_locations
         (booth_id, floor_id, zone_id, x, y)
         VALUES (?, ?, ?, ?, ?)`,
        [boothId, floorId, zoneId, Number(row.x), Number(row.y)],
      );
    }

    // 모든 적재가 성공해야 최종 저장
    await connection.commit();
    transactionStarted = false;

    console.log('DB-17 CSV 데이터 적재 성공!');
    console.log(`건물: ${data.buildings.length}개`);
    console.log(`층: ${data.floors.length}개`);
    console.log(`구역: ${data.zones.length}개`);
    console.log(`부스: ${data.booths.length}개`);
    console.log(`메뉴: ${data.menus.length}개`);
    console.log(`부스 위치: ${data.booth_locations.length}개`);
  } catch (error) {
    if (transactionStarted) {
      await connection.rollback();
      console.error('오류 발생: 트랜잭션을 롤백했습니다.');
    }

    throw error;
  } finally {
    connection.release();
  }
}

async function main(): Promise<void> {
  const example = !process.argv.includes('--real');
  const apply = process.argv.includes('--apply');
  const directory = path.resolve('seed-data');

  // DB 연결 전에 CSV 검증
  const data = readSeedData(directory, example);
  const errors = validateSeed(data);

  if (errors.length > 0) {
    throw new Error(`CSV 검증 실패:\n${errors.join('\n')}`);
  }

  console.log('CSV 검증 통과!');

  if (!apply) {
    console.log('검증만 완료했습니다. DB에 저장하지 않았습니다.');
    return;
  }

  try {
    await loadSeed(data);
  } finally {
    await closePool();
  }
}

const scriptPath = process.argv[1] ? path.resolve(process.argv[1]) : '';

if (scriptPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'csv-parse/sync';

export type SeedRow = Record<string, string>;

export const SEED_HEADERS = {
  buildings: ['name', 'sort_order'],
  floors: ['building_name', 'level', 'label', 'map_image_url', 'width_m', 'height_m'],
  zones: ['building_name', 'floor_level', 'name'],
  booths: [
    'grade',
    'class_no',
    'name',
    'category',
    'type',
    'open_time',
    'close_time',
    'booth_code',
    'description',
    'hidden',
  ],
  menus: ['booth_code', 'name', 'description', 'price', 'on_sale', 'sort_order', 'image_url'],
  booth_locations: ['booth_code', 'building_name', 'floor_level', 'zone_name', 'x', 'y'],
} as const;

export type SeedTable = keyof typeof SEED_HEADERS;
export type SeedData = Record<SeedTable, SeedRow[]>;

const tables = Object.keys(SEED_HEADERS) as SeedTable[];

const boolValid = (value: string): boolean =>
  ['true', 'false', '0', '1'].includes(value.toLowerCase());

const positiveInteger = (value: string): boolean =>
  /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) >= 1;

const validTime = (value: string): boolean => {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);

  if (!match) return false;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? '0');

  return hour <= 23 && minute <= 59 && second <= 59;
};

const seconds = (value: string): number => {
  const [h, m, s = '0'] = value.split(':');

  return Number(h) * 3600 + Number(m) * 60 + Number(s);
};

// CSV 파일 읽기
export function readSeedData(directory: string, example = true): SeedData {
  const data = {} as SeedData;

  for (const table of tables) {
    const filename = `${table}${example ? '.example' : ''}.csv`;
    const filepath = path.join(directory, filename);

    const content = readFileSync(filepath, 'utf8').replace(/^\uFEFF/, '');

    // 반환 타입을 제네릭으로 명시
    const records: string[][] = parse(content, {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: false,
      columns: false,
    });

    const [headers, ...rows] = records;

    if (!headers || JSON.stringify(headers) !== JSON.stringify(SEED_HEADERS[table])) {
      throw new Error(`${filename}: CSV 헤더가 일치하지 않습니다.`);
    }

    data[table] = rows.map((values, index) => {
      if (values.length !== headers.length) {
        throw new Error(`${filename}:${index + 2} 컬럼 개수 오류`);
      }

      return Object.fromEntries(headers.map((header, i) => [header, values[i].trim()]));
    });
  }

  return data;
}

// CSV 데이터 유효성 검사
export function validateSeed(data: SeedData): string[] {
  const errors: string[] = [];

  const error = (table: SeedTable, line: number, message: string): void => {
    errors.push(`${table}.csv:${line} ${message}`);
  };

  const buildings = new Set<string>();
  const floors = new Set<string>();
  const zones = new Set<string>();
  const booths = new Set<string>();

  const floorKey = (building: string, level: string): string => JSON.stringify([building, level]);

  const zoneKey = (building: string, level: string, zone: string): string =>
    JSON.stringify([building, level, zone]);

  // 1. 건물 검증
  data.buildings.forEach((row, i) => {
    const line = i + 2;

    if (!row.name) {
      error('buildings', line, '건물 이름 필수');
    }

    if (!positiveInteger(row.sort_order)) {
      error('buildings', line, 'sort_order는 1 이상');
    }

    if (buildings.has(row.name)) {
      error('buildings', line, '건물 이름 중복');
    }

    buildings.add(row.name);
  });

  // 2. 층 검증
  data.floors.forEach((row, i) => {
    const line = i + 2;
    const key = floorKey(row.building_name, row.level);

    if (!buildings.has(row.building_name)) {
      error('floors', line, '존재하지 않는 건물');
    }

    if (!row.level || !/^-?\d+$/.test(row.level)) {
      error('floors', line, '층 번호 오류');
    }

    if (!row.label || !row.map_image_url) {
      error('floors', line, '층 이름 또는 지도 이미지 누락');
    }

    if (
      !Number.isFinite(Number(row.width_m)) ||
      !(Number(row.width_m) > 0) ||
      !Number.isFinite(Number(row.height_m)) ||
      !(Number(row.height_m) > 0)
    ) {
      error('floors', line, '지도 크기는 0보다 커야 함');
    }

    if (floors.has(key)) {
      error('floors', line, '같은 건물의 층 중복');
    }

    floors.add(key);
  });

  // 3. 구역 검증
  data.zones.forEach((row, i) => {
    const line = i + 2;
    const key = zoneKey(row.building_name, row.floor_level, row.name);

    if (!floors.has(floorKey(row.building_name, row.floor_level))) {
      error('zones', line, '존재하지 않는 층');
    }

    if (!row.name) {
      error('zones', line, '구역 이름 필수');
    }

    if (zones.has(key)) {
      error('zones', line, '구역 중복');
    }

    zones.add(key);
  });

  // 4. 부스 검증
  data.booths.forEach((row, i) => {
    const line = i + 2;

    if (!row.name) {
      error('booths', line, '부스 이름 필수');
    }

    if (!/^[0-9]{6}$/.test(row.booth_code)) {
      error('booths', line, '부스 코드는 숫자 6자리');
    }

    if (booths.has(row.booth_code)) {
      error('booths', line, '부스 코드 중복');
    }

    booths.add(row.booth_code);

    if (!['normal', 'special'].includes(row.type)) {
      error('booths', line, '부스 유형 오류');
    }

    if (row.type === 'normal') {
      const grade = Number(row.grade);
      const classNo = Number(row.class_no);

      if (
        !positiveInteger(row.grade) ||
        !positiveInteger(row.class_no) ||
        grade > 3 ||
        classNo > 4
      ) {
        error('booths', line, '학년 또는 반 오류');
      }
    }

    if (row.type === 'special' && (row.grade || row.class_no)) {
      error('booths', line, '특별 부스에는 학년·반 지정 불가');
    }

    if (!boolValid(row.hidden)) {
      error('booths', line, 'hidden 값 오류');
    }

    if (
      !validTime(row.open_time) ||
      !validTime(row.close_time) ||
      seconds(row.open_time) >= seconds(row.close_time)
    ) {
      error('booths', line, '운영 시간 오류');
    }
  });

  // 5. 메뉴 검증
  data.menus.forEach((row, i) => {
    const line = i + 2;

    if (!booths.has(row.booth_code)) {
      error('menus', line, '존재하지 않는 부스 코드');
    }

    if (!row.name) {
      error('menus', line, '메뉴 이름 필수');
    }

    if (!positiveInteger(row.price) || Number(row.price) > 100000) {
      error('menus', line, '가격은 1~100000');
    }

    if (!positiveInteger(row.sort_order)) {
      error('menus', line, 'sort_order는 1 이상');
    }

    if (!boolValid(row.on_sale)) {
      error('menus', line, 'on_sale 값 오류');
    }
  });

  // 6. 부스 위치 검증
  data.booth_locations.forEach((row, i) => {
    const line = i + 2;

    if (!booths.has(row.booth_code)) {
      error('booth_locations', line, '존재하지 않는 부스');
    }

    if (!floors.has(floorKey(row.building_name, row.floor_level))) {
      error('booth_locations', line, '존재하지 않는 층');
    }

    if (row.zone_name && !zones.has(zoneKey(row.building_name, row.floor_level, row.zone_name))) {
      error('booth_locations', line, '존재하지 않는 구역');
    }

    for (const coordinate of ['x', 'y'] as const) {
      const value = row[coordinate];

      if (!value || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1) {
        error('booth_locations', line, `${coordinate} 좌표 오류`);
      }
    }
  });

  return errors;
}

// 터미널에서 직접 실행할 때만 검증
const scriptPath = process.argv[1] ? path.resolve(process.argv[1]) : '';

if (scriptPath === fileURLToPath(import.meta.url)) {
  const directory = path.resolve('seed-data');
  const example = !process.argv.includes('--real');

  try {
    const data = readSeedData(directory, example);
    const errors = validateSeed(data);

    if (errors.length > 0) {
      console.error('시드 검증 실패:');

      errors.forEach((message) => {
        console.error(message);
      });

      process.exitCode = 1;
    } else {
      console.log('시드 검증 통과!');

      for (const table of tables) {
        console.log(`${table}: ${data[table].length}행`);
      }
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

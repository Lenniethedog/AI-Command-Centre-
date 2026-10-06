import { randomUUID } from 'node:crypto';

export type IdPrefix = 'prj' | 'msn' | 'tsk' | 'evt' | 'mcl' | 'tcl' | 'mem';

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

export function now(): string {
  return new Date().toISOString();
}

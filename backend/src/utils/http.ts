import type { Response } from 'express';

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function sendData<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ data });
}

export function sendList<T>(res: Response, data: T[], meta: PageMeta): void {
  res.status(200).json({ data, meta });
}

export function pageMeta(page: number, limit: number, total: number): PageMeta {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}

export const offsetFor = (page: number, limit: number) => (page - 1) * limit;

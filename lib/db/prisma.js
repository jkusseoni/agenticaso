/**
 * Prisma client singleton for Next.js (server-side only).
 * Soft-fails when DATABASE_URL is missing so local/UI builds still work.
 */

import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis;

/**
 * @returns {PrismaClient | null}
 */
export function getPrisma() {
  if (!process.env.DATABASE_URL) return null;

  if (!globalForPrisma.__agenticasoPrisma) {
    globalForPrisma.__agenticasoPrisma = new PrismaClient({
      log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    });
  }
  return globalForPrisma.__agenticasoPrisma;
}

export function isDatabaseConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * @param {PrismaClient | null | undefined} db
 */
export function assertDb(db) {
  if (!db) {
    const err = new Error("Database is not configured.");
    err.code = "DB_NOT_CONFIGURED";
    throw err;
  }
  return db;
}

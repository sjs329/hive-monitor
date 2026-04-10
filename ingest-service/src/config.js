import dotenv from "dotenv";

dotenv.config();

function required(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return String(value).trim();
}

export const config = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || "0.0.0.0",
  dbUrl: required("DATABASE_URL"),
  ingestSharedSecret: required("INGEST_SHARED_SECRET"),
  adminKey: process.env.ADMIN_KEY || "",
  corsOrigin: process.env.CORS_ORIGIN || "*",
};

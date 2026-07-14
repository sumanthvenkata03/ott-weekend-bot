// src/delivery/r2-upload.ts
// Upload PNGs to Cloudflare R2 (S3-compatible API) and return public URLs.

import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { readFile } from "node:fs/promises";
import { config } from "../shared/config.js";
import { log } from "../shared/logger.js";

let _r2: S3Client | null = null;

function requireCreds(): { accessKeyId: string; secretAccessKey: string } {
  const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = config;
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error(
      "R2 credentials missing. Add R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY to .env."
    );
  }
  return { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY };
}

function getClient(): S3Client {
  if (_r2) return _r2;
  const credentials = requireCreds();
  _r2 = new S3Client({
    region: "auto",
    endpoint: config.R2_S3_ENDPOINT,
    credentials,
  });
  return _r2;
}

export interface UploadResult {
  key: string;
  publicUrl: string;
}

export async function uploadPngToR2(
  localPath: string,
  r2Key: string
): Promise<UploadResult> {
  const body = await readFile(localPath);
  const client = getClient();

  await client.send(new PutObjectCommand({
    Bucket: config.R2_BUCKET_NAME,
    Key: r2Key,
    Body: body,
    ContentType: "image/png",
    CacheControl: "public, max-age=31536000, immutable",
  }));

  const publicUrl = `${config.R2_PUBLIC_URL.replace(/\/$/, "")}/${r2Key}`;
  log.info(`  R2 ← ${r2Key} (${body.length} bytes)`);
  return { key: r2Key, publicUrl };
}

export async function uploadPngsToR2(
  uploads: Array<{ localPath: string; r2Key: string }>
): Promise<UploadResult[]> {
  return Promise.all(uploads.map(u => uploadPngToR2(u.localPath, u.r2Key)));
}

// ── Generic uploader (non-PNG deliverables: .zip, .txt, …) ───────────────────
// ContentType is inferred from the key's extension (override via opts), and the
// CacheControl is caller-chosen — deliverables/ get a short "public, max-age=3600"
// (one-shot convenience downloads), NOT the images' 1-year immutable header.
const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".zip":  "application/zip",
  ".txt":  "text/plain; charset=utf-8",
};

interface UploadOpts {
  contentType?: string;
  cacheControl?: string;
}

/** Upload an in-memory buffer to R2 and return its public URL. */
export async function uploadBufferToR2(
  body: Buffer,
  r2Key: string,
  opts: UploadOpts = {}
): Promise<UploadResult> {
  const dot = r2Key.lastIndexOf(".");
  const ext = dot >= 0 ? r2Key.slice(dot).toLowerCase() : "";
  const contentType = opts.contentType ?? CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream";
  const cacheControl = opts.cacheControl ?? "public, max-age=31536000, immutable";

  await getClient().send(new PutObjectCommand({
    Bucket: config.R2_BUCKET_NAME,
    Key: r2Key,
    Body: body,
    ContentType: contentType,
    CacheControl: cacheControl,
  }));

  const publicUrl = `${config.R2_PUBLIC_URL.replace(/\/$/, "")}/${r2Key}`;
  log.info(`  R2 ← ${r2Key} (${body.length} bytes, ${contentType})`);
  return { key: r2Key, publicUrl };
}

/** Upload a local file to R2 (ContentType inferred from extension unless given). */
export async function uploadFileToR2(
  localPath: string,
  r2Key: string,
  opts: UploadOpts = {}
): Promise<UploadResult> {
  return uploadBufferToR2(await readFile(localPath), r2Key, opts);
}

/** Delete an object by key (used to clean up verify/test artifacts). */
export async function deleteFromR2(r2Key: string): Promise<void> {
  await getClient().send(new DeleteObjectCommand({
    Bucket: config.R2_BUCKET_NAME,
    Key: r2Key,
  }));
  log.info(`  R2 ✕ ${r2Key}`);
}

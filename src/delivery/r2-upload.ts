// src/delivery/r2-upload.ts
// Upload PNGs to Cloudflare R2 (S3-compatible API) and return public URLs.

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
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

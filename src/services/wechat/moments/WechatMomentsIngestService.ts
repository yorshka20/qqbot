/**
 * WechatMomentsIngestService
 *
 * Fetches own WeChat moments via PadPro API, parses content from objectDesc XML,
 * downloads images locally, and upserts to the wechat_moments Qdrant collection.
 *
 * Designed to be called periodically (every 3 days) or on-demand for backfill.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RAGDocument, RetrievalService } from '@/services/retrieval';
import { logger } from '@/utils/logger';
import type { WeChatPadProClient, WXMoment } from '../WeChatPadProClient';
import type { ParsedMomentMedia } from './momentsParser';
import { parseMomentObjectDesc } from './momentsParser';

const COLLECTION = 'wechat_moments';
const IMAGE_DIR = 'output/wechat-moments';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Check if a buffer starts with a known image magic signature. */
function isImageBuffer(buf: Buffer): boolean {
  if (buf[0] === 0xff && buf[1] === 0xd8) return true; // JPEG
  if (buf[0] === 0x89 && buf[1] === 0x50) return true; // PNG
  if (buf[0] === 0x47 && buf[1] === 0x49) return true; // GIF
  if (buf[0] === 0x52 && buf[1] === 0x49) return true; // WEBP (RIFF)
  return false;
}

export interface MomentsIngestOptions {
  /** The wxid to fetch moments for (own wxid). Required to fetch only your own moments. */
  wxid?: string;
  /** Stop fetching when we reach a moment with createTime <= this (unix seconds). 0 = no limit. */
  sinceTimestamp?: number;
  /** Max total moments to fetch across all pages. Default 200. */
  maxTotal?: number;
  /** Whether to download images. Default true. */
  downloadImages?: boolean;
}

export interface MomentsIngestResult {
  fetched: number;
  ingested: number;
  skippedEmpty: number;
  skippedDuplicate: number;
  imagesDownloaded: number;
  imagesFailed: number;
  oldestTimestamp: number;
  newestTimestamp: number;
}

export class WechatMomentsIngestService {
  constructor(
    private readonly padProClient: WeChatPadProClient,
    private readonly retrieval: RetrievalService,
  ) {}

  /**
   * Fetch own moments, parse, download images, and upsert to Qdrant.
   * Paginates via maxId until sinceTimestamp is reached or maxTotal is hit.
   */
  async ingest(options: MomentsIngestOptions = {}): Promise<MomentsIngestResult> {
    const wxid = options.wxid;
    const sinceTs = options.sinceTimestamp ?? 0;
    const maxTotal = options.maxTotal ?? 200;
    const shouldDownloadImages = options.downloadImages ?? true;

    if (!this.retrieval.isRAGEnabled()) {
      throw new Error('RAG is not enabled — cannot ingest moments');
    }

    const result: MomentsIngestResult = {
      fetched: 0,
      ingested: 0,
      skippedEmpty: 0,
      skippedDuplicate: 0,
      imagesDownloaded: 0,
      imagesFailed: 0,
      oldestTimestamp: Number.MAX_SAFE_INTEGER,
      newestTimestamp: 0,
    };

    let maxId: number | undefined;
    let reachedEnd = false;

    while (result.fetched < maxTotal && !reachedEnd) {
      logger.info(`[MomentsIngest] Fetching page | maxId=${maxId ?? 'none'} fetched=${result.fetched}/${maxTotal}`);

      const moments = wxid
        ? await this.padProClient.getUserMoments(wxid, maxId)
        : await this.padProClient.getMomentsTimeline(maxId);
      if (moments.length === 0) {
        logger.info('[MomentsIngest] No more moments returned');
        break;
      }

      const documents: RAGDocument[] = [];

      for (const moment of moments) {
        if (result.fetched >= maxTotal) {
          reachedEnd = true;
          break;
        }

        const ts = moment.createTime ?? 0;
        if (sinceTs > 0 && ts <= sinceTs) {
          reachedEnd = true;
          break;
        }

        result.fetched++;

        if (ts < result.oldestTimestamp) result.oldestTimestamp = ts;
        if (ts > result.newestTimestamp) result.newestTimestamp = ts;

        // Parse objectDesc XML
        const parsed = moment.objectDescBuffer ? parseMomentObjectDesc(moment.objectDescBuffer) : null;

        const contentDesc = parsed?.contentDesc ?? '';
        if (!contentDesc && !parsed?.mediaList?.length && !parsed?.contentUrl) {
          result.skippedEmpty++;
          continue;
        }

        // Build content text for embedding
        const textParts: string[] = [];
        if (contentDesc) textParts.push(contentDesc);
        if (parsed?.title) textParts.push(`[链接] ${parsed.title}`);
        if (parsed?.contentUrl) textParts.push(parsed.contentUrl);
        const content = textParts.join('\n');

        // Download images with random delay between each to avoid rate limiting
        const imagePaths: string[] = [];
        if (shouldDownloadImages && parsed?.mediaList?.length) {
          for (const media of parsed.mediaList) {
            const path = await this.downloadMomentImage(moment, media);
            if (path) {
              imagePaths.push(path);
              result.imagesDownloaded++;
            } else {
              result.imagesFailed++;
            }
            // Random delay 1~3s between image downloads
            await sleep(1000 + Math.random() * 2000);
          }
        }

        // Determine type
        const contentStyle = parsed?.contentStyle ?? '';
        const type = contentStyle || (parsed?.mediaList?.length ? '1' : '2');

        // Build Qdrant payload matching existing schema
        const createTime = ts
          ? new Date(ts * 1000)
              .toISOString()
              .replace('T', ' ')
              .replace(/\.\d+Z$/, '')
          : '';

        const payload: Record<string, unknown> = {
          create_time: createTime,
          create_date: createTime.slice(0, 10), // "2026-03-18"
          create_month: createTime.slice(0, 7), // "2026-03"
          create_year: createTime.slice(0, 4), // "2026"
          type,
          medias_count: parsed?.mediaList?.length ?? 0,
          source: 'padpro_ingest',
          tags: [],
          summary: '',
        };

        // Add image paths for WebUI display
        if (imagePaths.length > 0) {
          payload.image_paths = imagePaths;
        }

        // Use moment ID as document ID for deduplication
        const docId = `moment_${moment.id ?? ts}`;

        documents.push({ id: docId, content, payload });
      }

      // Upsert batch to Qdrant
      if (documents.length > 0) {
        await this.retrieval.upsertDocuments(COLLECTION, documents);
        result.ingested += documents.length;
        logger.info(`[MomentsIngest] Upserted ${documents.length} moments to Qdrant`);
      }

      // Set maxId for next page — use the last moment's numeric id
      const lastMoment = moments[moments.length - 1];
      const lastId = lastMoment?.id ? Number(lastMoment.id) : 0;
      if (lastId > 0) {
        maxId = lastId;
      } else {
        break; // Can't paginate without an id
      }

      // Check if last moment is already past our boundary
      const lastTs = lastMoment?.createTime ?? 0;
      if (sinceTs > 0 && lastTs <= sinceTs) {
        reachedEnd = true;
      }

      // Random delay 3~6s between page fetches to mimic normal browsing
      if (!reachedEnd && result.fetched < maxTotal) {
        await sleep(3000 + Math.random() * 3000);
      }
    }

    // Normalize edge values
    if (result.oldestTimestamp === Number.MAX_SAFE_INTEGER) result.oldestTimestamp = 0;

    logger.info(
      `[MomentsIngest] Done | fetched=${result.fetched} ingested=${result.ingested} ` +
        `skippedEmpty=${result.skippedEmpty} skippedDup=${result.skippedDuplicate} ` +
        `images=${result.imagesDownloaded}/${result.imagesDownloaded + result.imagesFailed}`,
    );

    return result;
  }

  /**
   * Download a moment image to local filesystem.
   * Returns the relative file path, or null on failure.
   */
  private async downloadMomentImage(moment: WXMoment, media: ParsedMomentMedia): Promise<string | null> {
    const url = media.url || media.thumbUrl;
    if (!url) return null;

    // Skip video URLs — they require WeChat client auth and cannot be fetched directly
    if (url.includes('snsvideo') || url.includes('videodownload') || media.type === '6') {
      logger.debug(`[MomentsIngest] Skipping video media: ${url.slice(0, 60)}`);
      return null;
    }

    try {
      const dir = resolve(IMAGE_DIR);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      // Use media id or moment id + index as filename
      const ext = this.guessExtension(url);
      const filename = `${media.id || moment.id || Date.now()}${ext}`;
      const filePath = `${IMAGE_DIR}/${filename}`;
      const absPath = resolve(filePath);

      // Skip if already downloaded
      if (existsSync(absPath)) {
        return filePath;
      }

      // Download via HTTP (moments images typically have direct CDN URLs)
      const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!resp.ok) {
        logger.warn(`[MomentsIngest] Image download failed: HTTP ${resp.status} | url=${url.slice(0, 80)}`);
        return null;
      }

      const buf = Buffer.from(await resp.arrayBuffer());

      // Validate magic bytes — reject HTML error pages masquerading as images
      if (buf.length < 4 || !isImageBuffer(buf)) {
        logger.warn(
          `[MomentsIngest] Downloaded content is not a valid image (magic=${buf.slice(0, 4).toString('hex')}) | url=${url.slice(0, 80)}`,
        );
        return null;
      }

      writeFileSync(absPath, buf);
      logger.debug(`[MomentsIngest] Downloaded image: ${filePath} (${buf.length} bytes)`);
      return filePath;
    } catch (err) {
      logger.warn(`[MomentsIngest] Image download error:`, err);
      return null;
    }
  }

  private guessExtension(url: string): string {
    if (url.includes('.png')) return '.png';
    if (url.includes('.gif')) return '.gif';
    if (url.includes('.webp')) return '.webp';
    return '.jpg';
  }
}

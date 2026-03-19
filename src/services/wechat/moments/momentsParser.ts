/**
 * Parse WeChat moments objectDesc buffer.
 *
 * The `objectDesc.buffer` from PadPro is a base64-encoded blob that,
 * once decoded, contains an XML document describing the moment's content
 * (text, media list, location, etc.).
 *
 * Key XML tags:
 * - <contentDesc>  — plain-text content of the moment
 * - <contentUrl>   — link URL (for link-type moments)
 * - <mediaList>    — list of <media> elements with image/video URLs
 * - <media><url type="1">  — CDN image/video URL
 * - <media><thumb type="1"> — thumbnail URL
 */

import { logger } from '@/utils/logger';

export interface ParsedMomentMedia {
  id: string;
  type: string; // "2" = image, "6" = video, etc.
  url: string;
  thumbUrl: string;
}

export interface ParsedMoment {
  /** Plain-text content */
  contentDesc: string;
  /** Content style: 1=image+text, 2=text-only, 3=link, 15=video, etc. */
  contentStyle: string;
  /** Media attachments */
  mediaList: ParsedMomentMedia[];
  /** Link URL (for link-type moments) */
  contentUrl: string;
  /** Link title (for link-type moments) */
  title: string;
}

/**
 * Decode base64 objectDesc buffer and parse the XML content.
 * Returns null if decoding/parsing fails.
 */
export function parseMomentObjectDesc(base64Buffer: string): ParsedMoment | null {
  try {
    const buf = Buffer.from(base64Buffer, 'base64');
    // The buffer may contain binary protobuf preamble before XML.
    // Find the XML start marker.
    const str = buf.toString('utf-8');
    const xmlStart = str.indexOf('<TimelineObject');
    if (xmlStart < 0) {
      // Some moments use <timelineobject> (lowercase) or may not have it at all
      const altStart = str.indexOf('<timelineobject');
      if (altStart < 0) {
        // Try to extract contentDesc directly from raw string
        return extractFromRawString(str);
      }
      return parseXml(str.slice(altStart));
    }
    return parseXml(str.slice(xmlStart));
  } catch (err) {
    logger.warn('[momentsParser] Failed to parse objectDesc:', err);
    return null;
  }
}

function parseXml(xml: string): ParsedMoment {
  const contentDesc = xmlTag(xml, 'contentDesc') ?? '';
  const contentStyle = xmlTag(xml, 'contentStyle') ?? '';
  const contentUrl = xmlTag(xml, 'contentUrl') ?? xmlTag(xml, 'url') ?? '';
  const title = xmlTag(xml, 'title') ?? '';

  // Parse media list
  const mediaList: ParsedMomentMedia[] = [];
  const mediaRegex = /<media>([\s\S]*?)<\/media>/gi;
  let match: RegExpExecArray | null;
  while ((match = mediaRegex.exec(xml)) !== null) {
    const block = match[1];
    const id = xmlTag(block, 'id') ?? '';
    const type = xmlTag(block, 'type') ?? '';
    // URL with type="1" is the full image, multiple url tags may exist
    const url = extractUrlWithType(block, 'url') ?? '';
    const thumbUrl = extractUrlWithType(block, 'thumb') ?? '';
    if (id || url) {
      mediaList.push({ id, type, url, thumbUrl });
    }
  }

  return { contentDesc, contentStyle, mediaList, contentUrl, title };
}

/** Extract from raw string when no XML wrapper is found. */
function extractFromRawString(raw: string): ParsedMoment | null {
  const contentDesc = xmlTag(raw, 'contentDesc');
  if (!contentDesc) return null;
  return {
    contentDesc,
    contentStyle: xmlTag(raw, 'contentStyle') ?? '',
    mediaList: [],
    contentUrl: '',
    title: '',
  };
}

/** Extract text content of a simple XML tag. */
function xmlTag(xml: string, tag: string): string | null {
  // Handle CDATA: <tag><![CDATA[content]]></tag>
  const cdataRe = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, 'i');
  const cdataMatch = cdataRe.exec(xml);
  if (cdataMatch) return cdataMatch[1];

  // Simple text content: <tag>content</tag>
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i');
  const m = re.exec(xml);
  return m ? m[1].trim() : null;
}

/** Extract URL value from <tagName type="1">url</tagName> pattern. */
function extractUrlWithType(block: string, tagName: string): string | null {
  // Try type="1" first (original quality)
  const re = new RegExp(`<${tagName}[^>]*>([^<]+)</${tagName}>`, 'i');
  const m = re.exec(block);
  return m ? m[1].trim() : null;
}

import fs from 'node:fs';
import path from 'node:path';

import { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES } from './media.mjs';
import { plain } from './util.mjs';

export const DRAFT_MEDIA_MAX = 10;
const HEADER_BYTES = 16;
const NAME_MAX = 200;
const QUICKTIME_BOXES = new Set(['moov', 'mdat', 'wide', 'free', 'skip']);
const QUICKTIME_BRAND = 'qt  ';
const BOX_HEADER_BYTES = 8;
const LARGE_BOX_HEADER_BYTES = 16;
const LARGE_BOX_SIZE_MARKER = 1;
const TO_END_OF_FILE_BOX_SIZE = 0;

const ascii = (bytes, from, to) => String.fromCharCode(...bytes.subarray(from, to));

function hasPlausibleFirstBox(b, fileSize) {
  if (b.length < BOX_HEADER_BYTES) {
    return false;
  }
  const size = b.readUInt32BE(0);
  if (size === TO_END_OF_FILE_BOX_SIZE) {
    return true;
  }
  if (size === LARGE_BOX_SIZE_MARKER) {
    if (b.length < LARGE_BOX_HEADER_BYTES) {
      return false;
    }
    const largeSize = b.readBigUInt64BE(BOX_HEADER_BYTES);
    return largeSize >= BigInt(LARGE_BOX_HEADER_BYTES) && largeSize <= BigInt(fileSize);
  }
  return size >= BOX_HEADER_BYTES && size <= fileSize;
}

const firstBoxTypeOf = (b, fileSize) => (hasPlausibleFirstBox(b, fileSize) ? ascii(b, 4, 8) : null);

const isFtyp = (b, fileSize) => firstBoxTypeOf(b, fileSize) === 'ftyp';

const isQuickTimeFtyp = (b, fileSize) => isFtyp(b, fileSize) && ascii(b, 8, 12) === QUICKTIME_BRAND;

function isQuickTime(b, fileSize) {
  return QUICKTIME_BOXES.has(firstBoxTypeOf(b, fileSize)) || isQuickTimeFtyp(b, fileSize);
}

const DRAFT_MEDIA_TYPES = [
  { mime: 'image/png', kind: 'image', maxBytes: MAX_IMAGE_BYTES, matches: (b) => b[0] === 0x89 && ascii(b, 1, 4) === 'PNG' },
  { mime: 'image/jpeg', kind: 'image', maxBytes: MAX_IMAGE_BYTES, matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', kind: 'image', maxBytes: MAX_IMAGE_BYTES, matches: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP' },
  { mime: 'image/gif', kind: 'image', maxBytes: MAX_IMAGE_BYTES, matches: (b) => ascii(b, 0, 4) === 'GIF8' },
  { mime: 'video/webm', kind: 'video', maxBytes: MAX_VIDEO_BYTES, matches: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  { mime: 'video/mp4', kind: 'video', maxBytes: MAX_VIDEO_BYTES, matches: (b, fileSize) => isFtyp(b, fileSize) && !isQuickTimeFtyp(b, fileSize) },
  { mime: 'video/quicktime', kind: 'video', maxBytes: MAX_VIDEO_BYTES, matches: isQuickTime },
];

export const ACCEPTED_MEDIA = 'PNG, JPEG, WebP or GIF images and WebM, MP4 or MOV videos';

export class DraftMediaError extends Error {
  constructor(file, reason) {
    super(`${file}: ${reason}`);
    this.file = file;
    this.reason = reason;
  }
}

export const mediaTypeOf = (bytes, fileSize = bytes.length) => DRAFT_MEDIA_TYPES.find((type) => type.matches(bytes, fileSize)) ?? null;

const megabytes = (bytes) => `${bytes / 1024 / 1024} MB`;

function checkSize(file, type, size) {
  if (size === 0) {
    throw new DraftMediaError(file, 'the file is empty');
  }
  if (size > type.maxBytes) {
    throw new DraftMediaError(file, `the ${type.kind} is ${size} bytes; Pulse takes ${type.kind}s up to ${megabytes(type.maxBytes)}`);
  }
}

function readHeader(file) {
  const handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const header = Buffer.alloc(HEADER_BYTES);
    const read = fs.readSync(handle, header, 0, HEADER_BYTES, 0);
    return header.subarray(0, read);
  } finally {
    fs.closeSync(handle);
  }
}

function lstatOrFail(file) {
  try {
    return fs.lstatSync(file);
  } catch (err) {
    throw new DraftMediaError(file, err?.code === 'ENOENT' ? 'there is no such file' : `the file cannot be read (${err?.code ?? 'error'})`);
  }
}

const displayNameOf = (file, name) => {
  const given = typeof name === 'string' ? plain(name, NAME_MAX).trim() : '';
  return given || path.basename(file);
};

function checkOne(item, index) {
  const file = typeof item?.path === 'string' ? item.path : '';
  const label = file || `media[${index}]`;
  if (!file || !path.isAbsolute(file)) {
    throw new DraftMediaError(label, 'the path must be absolute');
  }
  const stat = lstatOrFail(file);
  if (stat.isSymbolicLink()) {
    throw new DraftMediaError(file, 'the path is a symbolic link; pass the file itself');
  }
  if (!stat.isFile()) {
    throw new DraftMediaError(file, 'the path is not a regular file');
  }
  const type = mediaTypeOf(readHeader(file), stat.size);
  if (!type) {
    throw new DraftMediaError(file, `the file is not one of ${ACCEPTED_MEDIA}`);
  }
  checkSize(file, type, stat.size);
  return { path: file, name: displayNameOf(file, item?.name), mime: type.mime };
}

export function checkDraftMedia(media) {
  if (media === undefined) {
    return [];
  }
  if (!Array.isArray(media) || media.length > DRAFT_MEDIA_MAX) {
    throw new DraftMediaError('media', `pass a list of at most ${DRAFT_MEDIA_MAX} files`);
  }
  const files = media.map(checkOne);
  const repeated = files.find((file, index) => files.findIndex((other) => other.path === file.path) !== index);
  if (repeated) {
    throw new DraftMediaError(repeated.path, 'the file is listed twice');
  }
  return files;
}

export function readCheckedMedia(file) {
  const bytes = fs.readFileSync(file.path, { flag: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) });
  const type = mediaTypeOf(bytes);
  if (type?.mime !== file.mime) {
    throw new DraftMediaError(file.path, 'the file changed after it was checked');
  }
  checkSize(file.path, type, bytes.byteLength);
  return bytes;
}

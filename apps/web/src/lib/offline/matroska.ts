/**
 * Reads subtitle tracks out of a Matroska file in place. Mediabunny, which
 * remuxes the audio and video, skips subtitle tracks, and no maintained
 * library reads Matroska subtitles from a Blob with random access, so this
 * walks just enough EBML: the track list, the cue index, font attachments,
 * and the clusters near the playhead.
 */

/** One subtitle track, in the order the file lists its tracks. */
export type SubtitleTrack = {
  number: number;
  codecId: string;
  /** The track's header: the ASS script info and styles, the VobSub index. */
  codecPrivate: Uint8Array | null;
};

/** One subtitle block; times in seconds, `end` null when the file gives no duration. */
export type SubtitleBlock = {
  track: number;
  start: number;
  end: number | null;
  data: Uint8Array;
};

export type MatroskaSubtitles = {
  tracks: SubtitleTrack[];
  /** The file's attached fonts, which ASS styles name. */
  fonts(): Promise<Uint8Array[]>;
  /**
   * The subtitle blocks in the clusters from the one holding `from` up to
   * `to`. Each cluster is read once; a later call returns only new blocks.
   */
  read(from: number, to: number): Promise<SubtitleBlock[]>;
};

const ids = {
  ebml: 0x1a45dfa3,
  segment: 0x18538067,
  seekHead: 0x114d9b74,
  seek: 0x4dbb,
  seekId: 0x53ab,
  seekPosition: 0x53ac,
  info: 0x1549a966,
  timestampScale: 0x2ad7b1,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackType: 0x83,
  codecId: 0x86,
  codecPrivate: 0x63a2,
  contentEncodings: 0x6d80,
  contentEncoding: 0x6240,
  contentCompression: 0x5034,
  contentCompAlgo: 0x4254,
  contentCompSettings: 0x4255,
  cues: 0x1c53bb6b,
  cuePoint: 0xbb,
  cueTime: 0xb3,
  cueTrackPositions: 0xb7,
  cueClusterPosition: 0xf1,
  attachments: 0x1941a469,
  attachedFile: 0x61a7,
  fileName: 0x466e,
  fileMediaType: 0x4660,
  fileData: 0x465c,
  cluster: 0x1f43b675,
  timestamp: 0xe7,
  simpleBlock: 0xa3,
  blockGroup: 0xa0,
  block: 0xa1,
  blockDuration: 0x9b,
} as const;

const subtitleType = 0x11;
const zlib = 0;
const headerStripping = 3;
// An element header is at most a 4-byte id and an 8-byte size.
const headerBytes = 12;

type Element = { id: number; start: number; size: number; end: number };

/** Reads a variable-length integer at `at`; `marker` keeps the length bits, as ids do. */
function varInt(bytes: Uint8Array, at: number, marker: boolean) {
  const first = bytes[at];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23;
  if (at + length > bytes.length) return null;
  let value = marker ? first : first & (0xff >> length);
  let unknown = value === 0xff >> length;
  for (let index = 1; index < length; index += 1) {
    const byte = bytes[at + index] ?? 0;
    value = value * 256 + byte;
    if (byte !== 0xff) unknown = false;
  }
  return { value, length, unknown: !marker && unknown };
}

/** Reads the children of an element held in memory. */
function* children(bytes: Uint8Array, from = 0, to = bytes.length) {
  let at = from;
  while (at < to) {
    const id = varInt(bytes, at, true);
    if (id === null) return;
    const size = varInt(bytes, at + id.length, false);
    if (size === null) return;
    const start = at + id.length + size.length;
    const end = size.unknown ? to : Math.min(to, start + size.value);
    yield { id: id.value, start, size: end - start, end } satisfies Element;
    at = end;
  }
}

const uint = (bytes: Uint8Array, element: Element) => {
  let value = 0;
  for (let at = element.start; at < element.end; at += 1)
    value = value * 256 + (bytes[at] ?? 0);
  return value;
};

const text = (bytes: Uint8Array, element: Element) =>
  new TextDecoder().decode(bytes.subarray(element.start, element.end));

async function slice(file: Blob, start: number, end: number) {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

/** Reads the header of the element at `at` in the file; an unknown size runs to the end of the file. */
async function header(
  file: Blob,
  at: number,
): Promise<(Element & { unknown: boolean }) | null> {
  const bytes = await slice(file, at, at + headerBytes);
  const id = varInt(bytes, 0, true);
  if (id === null) return null;
  const size = varInt(bytes, id.length, false);
  if (size === null) return null;
  const start = at + id.length + size.length;
  const end = size.unknown ? file.size : start + size.value;
  return { id: id.value, start, size: end - start, end, unknown: size.unknown };
}

async function inflate(data: Uint8Array) {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

type TrackEntry = SubtitleTrack & {
  type: number;
  decode: (data: Uint8Array) => Promise<Uint8Array>;
};

function trackEntry(bytes: Uint8Array, entry: Element): TrackEntry {
  const track: TrackEntry = {
    number: 0,
    type: 0,
    codecId: "",
    codecPrivate: null,
    decode: async (data) => data,
  };
  for (const field of children(bytes, entry.start, entry.end)) {
    if (field.id === ids.trackNumber) track.number = uint(bytes, field);
    else if (field.id === ids.trackType) track.type = uint(bytes, field);
    else if (field.id === ids.codecId) track.codecId = text(bytes, field);
    else if (field.id === ids.codecPrivate)
      track.codecPrivate = bytes.slice(field.start, field.end);
    else if (field.id === ids.contentEncodings) {
      for (const encoding of children(bytes, field.start, field.end))
        for (const part of children(bytes, encoding.start, encoding.end)) {
          if (part.id !== ids.contentCompression) continue;
          let algorithm = zlib;
          let settings = new Uint8Array(0);
          for (const option of children(bytes, part.start, part.end)) {
            if (option.id === ids.contentCompAlgo)
              algorithm = uint(bytes, option);
            if (option.id === ids.contentCompSettings)
              settings = bytes.slice(option.start, option.end);
          }
          if (algorithm === zlib) track.decode = inflate;
          else if (algorithm === headerStripping)
            track.decode = async (data) => {
              const whole = new Uint8Array(settings.length + data.length);
              whole.set(settings);
              whole.set(data, settings.length);
              return whole;
            };
        }
    }
  }
  return track;
}

/** Opens the subtitle tracks of a Matroska file; null for any other file. */
export async function openMatroskaSubtitles(
  file: Blob,
): Promise<MatroskaSubtitles | null> {
  const ebml = await header(file, 0);
  if (ebml?.id !== ids.ebml) return null;
  const segment = await header(file, ebml.end);
  if (segment?.id !== ids.segment) return null;
  const base = segment.start;

  // Level-one elements up to the first cluster, plus what the seek head
  // points past it (cues usually sit at the end).
  const level1 = new Map<number, number>();
  let firstCluster: number | null = null;
  for (let at = base; at < segment.end; ) {
    const element = await header(file, at);
    if (element === null) break;
    if (element.id === ids.cluster) {
      firstCluster = at;
      break;
    }
    if (!level1.has(element.id)) level1.set(element.id, at);
    if (element.id === ids.seekHead) {
      const bytes = await slice(file, element.start, element.end);
      for (const seek of children(bytes)) {
        if (seek.id !== ids.seek) continue;
        let id = 0;
        let position = 0;
        for (const field of children(bytes, seek.start, seek.end)) {
          if (field.id === ids.seekId) id = uint(bytes, field);
          if (field.id === ids.seekPosition) position = uint(bytes, field);
        }
        if (!level1.has(id)) level1.set(id, base + position);
      }
    }
    at = element.end;
  }

  const read = async (id: number) => {
    const at = level1.get(id);
    if (at === undefined) return null;
    const element = await header(file, at);
    if (element?.id !== id) return null;
    return slice(file, element.start, element.end);
  };

  let scale = 1_000_000;
  const info = await read(ids.info);
  if (info !== null)
    for (const field of children(info))
      if (field.id === ids.timestampScale) scale = uint(info, field);
  const seconds = (ticks: number) => (ticks * scale) / 1e9;

  const trackBytes = await read(ids.tracks);
  const entries =
    trackBytes === null
      ? []
      : [...children(trackBytes)]
          .filter((element) => element.id === ids.trackEntry)
          .map((element) => trackEntry(trackBytes, element))
          .filter((track) => track.type === subtitleType);
  const byNumber = new Map(entries.map((track) => [track.number, track]));

  // Cluster positions by time, from the cues; without cues, every cluster's
  // header is walked once.
  const clusters = new Map<number, number>();
  const cueBytes = await read(ids.cues);
  if (cueBytes !== null)
    for (const point of children(cueBytes)) {
      if (point.id !== ids.cuePoint) continue;
      let time = 0;
      for (const field of children(cueBytes, point.start, point.end)) {
        if (field.id === ids.cueTime) time = uint(cueBytes, field);
        if (field.id !== ids.cueTrackPositions) continue;
        for (const position of children(cueBytes, field.start, field.end))
          if (position.id === ids.cueClusterPosition) {
            const at = base + uint(cueBytes, position);
            clusters.set(at, Math.min(clusters.get(at) ?? time, time));
          }
      }
    }
  if (clusters.size === 0 && firstCluster !== null)
    for (let at = firstCluster; at < segment.end; ) {
      const element = await header(file, at);
      if (element === null) break;
      if (element.id === ids.cluster) {
        const head = await slice(file, element.start, element.start + 16);
        const [first] = children(head);
        if (first?.id === ids.timestamp) clusters.set(at, uint(head, first));
      }
      at = element.end;
    }
  const index = [...clusters]
    .map(([at, time]) => ({ at, time: seconds(time) }))
    .sort((a, b) => a.time - b.time);
  const done = new Set<number>();

  async function readCluster(at: number): Promise<SubtitleBlock[]> {
    const element = await header(file, at);
    // A cluster of unknown size would mean reading the rest of the file.
    if (element?.id !== ids.cluster || element.unknown) return [];
    const bytes = await slice(file, element.start, element.end);
    const blocks: SubtitleBlock[] = [];
    let time = 0;
    const block = async (
      start: number,
      end: number,
      duration: number | null,
    ) => {
      const number = varInt(bytes, start, false);
      if (number === null) return;
      const track = byNumber.get(number.value);
      // Laced blocks carry several frames; subtitles are never laced.
      const flags = bytes[start + number.length + 2] ?? 0;
      if (track === undefined || (flags & 0x06) !== 0) return;
      const view = new DataView(bytes.buffer, bytes.byteOffset);
      const relative = view.getInt16(start + number.length);
      const begin = seconds(time + relative);
      blocks.push({
        track: track.number,
        start: begin,
        end: duration === null ? null : begin + seconds(duration),
        data: await track.decode(bytes.slice(start + number.length + 3, end)),
      });
    };
    for (const child of children(bytes)) {
      if (child.id === ids.timestamp) time = uint(bytes, child);
      else if (child.id === ids.simpleBlock)
        await block(child.start, child.end, null);
      else if (child.id === ids.blockGroup) {
        let inner: Element | undefined;
        let duration: number | null = null;
        for (const part of children(bytes, child.start, child.end)) {
          if (part.id === ids.block) inner = part;
          if (part.id === ids.blockDuration) duration = uint(bytes, part);
        }
        if (inner !== undefined) await block(inner.start, inner.end, duration);
      }
    }
    return blocks;
  }

  return {
    tracks: entries.map(({ number, codecId, codecPrivate }) => ({
      number,
      codecId,
      codecPrivate,
    })),
    async fonts() {
      const bytes = await read(ids.attachments);
      if (bytes === null) return [];
      const fonts: Uint8Array[] = [];
      for (const attached of children(bytes)) {
        if (attached.id !== ids.attachedFile) continue;
        let name = "";
        let type = "";
        let data: Uint8Array | null = null;
        for (const field of children(bytes, attached.start, attached.end)) {
          if (field.id === ids.fileName) name = text(bytes, field);
          if (field.id === ids.fileMediaType) type = text(bytes, field);
          if (field.id === ids.fileData)
            data = bytes.slice(field.start, field.end);
        }
        const font =
          /font|truetype|opentype/i.test(type) ||
          /\.(ttf|otf|ttc|woff2?)$/i.test(name);
        if (font && data !== null) fonts.push(data);
      }
      return fonts;
    },
    async read(from, to) {
      if (entries.length === 0) return [];
      const first = Math.max(
        0,
        index.findLastIndex((cluster) => cluster.time <= from),
      );
      const blocks: SubtitleBlock[] = [];
      for (const cluster of index.slice(first)) {
        if (cluster.time >= to) break;
        if (done.has(cluster.at)) continue;
        done.add(cluster.at);
        blocks.push(...(await readCluster(cluster.at)));
      }
      return blocks;
    },
  };
}

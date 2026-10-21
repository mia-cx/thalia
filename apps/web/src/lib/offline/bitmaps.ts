import type { SubtitleBlock } from "./matroska.ts";

/**
 * Image subtitles (Blu-ray PGS, DVD VobSub) drawn on a canvas over the
 * video. Online the server burns them in; offline the browser decodes each
 * packet into positioned images and draws whichever frame is current.
 */

/** One caption image on the subtitle plane; its pixels decode on first use. */
type Placed = {
  x: number;
  y: number;
  width: number;
  height: number;
  rgba: () => Uint8ClampedArray<ArrayBuffer>;
};

/** What a track shows from `start` on a plane of `width` by `height`; no images clears it. */
export type BitmapFrame = {
  start: number;
  /** When the frame ends by itself; null shows it until the next. */
  end: number | null;
  width: number;
  height: number;
  images: Placed[];
};

const u16 = (data: Uint8Array, at: number) =>
  ((data[at] ?? 0) << 8) | (data[at + 1] ?? 0);

/** Limited-range YCbCr to RGBA: BT.709 for HD planes, BT.601 below. */
function rgba(y: number, cr: number, cb: number, alpha: number, hd: boolean) {
  const luma = 1.164 * (y - 16);
  const [rv, gu, gv, bu] = hd
    ? [1.793, 0.213, 0.533, 2.112]
    : [1.596, 0.392, 0.813, 2.017];
  const clamp = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)));
  return [
    clamp(luma + rv * (cr - 128)),
    clamp(luma - gu * (cb - 128) - gv * (cr - 128)),
    clamp(luma + bu * (cb - 128)),
    alpha,
  ] as const;
}

/** Expands PGS run-length data into RGBA through a 256-entry palette. */
function pgsPixels(
  data: Uint8Array,
  width: number,
  height: number,
  palette: Uint8ClampedArray,
) {
  const out = new Uint8ClampedArray(width * height * 4);
  let at = 0;
  let pixel = 0;
  const put = (count: number, color: number) => {
    for (let index = 0; index < count && pixel < width * height; index += 1) {
      out.set(palette.subarray(color * 4, color * 4 + 4), pixel * 4);
      pixel += 1;
    }
  };
  while (at < data.length && pixel < width * height) {
    const first = data[at++] ?? 0;
    if (first !== 0) {
      put(1, first);
      continue;
    }
    const flags = data[at++] ?? 0;
    if (flags === 0) {
      // End of line: the next line starts at the next row.
      const row = Math.ceil(pixel / width);
      pixel = row * width;
      continue;
    }
    const long = (flags & 0x40) !== 0;
    const count = long
      ? ((flags & 0x3f) << 8) | (data[at++] ?? 0)
      : flags & 0x3f;
    put(count, (flags & 0x80) !== 0 ? (data[at++] ?? 0) : 0);
  }
  return out;
}

/**
 * Decodes a PGS track's blocks in file order into frames. Each block is a
 * display set: palettes, objects and a composition naming which objects
 * show where. A forced-only track shows only objects flagged forced.
 */
export function pgsDecoder(forcedOnly: boolean) {
  const palettes = new Map<number, Uint8ClampedArray>();
  const objects = new Map<
    number,
    { width: number; height: number; chunks: Uint8Array[] }
  >();
  return (block: SubtitleBlock): BitmapFrame | null => {
    const data = block.data;
    let composition:
      | {
          width: number;
          height: number;
          palette: number;
          shown: { id: number; x: number; y: number; forced: boolean }[];
        }
      | undefined;
    for (let at = 0; at + 3 <= data.length; ) {
      const type = data[at] ?? 0;
      const size = u16(data, at + 1);
      const body = data.subarray(at + 3, at + 3 + size);
      at += 3 + size;
      if (type === 0x16) {
        const count = body[10] ?? 0;
        const shown = [];
        for (let entry = 11, index = 0; index < count; index += 1) {
          const flags = body[entry + 3] ?? 0;
          shown.push({
            id: u16(body, entry),
            forced: (flags & 0x40) !== 0,
            x: u16(body, entry + 4),
            y: u16(body, entry + 6),
          });
          entry += (flags & 0x80) !== 0 ? 16 : 8;
        }
        composition = {
          width: u16(body, 0),
          height: u16(body, 2),
          palette: body[9] ?? 0,
          shown,
        };
      } else if (type === 0x14) {
        const hd = (composition?.height ?? 1080) > 576;
        const palette =
          palettes.get(body[0] ?? 0) ?? new Uint8ClampedArray(1024);
        for (let entry = 2; entry + 5 <= body.length; entry += 5)
          palette.set(
            rgba(
              body[entry + 1] ?? 0,
              body[entry + 2] ?? 0,
              body[entry + 3] ?? 0,
              body[entry + 4] ?? 0,
              hd,
            ),
            (body[entry] ?? 0) * 4,
          );
        palettes.set(body[0] ?? 0, palette);
      } else if (type === 0x15) {
        const id = u16(body, 0);
        if (((body[3] ?? 0) & 0x80) !== 0)
          objects.set(id, {
            width: u16(body, 7),
            height: u16(body, 9),
            chunks: [body.slice(11)],
          });
        else objects.get(id)?.chunks.push(body.slice(4));
      }
    }
    if (composition === undefined) return null;
    // A later display set may update the palette in place; this frame keeps its colours.
    const palette =
      palettes.get(composition.palette)?.slice() ?? new Uint8ClampedArray(1024);
    return {
      start: block.start,
      end: null,
      width: composition.width,
      height: composition.height,
      images: composition.shown
        .filter((shown) => !forcedOnly || shown.forced)
        .flatMap((shown) => {
          const object = objects.get(shown.id);
          if (object === undefined) return [];
          const data = new Uint8Array(
            object.chunks.reduce((sum, chunk) => sum + chunk.length, 0),
          );
          let offset = 0;
          for (const chunk of object.chunks) {
            data.set(chunk, offset);
            offset += chunk.length;
          }
          return [
            {
              x: shown.x,
              y: shown.y,
              width: object.width,
              height: object.height,
              rgba: () => pgsPixels(data, object.width, object.height, palette),
            },
          ];
        }),
    };
  };
}

// VobSub control dates count in units of 1024 ticks of a 90 kHz clock.
const vobSubTick = 1024 / 90_000;

/** Reads the `size:` and `palette:` lines of a VobSub index. */
function vobSubIndex(codecPrivate: Uint8Array | null) {
  const text =
    codecPrivate === null ? "" : new TextDecoder().decode(codecPrivate);
  const size = /size:\s*(\d+)x(\d+)/.exec(text);
  const colors = /palette:\s*([0-9a-f, ]+)/i
    .exec(text)?.[1]
    ?.split(",")
    .map((hex) => Number.parseInt(hex.trim(), 16));
  return {
    width: Number(size?.[1] ?? 720),
    height: Number(size?.[2] ?? 480),
    colors: colors ?? [],
  };
}

/**
 * Decodes a VobSub track's subpictures. Each packet carries interlaced
 * 2-bit run-length fields, four of the index's sixteen colours with their
 * alpha, the image's rectangle, and when it starts and stops showing.
 */
export function vobSubDecoder(codecPrivate: Uint8Array | null) {
  const index = vobSubIndex(codecPrivate);
  return (block: SubtitleBlock): BitmapFrame | null => {
    const data = block.data;
    let start = 0;
    let stop: number | null = null;
    let colors = [0, 0, 0, 0];
    let alphas = [0, 0, 0, 0];
    let box = { x1: 0, x2: -1, y1: 0, y2: -1 };
    let fields = [0, 0];
    for (let sequence = u16(data, 2); sequence + 4 <= data.length; ) {
      const date = u16(data, sequence) * vobSubTick;
      const next = u16(data, sequence + 2);
      let at = sequence + 4;
      for (
        let command = data[at++];
        command !== 0xff && at <= data.length;
        command = data[at++]
      ) {
        if (command === 0x01) start = date;
        else if (command === 0x02) stop = date;
        else if (command === 0x03 || command === 0x04) {
          const pair = [data[at] ?? 0, data[at + 1] ?? 0] as const;
          const nibbles = [
            pair[1] & 15,
            pair[1] >> 4,
            pair[0] & 15,
            pair[0] >> 4,
          ];
          if (command === 0x03) colors = nibbles;
          else alphas = nibbles;
          at += 2;
        } else if (command === 0x05) {
          const b = data.subarray(at, at + 6);
          box = {
            x1: ((b[0] ?? 0) << 4) | ((b[1] ?? 0) >> 4),
            x2: (((b[1] ?? 0) & 15) << 8) | (b[2] ?? 0),
            y1: ((b[3] ?? 0) << 4) | ((b[4] ?? 0) >> 4),
            y2: (((b[4] ?? 0) & 15) << 8) | (b[5] ?? 0),
          };
          at += 6;
        } else if (command === 0x06) {
          fields = [u16(data, at), u16(data, at + 2)];
          at += 4;
        }
      }
      if (next === sequence) break;
      sequence = next;
    }
    const width = box.x2 - box.x1 + 1;
    const height = box.y2 - box.y1 + 1;
    const frame: BitmapFrame = {
      start: block.start + start,
      end: stop === null ? null : block.start + stop,
      width: index.width,
      height: index.height,
      images: [],
    };
    if (width <= 0 || height <= 0) return frame;
    const palette = colors.map((color, entry) => {
      const rgb = index.colors[color] ?? 0;
      return [
        rgb >> 16,
        (rgb >> 8) & 255,
        rgb & 255,
        ((alphas[entry] ?? 0) * 255) / 15,
      ];
    });
    frame.images.push({
      x: box.x1,
      y: box.y1,
      width,
      height,
      rgba: () => {
        const out = new Uint8ClampedArray(width * height * 4);
        for (let line = 0; line < height; line += 1) {
          // Even lines come from the top field, odd ones from the bottom.
          const field = line % 2;
          let nibble = (fields[field] ?? 0) * 2;
          const read = () => {
            const byte = data[nibble >> 1] ?? 0;
            const value = nibble % 2 === 0 ? byte >> 4 : byte & 15;
            nibble += 1;
            return value;
          };
          for (let x = 0; x < width; ) {
            let code = read();
            if (code < 0x4) code = (code << 4) | read();
            if (code < 0x10) code = (code << 4) | read();
            if (code < 0x40) code = (code << 4) | read();
            const count = code >> 2 === 0 ? width - x : code >> 2;
            const color = palette[code & 3] ?? [0, 0, 0, 0];
            for (let run = 0; run < count && x < width; run += 1, x += 1)
              out.set(color, (line * width + x) * 4);
          }
          // Lines start on a byte boundary.
          nibble += nibble % 2;
          fields[field] = nibble / 2;
        }
        return out;
      },
    });
    return frame;
  };
}

/**
 * Draws bitmap frames on a canvas laid over the video's picture, scaled to
 * its displayed size. The current frame is redrawn only when it changes,
 * and the next one's images decode ahead of it.
 */
export function bitmapOverlay(video: HTMLVideoElement) {
  const canvas = document.createElement("canvas");
  canvas.dataset.subtitles = "";
  canvas.style.position = "absolute";
  canvas.style.pointerEvents = "none";
  video.insertAdjacentElement("afterend", canvas);
  const context = canvas.getContext("2d");
  const frames: BitmapFrame[] = [];
  const bitmaps = new Map<BitmapFrame, Promise<ImageBitmap[]>>();
  let drawn: BitmapFrame | null | undefined;
  let closed = false;

  const imagesOf = (frame: BitmapFrame) => {
    let images = bitmaps.get(frame);
    if (images === undefined) {
      images = Promise.all(
        frame.images.map((image) =>
          createImageBitmap(
            new ImageData(image.rgba(), image.width, image.height),
          ),
        ),
      );
      bitmaps.set(frame, images);
    }
    return images;
  };

  // The picture's box inside the element, as object-fit: contain lays it out.
  const place = () => {
    const box = video.getBoundingClientRect();
    const parent = video.offsetParent?.getBoundingClientRect() ?? box;
    const ratio = (video.videoWidth || 16) / (video.videoHeight || 9);
    const width = Math.min(box.width, box.height * ratio);
    const height = width / ratio;
    canvas.style.left = `${box.left - parent.left + (box.width - width) / 2}px`;
    canvas.style.top = `${box.top - parent.top + (box.height - height) / 2}px`;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  };
  const resized = new ResizeObserver(place);
  resized.observe(video);
  video.addEventListener("loadedmetadata", place);

  /** The last frame started by `time`, unless it already ended. */
  const current = (time: number) => {
    let low = 0;
    let high = frames.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if ((frames[middle]?.start ?? 0) <= time) {
        found = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    const frame = frames[found];
    if (frame === undefined || (frame.end !== null && time >= frame.end))
      return { frame: null, next: frames[found + 1] };
    return { frame, next: frames[found + 1] };
  };

  const render = (time: number) => {
    const { frame, next } = current(time);
    if (next !== undefined) void imagesOf(next);
    if (frame === drawn) return;
    drawn = frame;
    if (context === null) return;
    if (frame === null) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    void imagesOf(frame).then((images) => {
      if (drawn !== frame || closed) return;
      canvas.width = frame.width;
      canvas.height = frame.height;
      for (const [index, image] of images.entries()) {
        const placed = frame.images[index];
        if (placed !== undefined) context.drawImage(image, placed.x, placed.y);
      }
    });
  };

  // Each presented video frame redraws if the caption changed; seeks and
  // pauses redraw on their own events.
  const onFrame = (_: number, metadata: VideoFrameCallbackMetadata) => {
    if (closed) return;
    render(metadata.mediaTime);
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);
  const onSeeked = () => render(video.currentTime);
  video.addEventListener("seeked", onSeeked);

  return {
    /** Adds a decoded frame; frames may arrive in any order. */
    add(frame: BitmapFrame) {
      let at = frames.length;
      while (at > 0 && (frames[at - 1]?.start ?? 0) > frame.start) at -= 1;
      frames.splice(at, 0, frame);
      // A frame landing on the current time shows without waiting for the next video frame.
      drawn = undefined;
      render(video.currentTime);
    },
    close() {
      closed = true;
      resized.disconnect();
      video.removeEventListener("loadedmetadata", place);
      video.removeEventListener("seeked", onSeeked);
      for (const images of bitmaps.values())
        void images.then((list) => {
          for (const image of list) image.close();
        });
      canvas.remove();
    },
  };
}

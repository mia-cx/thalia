import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Options for {@link createVideoFixture}. */
export interface VideoFixtureOptions {
  width?: number;
  height?: number;
  /** Chapter list, or true for today's single "Opening" chapter. */
  chapters?:
    | boolean
    | readonly { title: string; startSeconds: number; endSeconds: number }[];
  durationSeconds?: number;
  frameRate?: number;
  gopSeconds?: number;
  pattern?: "color" | "testsrc2";
  videoCodec?: "h264" | "hevc";
  /** Tags a 10-bit HEVC video with this transfer function; needs videoCodec "hevc". */
  hdr?: "hdr10" | "hlg";
  audioCodec?: "aac" | "ac3" | "dts" | "flac" | "truehd";
  audioChannels?: 2 | 6;
  /** The first audio Stream carries a 440 Hz tone from this second on, silent before; default silent throughout. */
  toneFrom?: number;
  /** Adds a second audio Stream, Japanese stereo AAC carrying a 440 Hz tone; the first stays silent. */
  toneAudio?: boolean;
  /** Subtitle Streams in order, each showing "Fixture" for `subtitleTime`; default one SRT. */
  subtitles?: readonly (keyof typeof subtitleFormats)[];
  /** Flags the PGS fixture's caption as forced, as a forced-only track's are. */
  pgsForced?: boolean;
  /** When the subtitles show; default 0 to 0.8 s. */
  subtitleTime?: SubtitleTime;
}

/** Where the PGS fixture draws its white box, in video pixels. */
export function pgsFixtureBox(width: number, height: number) {
  const boxWidth = Math.floor(width / 2);
  const boxHeight = Math.floor(height / 6);
  return {
    x: Math.floor((width - boxWidth) / 2),
    y: height - 2 * boxHeight,
    width: boxWidth,
    height: boxHeight,
  };
}

const u16 = (value: number) => [value >> 8, value & 255];

// One PGS segment: magic, pts at 90 kHz, dts, type and length, then the body.
const pgsSegment = (seconds: number, type: number, body: number[]) => {
  const ticks = Math.round(seconds * 90_000);
  return [
    0x50,
    0x47,
    (ticks >>> 24) & 255,
    (ticks >>> 16) & 255,
    (ticks >>> 8) & 255,
    ticks & 255,
    0,
    0,
    0,
    0,
    type,
    ...u16(body.length),
    ...body,
  ];
};

/** When the fixture's subtitles show, in seconds. */
type SubtitleTime = { start: number; end: number };

// How each subtitle format is written for ffmpeg to read, and what it muxes
// as. VobSub is the PGS box re-encoded by ffmpeg's dvdsub encoder, which
// takes only bitmaps.
const subtitleFormats = {
  srt: { file: "srt", codec: "srt" },
  ass: { file: "ass", codec: "ass" },
  pgs: { file: "sup", codec: "copy" },
  vobsub: { file: "sup", codec: "dvdsub" },
} as const;

/** Builds a `.sup` that shows a white box for `time`; ffmpeg has no PGS encoder. */
function pgsFixture(
  width: number,
  height: number,
  time: SubtitleTime,
  forced: boolean,
) {
  const { start, end } = time;
  const box = pgsFixtureBox(width, height);
  const video = [...u16(width), ...u16(height), 0x10];
  const window = [0, ...u16(box.x), ...u16(box.y), ...u16(box.width)];
  window.push(...u16(box.height));
  // Each line is one run of palette entry 1, then the end-of-line marker.
  const line = [0, 0xc0 | (box.width >> 8), box.width & 255, 1, 0, 0];
  const rle = Array.from({ length: box.height }, () => line).flat();
  const objectLength = rle.length + 4;
  // Epoch start: composition, window, palette, object, end. `alpha` 0 draws
  // the box invisible.
  const displaySet = (at: number, alpha: number) => [
    ...pgsSegment(at, 0x16, [
      ...video,
      ...u16(0),
      0x80,
      0,
      0,
      1,
      ...u16(0),
      0,
      // The object's flags: 0x40 marks a forced caption.
      forced ? 0x40 : 0,
      ...u16(box.x),
      ...u16(box.y),
    ]),
    ...pgsSegment(at, 0x17, [1, ...window]),
    ...pgsSegment(at, 0x14, [0, 0, 1, 235, 128, 128, alpha]),
    ...pgsSegment(at, 0x15, [
      ...u16(0),
      0,
      0xc0,
      (objectLength >> 16) & 255,
      ...u16(objectLength & 0xffff),
      ...u16(box.width),
      ...u16(box.height),
      ...rle,
    ]),
    ...pgsSegment(at, 0x80, []),
  ];
  return new Uint8Array([
    // ffmpeg starts a `.sup` at its first caption, so an invisible one at
    // zero keeps a later caption at its own time.
    ...(start > 0 ? displaySet(0, 0) : []),
    ...displaySet(start, 255),
    // An empty composition clears the screen.
    ...pgsSegment(end, 0x16, [...video, ...u16(1), 0, 0, 0, 0]),
    ...pgsSegment(end, 0x17, [1, ...window]),
    ...pgsSegment(end, 0x80, []),
  ]);
}

// h:mm:ss.cc for ASS, hh:mm:ss,mmm for SubRip.
const clock = (seconds: number, fraction: 2 | 3, hourDigits: 1 | 2) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const whole = Math.floor(rest);
  const part = Math.round((rest - whole) * 10 ** fraction);
  return `${String(hours).padStart(hourDigits, "0")}:${String(minutes).padStart(2, "0")}:${String(whole).padStart(2, "0")}${fraction === 2 ? "." : ","}${String(part).padStart(fraction, "0")}`;
};

const assFixture = ({ start, end }: SubtitleTime) =>
  [
    "[Script Info]",
    "ScriptType: v4.00+",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, Bold, Italic, Alignment, MarginL, MarginR, MarginV",
    "Style: Default,Sans,20,&H00FFFFFF,0,0,2,10,10,10",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    `Dialogue: 0,${clock(start, 2, 1)},${clock(end, 2, 1)},Default,,0,0,0,,{\\i1}Fixture{\\i0}`,
    "",
  ].join("\n");

/** Generate a short real MKV with video, silent audio and subtitles; h264, stereo AAC and one SRT by default. */
export async function createVideoFixture(
  path: string,
  options: VideoFixtureOptions = {},
): Promise<void> {
  const {
    width = 1920,
    height = 1080,
    chapters = false,
    durationSeconds = 1,
    frameRate = 2,
    gopSeconds,
    pattern = "color",
    videoCodec = "h264",
    hdr,
    audioCodec = "aac",
    audioChannels = 2,
    toneAudio = false,
    toneFrom,
    subtitles = ["srt"],
    subtitleTime = { start: 0, end: 0.8 },
    pgsForced = false,
  } = options;
  if (hdr !== undefined && videoCodec !== "hevc") {
    throw new Error("An HDR fixture needs HEVC video.");
  }
  const layout = audioChannels === 6 ? "5.1" : "stereo";
  const source =
    pattern === "testsrc2"
      ? `testsrc2=s=${width}x${height}:r=${frameRate}:d=${durationSeconds}`
      : `color=c=black:s=${width}x${height}:r=${frameRate}:d=${durationSeconds}`;
  const gopFrames =
    gopSeconds === undefined ? undefined : Math.round(gopSeconds * frameRate);
  const h264 = [
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    // testsrc2 at 1080p is too slow to encode on one thread.
    ...(pattern === "testsrc2" ? [] : ["-threads", "1"]),
    "-pix_fmt",
    "yuv420p",
    ...(gopFrames === undefined
      ? []
      : [
          "-g",
          String(gopFrames),
          "-keyint_min",
          String(gopFrames),
          "-sc_threshold",
          "0",
        ]),
    ...(pattern === "testsrc2" ? ["-crf", "30"] : []),
  ];
  const hevc = [
    "-c:v",
    "libx265",
    "-preset",
    "ultrafast",
    "-x265-params",
    [
      "log-level=error",
      ...(gopFrames === undefined
        ? []
        : [`keyint=${gopFrames}`, `min-keyint=${gopFrames}`, "scenecut=0"]),
      // libx265 writes colour tags only from its own parameters.
      ...(hdr === undefined
        ? []
        : [
            "colorprim=bt2020",
            `transfer=${hdr === "hlg" ? "arib-std-b67" : "smpte2084"}`,
            "colormatrix=bt2020nc",
          ]),
    ].join(":"),
    "-pix_fmt",
    hdr === undefined ? "yuv420p" : "yuv420p10le",
    "-tag:v",
    "hvc1",
  ];
  const subtitleFiles = subtitles.map((format, index) => ({
    format,
    path: `${path}.${index}.${subtitleFormats[format].file}`,
  }));
  const metadataPath = `${path}.ffmetadata`;
  for (const { format, path: subtitlePath } of subtitleFiles) {
    await writeFile(
      subtitlePath,
      subtitleFormats[format].file === "sup"
        ? pgsFixture(width, height, subtitleTime, pgsForced)
        : format === "ass"
          ? assFixture(subtitleTime)
          : `1\n${clock(subtitleTime.start, 3, 2)} --> ${clock(subtitleTime.end, 3, 2)}\nFixture\n`,
    );
  }
  const chapterList =
    chapters === true
      ? [{ title: "Opening", startSeconds: 0, endSeconds: 1 }]
      : chapters || [];
  await writeFile(
    metadataPath,
    [
      ";FFMETADATA1",
      ...chapterList.map(
        (chapter) =>
          `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${Math.round(chapter.startSeconds * 1000)}\nEND=${Math.round(chapter.endSeconds * 1000)}\ntitle=${chapter.title}`,
      ),
      "",
    ].join("\n"),
  );
  // Inputs: video, silence, the optional tone, the subtitles, the metadata.
  const firstSubtitle = toneAudio ? 3 : 2;
  const metadataInput = firstSubtitle + subtitleFiles.length;
  const tone = toneAudio
    ? {
        input: [
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:sample_rate=48000,aformat=channel_layouts=stereo",
        ],
        map: ["-map", "2:a:0"],
        encode: [
          "-c:a:1",
          "aac",
          "-metadata:s:a:1",
          "language=jpn",
          "-disposition:a:1",
          "0",
        ],
      }
    : { input: [], map: [], encode: [] };
  try {
    const proc = Bun.spawn(
      [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        source,
        "-f",
        "lavfi",
        "-i",
        toneFrom === undefined
          ? `anullsrc=r=48000:cl=${layout}`
          : `aevalsrc=exprs='if(gte(t,${toneFrom}),0.5*sin(2*PI*440*t),0)':s=48000:c=${layout}`,
        ...tone.input,
        ...subtitleFiles.flatMap(({ format, path: subtitlePath }) => [
          "-f",
          subtitleFormats[format].file,
          "-i",
          subtitlePath,
        ]),
        "-f",
        "ffmetadata",
        "-i",
        metadataPath,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        ...tone.map,
        ...subtitleFiles.flatMap((_, index) => [
          "-map",
          `${index + firstSubtitle}:s:0`,
        ]),
        "-map_metadata",
        String(metadataInput),
        "-map_chapters",
        String(metadataInput),
        "-t",
        String(durationSeconds),
        ...(videoCodec === "hevc" ? hevc : h264),
        "-c:a",
        audioCodec === "dts" ? "dca" : audioCodec,
        // ffmpeg's TrueHD and DTS encoders are still marked experimental.
        ...(audioCodec === "truehd" || audioCodec === "dts"
          ? ["-strict", "experimental"]
          : []),
        ...tone.encode,
        ...subtitleFiles.flatMap(({ format }, index) => [
          `-c:s:${index}`,
          subtitleFormats[format].codec,
          `-metadata:s:s:${index}`,
          `language=${index === 0 ? "nld" : "eng"}`,
        ]),
        "-metadata:s:a:0",
        "language=eng",
        "-disposition:a:0",
        "default",
        ...(subtitleFiles.length > 0 ? ["-disposition:s:0", "forced"] : []),
        path,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const [stderr, , exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`ffmpeg failed (${exitCode}): ${stderr.trim()}`);
    }
  } finally {
    for (const { path: subtitlePath } of subtitleFiles) {
      await rm(subtitlePath, { force: true });
    }
    await rm(metadataPath, { force: true });
  }
}

/** Run `run` inside a fresh temporary directory and always remove it. */
export async function withVideoFixture<T>(
  run: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "thalia-video-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

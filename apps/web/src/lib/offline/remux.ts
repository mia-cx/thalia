import {
  ALL_FORMATS,
  type AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  canEncodeAudio,
  EncodedAudioPacketSource,
  type EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  type InputAudioTrack,
  type InputVideoTrack,
  Mp4OutputFormat,
  NullTarget,
  Output,
  QUALITY_HIGH,
} from "mediabunny";
import { browserDecodes, type Conversion, pickConversion } from "./playable.ts";

/** Runs of one video and audio choice: their MSE MIME, and a run from any second. */
export type Prepared = {
  mime: string;
  /**
   * Remuxes from the last keyframe at or before `start` to the end, keeping
   * the source's timestamps. The stream makes one fragment per pull, so
   * nothing is read ahead of the reader; cancelling it stops the remux.
   */
  run(start: number): ReadableStream<Uint8Array>;
};

/** A downloaded File opened for remuxing to fragmented MP4. */
export type Remux = {
  durationSeconds: number;
  /**
   * Readies runs with the audio track at `audio` among the File's audio
   * tracks, or none for null. `convert` decodes it in software and encodes
   * AAC or Opus while playing, for audio the browser can't play.
   */
  prepare(audio: number | null, convert: boolean): Promise<Prepared>;
  /** Releases the File. */
  dispose(): void;
};

/**
 * One track into the output: `peek` reads the next timestamp without
 * consuming it, `write` adds that packet or sample.
 */
type Feed = {
  peek(): Promise<number | null>;
  write(): Promise<void>;
  stop(): Promise<void>;
};

/** Feeds what `open` yields once it opens, as `add` takes it; `add` is told which is first. */
function feed<T extends { timestamp: number }>(
  open: () => Promise<AsyncGenerator<T, void> | null>,
  add: (item: T, first: boolean) => Promise<void>,
): Feed {
  let items: AsyncGenerator<T, void> | null | undefined;
  let next: IteratorResult<T, void> | undefined;
  let started = false;
  return {
    async peek() {
      items ??= await open();
      if (items === null) return null;
      next ??= await items.next();
      return next.done ? null : next.value.timestamp;
    },
    async write() {
      if (next === undefined || next.done) return;
      const item = next.value;
      next = undefined;
      await add(item, !started);
      started = true;
    },
    async stop() {
      await items?.return();
    },
  };
}

/**
 * Readies software decoding of `track` and picks what to encode it as.
 * Without a native AAC encoder, Mediabunny's WebAssembly one stands in.
 */
async function prepareConversion(track: InputAudioTrack): Promise<Conversion> {
  if (!(await track.canDecode())) {
    const codec = await track.getCodec();
    if (codec === "ac3" || codec === "eac3")
      (await import("@mediabunny/ac3")).registerAc3Decoder();
    else if (codec === "dts")
      (await import("@mediabunny/dts")).registerDtsDecoder();
    if (!(await track.canDecode()))
      throw new Error("This browser can't decode the audio.");
  }
  if (!(await canEncodeAudio("aac")))
    (await import("@mediabunny/aac-encoder")).registerAacEncoder();
  const conversion = await pickConversion(
    {
      numberOfChannels: await track.getNumberOfChannels(),
      sampleRate: await track.getSampleRate(),
    },
    browserDecodes,
    canEncodeAudio,
  );
  if (conversion === null)
    throw new Error("This browser can't encode audio to play.");
  return conversion;
}

/** Opens `file` with its own index (Matroska cues, MP4 sample tables) for remuxing. */
export async function openRemux(file: Blob): Promise<Remux> {
  const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  });
  try {
    const video = await input.getPrimaryVideoTrack();
    if (video === null) throw new Error("The download has no video track.");
    const audioTracks = await input.getAudioTracks();
    const durationSeconds = await input.computeDuration();
    return {
      durationSeconds,
      async prepare(position, convert) {
        const audio = position === null ? null : audioTracks[position];
        if (audio === undefined) throw new Error("No such audio track.");
        const conversion =
          audio !== null && convert ? await prepareConversion(audio) : null;
        const codecs = [
          await video.getCodecParameterString(),
          audio === null
            ? null
            : (conversion?.type ?? (await audio.getCodecParameterString())),
        ].filter((codec) => codec !== null);
        return {
          mime: `video/mp4; codecs="${codecs.join(",")}"`,
          run: (start) => remuxRun(video, audio, conversion, start),
        };
      },
      dispose: () => input.dispose(),
    };
  } catch (error) {
    input.dispose();
    throw error;
  }
}

function remuxRun(
  video: InputVideoTrack,
  audio: InputAudioTrack | null,
  conversion: Conversion | null,
  start: number,
): ReadableStream<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const keep = (data: Uint8Array) => {
    chunks.push(data);
  };
  const output = new Output({
    format: new Mp4OutputFormat({
      fastStart: "fragmented",
      onFtyp: keep,
      onMoov: keep,
      onMoof: keep,
      onMdat: keep,
    }),
    target: new NullTarget(),
  });
  const feeds: Feed[] = [];
  let finished = false;

  async function setup() {
    const videoCodec = await video.getCodec();
    if (videoCodec === null) throw new Error("Unknown video codec.");
    const videoSource = new EncodedVideoPacketSource(videoCodec);
    output.addVideoTrack(videoSource);
    const videoSink = new EncodedPacketSink(video);
    const key = videoSink
      .getKeyPacket(start, { verifyKeyPackets: true })
      .then(
        (packet) =>
          packet ?? videoSink.getFirstKeyPacket({ verifyKeyPackets: true }),
      );
    feeds.push(
      feed(
        async () => {
          const from = await key;
          return from === null ? null : videoSink.packets(from);
        },
        async (packet: EncodedPacket, first) =>
          videoSource.add(
            packet,
            first
              ? { decoderConfig: (await video.getDecoderConfig()) ?? undefined }
              : undefined,
          ),
      ),
    );
    if (audio !== null && conversion !== null) {
      const audioSource = new AudioSampleSource({
        codec: conversion.codec,
        bitrate: QUALITY_HIGH,
        transform: {
          numberOfChannels: conversion.numberOfChannels,
          sampleRate: conversion.sampleRate,
        },
      });
      output.addAudioTrack(audioSource);
      const sink = new AudioSampleSink(audio);
      // Audio starts at the keyframe, so the two stay in sync.
      feeds.push(
        feed(
          async () => {
            const from = await key;
            return from === null ? null : sink.samples(from.timestamp);
          },
          async (sample: AudioSample) => {
            try {
              await audioSource.add(sample);
            } finally {
              sample.close();
            }
          },
        ),
      );
    } else if (audio !== null) {
      const audioCodec = await audio.getCodec();
      if (audioCodec === null) throw new Error("Unknown audio codec.");
      const audioSource = new EncodedAudioPacketSource(audioCodec);
      output.addAudioTrack(audioSource);
      const sink = new EncodedPacketSink(audio);
      feeds.push(
        feed(
          async () => {
            const from = await key;
            if (from === null) return null;
            const first =
              (await sink.getPacket(from.timestamp)) ??
              (await sink.getFirstPacket());
            return first === null ? null : sink.packets(first);
          },
          async (packet: EncodedPacket, first) =>
            audioSource.add(
              packet,
              first
                ? {
                    decoderConfig:
                      (await audio.getDecoderConfig()) ?? undefined,
                  }
                : undefined,
            ),
        ),
      );
    }
    await output.start();
  }

  /** Writes the earliest pending packet or sample, or finalizes once every feed ran dry. */
  async function step() {
    const times = await Promise.all(feeds.map((entry) => entry.peek()));
    let earliest: number | undefined;
    for (const [index, time] of times.entries()) {
      if (time === null) continue;
      const best = earliest === undefined ? null : times[earliest];
      if (best === null || best === undefined || time < best) earliest = index;
    }
    if (earliest === undefined) {
      await output.finalize();
      finished = true;
      return;
    }
    await feeds[earliest]?.write();
  }

  return new ReadableStream<Uint8Array>(
    {
      start: setup,
      async pull(controller) {
        while (chunks.length === 0 && !finished) await step();
        const chunk = chunks.shift();
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
      async cancel() {
        await Promise.all(feeds.map((entry) => entry.stop()));
        if (!finished) await output.cancel();
      },
    },
    { highWaterMark: 0 },
  );
}

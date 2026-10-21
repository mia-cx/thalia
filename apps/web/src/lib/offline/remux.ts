import {
  ALL_FORMATS,
  BlobSource,
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
} from "mediabunny";

/** A downloaded File opened for remuxing to fragmented MP4. */
export type Remux = {
  durationSeconds: number;
  /** The MSE MIME of a run playing the audio track at `audio` among the File's audio tracks. */
  mime(audio: number | null): Promise<string>;
  /**
   * Remuxes from the last keyframe at or before `start` to the end, keeping
   * the source's timestamps. The stream makes one fragment per pull, so
   * nothing is read ahead of the reader; cancelling it stops the remux.
   */
  run(start: number, audio: number | null): ReadableStream<Uint8Array>;
  /** Releases the File. */
  dispose(): void;
};

/**
 * One track's packets into the output: `peek` reads the next timestamp
 * without consuming it, `write` adds that packet.
 */
type Feed = {
  peek(): Promise<number | null>;
  write(): Promise<void>;
  stop(): Promise<void>;
};

/** Feeds `sink`'s packets from `first` on; `add` is told which packet is the first. */
function packetFeed(
  sink: EncodedPacketSink,
  first: Promise<EncodedPacket | null>,
  add: (packet: EncodedPacket, first: boolean) => Promise<void>,
): Feed {
  let packets: AsyncGenerator<EncodedPacket, void> | undefined;
  let next: IteratorResult<EncodedPacket, void> | undefined;
  let started = false;
  return {
    async peek() {
      if (packets === undefined) {
        const from = await first;
        if (from === null) return null;
        packets = sink.packets(from);
      }
      next ??= await packets.next();
      return next.done ? null : next.value.timestamp;
    },
    async write() {
      if (next === undefined || next.done) return;
      const packet = next.value;
      next = undefined;
      await add(packet, !started);
      started = true;
    },
    async stop() {
      await packets?.return();
    },
  };
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
    const audioAt = (audio: number | null) => {
      if (audio === null) return null;
      const track = audioTracks[audio];
      if (track === undefined) throw new Error("No such audio track.");
      return track;
    };
    return {
      durationSeconds,
      async mime(audio) {
        const track = audioAt(audio);
        const codecs = [
          await video.getCodecParameterString(),
          track === null ? null : await track.getCodecParameterString(),
        ].filter((codec) => codec !== null);
        return `video/mp4; codecs="${codecs.join(",")}"`;
      },
      run: (start, audio) => remuxRun(video, audioAt(audio), start),
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
      packetFeed(videoSink, key, async (packet, first) =>
        videoSource.add(
          packet,
          first
            ? { decoderConfig: (await video.getDecoderConfig()) ?? undefined }
            : undefined,
        ),
      ),
    );
    if (audio !== null) {
      const audioCodec = await audio.getCodec();
      if (audioCodec === null) throw new Error("Unknown audio codec.");
      const audioSource = new EncodedAudioPacketSource(audioCodec);
      output.addAudioTrack(audioSource);
      const audioSink = new EncodedPacketSink(audio);
      // Audio starts at the keyframe, so the two stay in sync.
      const from = key.then(async (packet) =>
        packet === null
          ? null
          : ((await audioSink.getPacket(packet.timestamp)) ??
            (await audioSink.getFirstPacket())),
      );
      feeds.push(
        packetFeed(audioSink, from, async (packet, first) =>
          audioSource.add(
            packet,
            first
              ? { decoderConfig: (await audio.getDecoderConfig()) ?? undefined }
              : undefined,
          ),
        ),
      );
    }
    await output.start();
  }

  /** Writes the earliest pending packet, or finalizes once every feed ran dry. */
  async function step() {
    const times = await Promise.all(feeds.map((feed) => feed.peek()));
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
        await Promise.all(feeds.map((feed) => feed.stop()));
        if (!finished) await output.cancel();
      },
    },
    { highWaterMark: 0 },
  );
}

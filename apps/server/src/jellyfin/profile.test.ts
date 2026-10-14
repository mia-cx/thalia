import { describe, expect, test } from "bun:test";
import { AuthError } from "../auth/errors.ts";
import { decidePlayback } from "../playback/decisions.ts";
import type { Hdr } from "../playback/policy.ts";
import { readDeviceProfile } from "./profile.ts";
import { deviceProfiles } from "./profile-fixtures.ts";

const everyFlavour: Hdr[] = ["sdr", "hdr10", "hdr10+", "hlg", "dolby-vision"];

describe("DeviceProfile translation", () => {
  test("a direct-play client keeps its containers, TrueHD and embedded subtitles", () => {
    const profile = readDeviceProfile(deviceProfiles.infuse);
    expect(profile.containers).toEqual(["mkv", "mp4", "mov"]);
    expect(profile.videoCodecs.map((entry) => entry.codec)).toEqual([
      "h264",
      "hevc",
      "av1",
      "vp9",
      "mpeg2video",
    ]);
    expect(profile.audioCodecs).toContainEqual({
      codec: "truehd",
      maxChannels: 8,
    });
    expect(profile.audioCodecs.map((entry) => entry.codec)).toContain("dts-hd");
    expect(profile.subtitleFormats).toEqual(["srt", "ass", "pgs"]);
    expect(profile.hdr).toEqual(everyFlavour);
    expect(profile.maxBitrate).toBe(120_000_000);
  });

  test("an HLS-only client opens no files and decodes its transcoding codecs", () => {
    const profile = readDeviceProfile(deviceProfiles.swiftfin);
    expect(profile.containers).toEqual([]);
    expect(profile.hlsCodecs).toBeUndefined();
    expect(profile.videoCodecs).toEqual([
      {
        codec: "h264",
        profiles: ["high", "main", "baseline", "constrainedbaseline"],
        maxLevel: 52,
        maxWidth: undefined,
        maxHeight: undefined,
      },
      {
        codec: "hevc",
        maxLevel: undefined,
        maxWidth: undefined,
        maxHeight: undefined,
      },
    ]);
    expect(profile.audioCodecs.map((entry) => entry.codec)).toEqual([
      "aac",
      "ac3",
      "eac3",
    ]);
    // Only Embed counts: HLS subtitles convert to WebVTT whatever the client says.
    expect(profile.subtitleFormats).toEqual([]);
    expect(profile.hdr).toEqual(["sdr", "hdr10", "hlg"]);
  });

  test("an http TranscodingProfile marks the profile progressive and counts its codecs", () => {
    const profile = readDeviceProfile(deviceProfiles.progressive);
    expect(profile.progressive).toBe(true);
    expect(profile.hls).toBe(false);
    expect(profile.hlsCodecs).toBeUndefined();
    expect(profile.videoCodecs.map((entry) => entry.codec)).toEqual(["h264"]);
    expect(profile.audioCodecs.map((entry) => entry.codec)).toEqual(["aac"]);
    // HLS-only and direct-play fixtures stay on HLS delivery.
    for (const name of ["infuse", "findroid"] as const) {
      const other = readDeviceProfile(deviceProfiles[name]);
      expect(other.progressive).toBe(false);
      expect(other.hls).toBe(false);
    }
    const swiftfin = readDeviceProfile(deviceProfiles.swiftfin);
    expect(swiftfin.progressive).toBe(false);
    expect(swiftfin.hls).toBe(true);
  });

  test("a progressive client's codecs come from its http profile, not the HLS one", () => {
    const mixed = readDeviceProfile({
      DirectPlayProfiles: [],
      TranscodingProfiles: [
        {
          Type: "Video",
          Protocol: "hls",
          Container: "mp4",
          VideoCodec: "h264,hevc",
          AudioCodec: "aac,ac3",
        },
        {
          Type: "Video",
          Protocol: "http",
          Container: "mp4",
          VideoCodec: "h264",
          AudioCodec: "aac",
        },
      ],
      CodecProfiles: [
        {
          Type: "Video",
          Codec: "h264,hevc",
          Conditions: [
            { Condition: "LessThanEqual", Property: "Height", Value: "1080" },
          ],
        },
        {
          Type: "Audio",
          Codec: "aac,ac3",
          Conditions: [
            {
              Condition: "LessThanEqual",
              Property: "AudioChannels",
              Value: "2",
            },
          ],
        },
      ],
    });
    expect(mixed.progressive).toBe(true);
    expect(mixed.hls).toBe(true);
    expect(mixed.videoCodecs.map((entry) => entry.codec)).toEqual(["h264"]);
    expect(mixed.hlsCodecs?.videoCodecs.map((entry) => entry.codec)).toEqual([
      "h264",
      "hevc",
    ]);
    expect(mixed.videoCodecs[0]?.maxHeight).toBe(1080);
    expect(
      mixed.hlsCodecs?.videoCodecs.map((entry) => entry.maxHeight),
    ).toEqual([1080, 1080]);
    expect(mixed.audioCodecs).toEqual([{ codec: "aac", maxChannels: 2 }]);
    expect(mixed.hlsCodecs?.audioCodecs).toEqual([
      { codec: "aac", maxChannels: 2 },
      { codec: "ac3", maxChannels: 2 },
    ]);
    // An http profile that outputs no mp4 never turns progressive on.
    const mkvOnly = readDeviceProfile({
      DirectPlayProfiles: [],
      TranscodingProfiles: [
        {
          Type: "Video",
          Protocol: "hls",
          Container: "mp4",
          VideoCodec: "h264",
          AudioCodec: "aac",
        },
        {
          Type: "Video",
          Protocol: "http",
          Container: "mkv",
          VideoCodec: "h264",
          AudioCodec: "aac",
        },
      ],
    });
    expect(mkvOnly.progressive).toBe(false);
    expect(mkvOnly.hls).toBe(true);
  });

  test("Findroid's empty profile accepts nothing, so no path plays", () => {
    const profile = readDeviceProfile(deviceProfiles.findroid);
    expect(profile).toMatchObject({
      containers: [],
      videoCodecs: [],
      audioCodecs: [],
      subtitleFormats: [],
      maxBitrate: 1_000_000_000,
    });
    expect(() =>
      decidePlayback(
        {
          container: "mkv",
          video: {
            codec: "h264",
            profile: "high",
            level: 40,
            width: 1920,
            height: 1080,
            bitrate: 8_000_000,
            hdr: "sdr",
          },
          audio: [{ codec: "aac", channels: 2 }],
          subtitles: [],
        },
        profile,
        { isLan: true },
      ),
    ).toThrow();
  });

  test("unknown names count as unsupported, and keys match in any case", () => {
    const profile = readDeviceProfile(
      {
        directPlayProfiles: [
          {
            type: "Video",
            container: "mkv,flv",
            videoCodec: "h264,realvideo",
            audioCodec: "AAC,wma",
          },
        ],
        subtitleProfiles: [{ format: "PGSSUB", method: "embed" }],
      },
      8_000_000,
    );
    expect(profile).toMatchObject({
      containers: ["mkv"],
      videoCodecs: [{ codec: "h264" }],
      audioCodecs: [{ codec: "aac", maxChannels: 8 }],
      subtitleFormats: ["pgs"],
      maxBitrate: 8_000_000,
    });
  });

  test("audio channel caps and conditional profiles", () => {
    const profile = readDeviceProfile({
      DirectPlayProfiles: [
        { Container: "mp4", VideoCodec: "h264", AudioCodec: "aac,eac3" },
      ],
      CodecProfiles: [
        {
          Type: "VideoAudio",
          Codec: "aac",
          Conditions: [
            {
              Condition: "LessThanEqual",
              Property: "AudioChannels",
              Value: "2",
            },
          ],
        },
        // Applies only when its own conditions hold, so it narrows nothing.
        {
          Type: "Video",
          Codec: "h264",
          Conditions: [
            { Condition: "LessThanEqual", Property: "Width", Value: "1280" },
          ],
          ApplyConditions: [
            { Condition: "Equals", Property: "IsAnamorphic", Value: "true" },
          ],
        },
      ],
    });
    expect(profile.audioCodecs).toEqual([
      { codec: "aac", maxChannels: 2 },
      { codec: "eac3", maxChannels: 8 },
    ]);
    expect(profile.videoCodecs[0]?.maxWidth).toBeUndefined();
  });

  test("empty direct-play fields mean any, as Swiftfin's direct play mode sends them", () => {
    const source = {
      container: "mkv",
      video: {
        codec: "h264",
        profile: "high",
        level: 40,
        width: 1920,
        height: 1080,
        bitrate: 8_000_000,
        hdr: "sdr" as const,
      },
      audio: [{ codec: "aac", channels: 2 }],
      subtitles: [],
    };
    // Swiftfin's forced direct play profile is the type alone.
    const forced = readDeviceProfile({
      DirectPlayProfiles: [{ Type: "Video" }],
    });
    expect(forced.containers).toContain("mkv");
    expect(decidePlayback(source, forced, { isLan: true }).method).toBe(
      "direct-play",
    );
    // Its VLC profile names codecs but no container.
    const vlc = readDeviceProfile({
      DirectPlayProfiles: [
        { Type: "Video", VideoCodec: "h264,hevc", AudioCodec: "aac,truehd" },
      ],
    });
    expect(vlc.containers).toContain("mkv");
    expect(vlc.videoCodecs.map((entry) => entry.codec)).toEqual([
      "h264",
      "hevc",
    ]);
    expect(decidePlayback(source, vlc, { isLan: true }).method).toBe(
      "direct-play",
    );
    // An HLS profile's container is its output, never a file the client opens.
    expect(readDeviceProfile(deviceProfiles.swiftfin).containers).toEqual([]);
  });

  test("a malformed profile is invalid input", () => {
    expect(() => readDeviceProfile({ DirectPlayProfiles: "mkv" })).toThrow(
      AuthError,
    );
  });
});

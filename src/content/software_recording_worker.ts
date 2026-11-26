import { AudioSample, AudioSampleSource, EncodedPacket, EncodedVideoPacketSource, MkvOutputFormat, Mp4OutputFormat, NullTarget, Output, Quality } from "mediabunny";

type SourceTracks = { video: ReadableStream<VideoFrame>; audio?: ReadableStream<AudioData> };
type WorkerCommand = { type: "prepare"; width: number; height: number; format: "webm" | "mp4"; bitrate: number; hasAudio: boolean }
  | { type: "start"; tracks: SourceTracks }
  | { type: "stop" };

let videoEncoder: VideoEncoder;
let recording: Output;
let audioSource: AudioSampleSource | undefined;
let videoReader: ReadableStreamDefaultReader<VideoFrame> | undefined;
let audioReader: ReadableStreamDefaultReader<AudioData> | undefined;
let capture = Promise.resolve();
let packets = Promise.resolve();
let descriptor: VideoDecoderConfig | undefined;
let ready = false;
let started = false;
let stopping = false;
let lastKeyFrame = -1_000_000;
let captureStarted = 0;
let mimeType = "";
let fragments: BlobPart[] = [];
const copyBuffers: Uint8Array<ArrayBuffer>[] = [];

function reportError(error: unknown): void {
  postMessage({ type: "error", error: error instanceof Error ? error.message : String(error) });
}

function blobPart(bytes: Uint8Array): BlobPart {
  return bytes.buffer instanceof ArrayBuffer ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes.slice();
}

function checkpoint(bytes: Uint8Array): void {
  postMessage({ type: "chunk", blob: new Blob([...fragments, blobPart(bytes)], { type: mimeType }) });
  fragments = [];
}

async function prepare(command: Extract<WorkerCommand, { type: "prepare" }>): Promise<void> {
  const { format, width, height, bitrate, hasAudio } = command;
  const videoSource = new EncodedVideoPacketSource("avc");
  let audioCodec: "aac" | "opus" = "opus";
  if (format === "mp4" && hasAudio) {
    const support = await AudioEncoder.isConfigSupported({ codec: "mp4a.40.2", sampleRate: 48_000, numberOfChannels: 2, bitrate: 128_000 });
    if (support.supported) audioCodec = "aac";
  }
  mimeType = format === "mp4" ? "video/mp4" : "video/x-matroska";
  const appendHeader = (data: Uint8Array) => { fragments.push(blobPart(data)); };
  recording = new Output({
    target: new NullTarget(),
    format: format === "mp4" ? new Mp4OutputFormat({
      fastStart: "fragmented", minimumFragmentDuration: 1, onFtyp: appendHeader, onMoov: appendHeader, onMoof: appendHeader, onMdat: checkpoint,
    }) : new MkvOutputFormat({
      appendOnly: true, minimumClusterDuration: 1, onEbmlHeader: appendHeader, onSegmentHeader: appendHeader, onCluster: checkpoint,
    }),
  });
  recording.addVideoTrack(videoSource);
  if (hasAudio) {
    audioSource = new AudioSampleSource({ codec: audioCodec, quality: new Quality({ bitrate: 128_000 }) });
    recording.addAudioTrack(audioSource);
  }
  const config: VideoEncoderConfig = { codec: "avc1.420028", width, height, bitrate, framerate: 30,
    hardwareAcceleration: "prefer-software", latencyMode: "realtime", avc: { format: "avc" } };
  if (!(await VideoEncoder.isConfigSupported(config)).supported) throw new Error("이 환경에서는 소프트웨어 H.264 녹화를 지원하지 않습니다.");
  videoEncoder = new VideoEncoder({ output(chunk, metadata) {
    descriptor = metadata?.decoderConfig ?? descriptor;
    if (!ready) return;
    if (!started) {
      started = true;
      postMessage({ type: "started", mimeType });
    }
    const packet = EncodedPacket.fromEncodedChunk(chunk);
    const decoderConfig = descriptor;
    packets = packets.then(() => videoSource.add(packet, { decoderConfig }));
    void packets.catch(reportError);
  }, error: reportError });
  videoEncoder.configure(config);
  const blank = new Uint8Array(width * height * 3 / 2);
  blank.fill(128, width * height);
  const frame = new VideoFrame(blank, { format: "NV12", codedWidth: width, codedHeight: height, timestamp: 0, duration: 33_333 });
  try {
    videoEncoder.encode(frame, { keyFrame: true });
  } finally {
    frame.close();
  }
  await videoEncoder.flush();
  await recording.start();
  ready = true;
  postMessage({ type: "ready" });
}

function captureOffset(timestamp: number): number {
  return Math.round((performance.now() - captureStarted) * 1000) - timestamp;
}

async function encodeVideo(): Promise<void> {
  if (!videoReader) return;
  let offset: number | undefined;
  let writing = Promise.resolve();
  const pending: Promise<void>[] = [];
  while (!stopping) {
    const { value: frame, done } = await videoReader.read();
    if (done) break;
    if (stopping) { frame.close(); break; }
    offset ??= captureOffset(frame.timestamp);
    const format = frame.format ?? "RGBA";
    const options = frame.format ? {} : { format };
    const size = frame.allocationSize(options);
    const spare = copyBuffers.pop();
    const bytes = spare?.byteLength === size ? spare : new Uint8Array(size);
    const rect = frame.visibleRect;
    if (!rect) { frame.close(); throw new Error("녹화 프레임의 크기를 읽지 못했습니다."); }
    const timestamp = frame.timestamp + offset;
    const duration = frame.duration ?? 33_333;
    const colorSpace = frame.colorSpace.toJSON();
    const copied = frame.copyTo(bytes, options).then(layout => ({ format, layout, timestamp,
      codedWidth: rect.width, codedHeight: rect.height, duration, colorSpace,
    })).finally(() => frame.close());
    void copied.catch(() => {});
    writing = writing.then(async () => {
      const init = await copied;
      while (videoEncoder.encodeQueueSize >= 4) {
        await new Promise<void>(resolve => videoEncoder.addEventListener("dequeue", () => resolve(), { once: true }));
      }
      const frame = new VideoFrame(bytes, init);
      copyBuffers.push(bytes);
      try {
        const keyFrame = timestamp - lastKeyFrame >= 1_000_000;
        if (keyFrame) lastKeyFrame = timestamp;
        videoEncoder.encode(frame, { keyFrame });
      } finally {
        frame.close();
      }
    });
    void writing.catch(reportError);
    pending.push(writing);
    if (pending.length >= 3) await pending.shift();
  }
  await writing;
}

async function encodeAudio(): Promise<void> {
  if (!audioReader || !audioSource) return;
  let offset: number | undefined;
  while (!stopping) {
    const { value: data, done } = await audioReader.read();
    if (done) break;
    const sample = new AudioSample(data);
    try {
      if (stopping) break;
      offset ??= captureOffset(data.timestamp);
      sample.setTimestamp((data.timestamp + offset) / 1_000_000);
      await audioSource.add(sample);
    } finally {
      sample.close();
    }
  }
}

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await Promise.all([videoReader?.cancel(), audioReader?.cancel()]);
  await capture;
  await videoEncoder.flush();
  videoEncoder.close();
  await packets;
  if (started) await recording.finalize();
  else await recording.cancel();
  postMessage({ type: "stopped" });
}

addEventListener("message", (event: MessageEvent<WorkerCommand>) => {
  const command = event.data;
  if (command.type === "prepare") void prepare(command).catch(reportError);
  else if (command.type === "stop") void stop().catch(reportError);
  else {
    captureStarted = performance.now();
    videoReader = command.tracks.video.getReader();
    audioReader = command.tracks.audio?.getReader();
    capture = Promise.all([encodeVideo(), encodeAudio()]).then(() => {});
    void capture.catch(reportError);
  }
});
